// Lockstep: ritardo input adattivo, ping/RTT per giocatore, rilevamento stalli, carico CPU.
// Caricato PRIMA di app.js: le variabili di stato qui sotto sono condivise (scope globale degli script classici).
// Usa a runtime variabili/funzioni di app.js (GBA_FRAME_MS, myPlayerId, connectedGuests, roomSpeed, setSpeed...).
// -------------------------------------------------------------
// Netplay: input delay ADATTIVO + misura RTT/jitter
// -------------------------------------------------------------
// Prima l'input delay era fisso a 2 frame (~33 ms): bastava un ritardo di rete + jitter oltre
// quella soglia (Wi-Fi, picchi di CPU del compagno, salvataggi) per bloccare il lockstep e far
// comparire "Sincronizzazione Rete...". Ora ogni lato sceglie il proprio delay in base a RTT e
// jitter misurati. Il delay e' una scelta del MITTENTE: il ricevente cerca solo il frame che gli
// serve, quindi i due lati possono avere delay diversi senza negoziare nulla.
// I limiti sono in MILLISECONDI REALI e si convertono in frame in base alla velocita': a 2x un frame dura 8,4 ms, quindi lo stesso
// ritardo di rete richiede il DOPPIO dei frame. Prima si usava sempre GBA_FRAME_MS: a 2x il delay risultava meta' di quello necessario
// (e bloccato a 10 frame = 84 ms): centinaia di stalli al minuto anche con ping basso.
const NET_DELAY_MIN_MS = 33;
const NET_DELAY_MAX_MS = 167;
const NET_DELAY_INITIAL = 4;          // FRAME, uguale su tutti i client (protocollo): i frame 0..3 sono sempre "tasti a 0"
const netSpeed = () => (roomSpeed === 2 ? 2 : 1);
const netFrameMs = () => GBA_FRAME_MS / netSpeed();                        // durata reale di un passo di emulazione
const netDelayMin = () => Math.max(2, Math.ceil(NET_DELAY_MIN_MS / netFrameMs()));
const netDelayMax = () => Math.ceil(NET_DELAY_MAX_MS / netFrameMs());      // 10 a 1x, 20 a 2x
// Profilo "lag": quanto margine si tiene sopra il ritardo di rete misurato. Scelta del SINGOLO giocatore (il delay e' del mittente):
// il lag che senti sul tuo personaggio e' il TUO delay. F4 per cambiare profilo.
const NET_LAG_MODES = {
  low:      { label: "minimo",     marginMs: 4,  k1: 1.0, k2: 1.5 },   // rete ottima: piu' reattivo, piu' rischio di micro-stalli
  balanced: { label: "bilanciato", marginMs: 12, k1: 1.5, k2: 2.0 },
  safe:     { label: "sicuro",     marginMs: 20, k1: 3.0, k2: 3.0 },
};
let netLagMode = "balanced";
const NET_PING_EVERY_MS = 500;
const NET_OVERLAY_AFTER_MS = 1200;    // l'overlay compare solo per stalli davvero visibili
const NET_EMERGENCY_AFTER_MS = 3000;
const NET_LOST_AFTER_MS = 10000;
const NET_PING_MAGIC = 0x52425047;    // 'RBPG'
let netInputDelay = NET_DELAY_INITIAL;
let netLastScheduled = NET_DELAY_INITIAL - 1;
let netRttMs = 0, netRttDev = 0, netRttSamples = 0, netRttMin = 0;
let netPingTimer = null;
let netPeerRtt = new Map();           // solo host: RTT/jitter di OGNI guest (prima: un'unica media mescolata)
let netHostDelay = 0;                 // solo guest: delay minimo raccomandato dall'host (copre guest->host->guest)
let netFastBroken = false, netOverlayHideTimer = null, netCpuHot = 0, netCpuLoad = 0;
const netPeerSeen = {};              // pid -> ultimo istante in cui e' arrivato un suo pacchetto (vivo != lento)
let netHoldStart = false, netHostLoaded = false, netGoSent = false, netGoTimer = null;
let netEmuMs = 0;                     // costo medio (ms) di un passo di emulazione: distingue CPU da rete
let netLastDelayChange = 0;
let netStalling = false, netStallStart = 0, netOverlayLevel = 0;
let netStallTimes = [];               // istanti degli ultimi stalli (per alzare il delay se si ripetono)
let netStallCount = 0, netStallMsTotal = 0, netStallMsMax = 0;

function netResetAdaptiveState() {
  netInputDelay = NET_DELAY_INITIAL;
  netLastScheduled = NET_DELAY_INITIAL - 1;
  netRttMs = 0; netRttDev = 0; netRttSamples = 0; netRttMin = 0;
  netPeerRtt.clear(); netHostDelay = 0; netEmuMs = 0;
  if (netOverlayHideTimer) { clearTimeout(netOverlayHideTimer); netOverlayHideTimer = null; }
  netFastBroken = false; netCpuHot = 0; for (const k in netPeerSeen) delete netPeerSeen[k];
  netLastDelayChange = performance.now();
  netStalling = false; netStallStart = 0; netOverlayLevel = 0;
  netStallTimes = [];
  netStallCount = 0; netStallMsTotal = 0; netStallMsMax = 0;
  netUpdateBadge();
}

function netSetDelay(d, why) {
  d = Math.max(netDelayMin(), Math.min(netDelayMax(), d | 0));
  if (d === netInputDelay) return;
  console.log(`[Net] input delay ${netInputDelay} -> ${d} frame (${why}, rtt=${netRttMs.toFixed(0)}ms dev=${netRttDev.toFixed(0)}ms)`);
  netInputDelay = d;
  netLastDelayChange = performance.now();
  netUpdateBadge();
}

// Delay desiderato: meta' RTT + margine di jitter + 1 frame (il ricevente legge una volta per frame).
function netWantedDelay() {
  if (!netRttSamples) return Math.max(NET_DELAY_INITIAL, netHostDelay);
  const m = NET_LAG_MODES[netLagMode];
  let budget;
  if (myPlayerId === 1) {
    // Con 3-4 giocatori il percorso peggiore e' guest->host->guest: somma delle due tratte piu' lente.
    const k = netPeerRtt.size > 1 ? m.k2 : m.k1;
    const legs = [...netPeerRtt.values()].map((x) => x.rtt / 2 + k * x.dev).sort((a, b) => b - a);
    budget = (legs[0] || 0) + (legs[1] || 0) + m.marginMs;
  } else {
    budget = netRttMs / 2 + m.k2 * netRttDev + m.marginMs;
  }
  const f = Math.ceil(budget / netFrameMs());
  return Math.max(netDelayMin(), Math.min(netDelayMax(), myPlayerId === 1 ? f : Math.max(f, netHostDelay)));
}

function netAdaptDelay(now) {
  const wanted = netWantedDelay();
  if (wanted > netInputDelay) {
    netSetDelay(wanted, "rete piu' lenta");
  } else if (wanted < netInputDelay && now - netLastDelayChange > 6000 &&
             !netStallTimes.some((t) => now - t < 6000)) {
    netSetDelay(netInputDelay - 1, "rete stabile");   // si scende piano, un frame alla volta
  }
}

// Cambio velocita' (1x <-> 2x): il ritardo in millisecondi deve restare lo stesso, quindi si riscalano i frame.
function netRescaleDelay(oldSpeed, newSpeed) {
  if (oldSpeed === newSpeed || currentMode !== "netplay" || !netplayConnected) return;
  netInputDelay = Math.max(netDelayMin(), Math.min(netDelayMax(), Math.round(netInputDelay * newSpeed / oldSpeed)));
  netHostDelay = Math.round(netHostDelay * newSpeed / oldSpeed);
  netLastDelayChange = performance.now();
  netUpdateBadge();
}
function netCycleLagMode() {
  const order = Object.keys(NET_LAG_MODES);
  netLagMode = order[(order.indexOf(netLagMode) + 1) % order.length];
  netAdaptDelay(performance.now());
  netUpdateBadge();
  return netLagMode;
}

function netNoteStall(now) {
  netStallTimes.push(now);
  while (netStallTimes.length && now - netStallTimes[0] > 4000) netStallTimes.shift();
  // 3 stalli in 4 s nonostante il delay "calcolato": la rete e' peggio di come appare dal ping.
  if (netStallTimes.length >= 3 && now - netLastDelayChange > 1500) {
    netStallTimes = [];
    netSetDelay(netInputDelay + 1, "stalli ripetuti");
  }
}

function netUpdateBadge() {
  const el = document.getElementById("netBadge");
  if (!el) return;
  if (currentMode !== "netplay" || !netplayConnected) { el.style.display = "none"; return; }
  el.style.display = "";
  const ping = netRttSamples ? `${Math.round(netRttMs)} ms` : "...";
  el.textContent = `Ping ${ping} | Lag ${Math.round(netInputDelay * netFrameMs())} ms (${netInputDelay}f) | CPU ${Math.round(netCpuLoad * 100)}%`;
}

function netPacketIsPing(buf) {
  return buf && buf.byteLength === 16 && new DataView(buf).getUint32(0) === NET_PING_MAGIC;
}

function netSendPing(type, ts) {
  const b = new ArrayBuffer(16);
  const v = new DataView(b);
  v.setUint32(0, NET_PING_MAGIC);
  v.setUint8(4, type);
  v.setFloat64(8, ts);
  if (myPlayerId === 1) {
    v.setUint8(5, netInputDelay);   // i guest non misurano guest<->guest: usano il delay deciso dall'host
    for (const guest of Object.values(connectedGuests)) if (guest) netSend(guest.conn, b);
  } else {
    netSend(activeP2PConn, b);
  }
}

function netHandlePing(buf, replyConn) {
  const v = new DataView(buf);
  const type = v.getUint8(4);
  const ts = v.getFloat64(8);
  if (type === 0) {
    const b = new ArrayBuffer(16);
    const rv = new DataView(b);
    rv.setUint32(0, NET_PING_MAGIC);
    rv.setUint8(4, 1);
    rv.setFloat64(8, ts);
    if (myPlayerId !== 1 && v.getUint8(5) > 0) { netHostDelay = v.getUint8(5); netAdaptDelay(performance.now()); }
    netSend(replyConn || activeP2PConn, b);
  } else {
    const rtt = performance.now() - ts;
    if (!(rtt >= 0 && rtt < 5000)) return;
    if (!netRttSamples) { netRttMs = rtt; netRttDev = rtt / 4; netRttMin = rtt; }
    else {
      netRttDev = netRttDev * 0.75 + Math.abs(rtt - netRttMs) * 0.25;
      netRttMs = netRttMs * 0.875 + rtt * 0.125;
      netRttMin = Math.min(netRttMin, rtt);
    }
    const key = replyConn || "host";
    const ps = netPeerRtt.get(key);
    if (!ps) netPeerRtt.set(key, { rtt, dev: rtt / 4 });
    else { ps.dev = ps.dev * 0.75 + Math.abs(rtt - ps.rtt) * 0.25; ps.rtt = ps.rtt * 0.875 + rtt * 0.125; }
    netRttSamples++;
    netAdaptDelay(performance.now());
    netUpdateBadge();
  }
}

function netCheckCpu() {
  if (currentMode !== "netplay" || !isRunning || !netEmuMs) return;
  const speed = roomSpeed === 2 ? 2 : 1;
  netCpuLoad = netEmuMs / (GBA_FRAME_MS / speed);
  netCpuHot = netCpuLoad > 0.65 ? netCpuHot + 1 : 0;
  if (speed === 2 && netCpuHot >= 4) {   // 2 s di CPU quasi satura a 2x: scendere a 1x per TUTTI (change_speed esiste gia')
    netCpuHot = 0;
    setSpeed(1);
    try {
      if (myPlayerId === 1) broadcastToGuests({ type: "change_speed", speed: 1 });
      else if (activeP2PConn && activeP2PConn.open) activeP2PConn.send({ type: "change_speed", speed: 1 });
    } catch (e) {}
    showInGameNotice("[CPU] Un PC non regge i 2x: velocita' portata a 1x per tutti", 7000);
  }
}
function netStartPings() {
  netStopPings();
  netPingTimer = setInterval(() => {
    if (currentMode === "netplay" && netplayConnected) { netSendPing(0, performance.now()); netCheckCpu(); }
    else { netStopPings(); netUpdateBadge(); }
  }, NET_PING_EVERY_MS);
}
function netStopPings() {
  if (netPingTimer) { clearInterval(netPingTimer); netPingTimer = null; }
}
