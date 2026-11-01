// WebRTC (PeerJS): configurazione ICE e canale dati "veloce" per input/ping.
// Usa variabili di app.js solo a runtime (netFastBroken, myPlayerId, connectedGuests, activeP2PConn).

// STUN pubblici ad alta disponibilita' per reti standard + supporto TURN dinamico per NAT simmetrici e hotspot mobili.
function getEffectiveIceServers() {
  const servers = [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" },
    { urls: "stun:stun2.l.google.com:19302" },
    { urls: "stun:stun.cloudflare.com:3478" },
    { urls: "stun:global.stun.twilio.com:3478" },
  ];

  // 1. Override da window o localStorage
  let customTurn = window.MULTIGBA_TURN_SERVERS || window.REBIT_TURN_SERVERS;
  if (!customTurn) {
    try {
      const stored = localStorage.getItem("multigba_turn_config") || localStorage.getItem("rebit_turn_config");
      if (stored) customTurn = JSON.parse(stored);
    } catch (_) {}
  }

  // 2. Override da parametro URL (?turn=turn:user:pass@host:port o ?turn=urls;user;pass)
  if (!customTurn && typeof location !== "undefined") {
    const m = /[?&]turn=([^&]+)/.exec(location.search);
    if (m) {
      try {
        const val = decodeURIComponent(m[1]);
        if (val.startsWith("turn:") || val.startsWith("turns:")) {
          const atIdx = val.indexOf("@");
          if (atIdx > 0) {
            const protoAndAuth = val.slice(0, atIdx);
            const hostPart = val.slice(atIdx + 1);
            const colonIdx = protoAndAuth.indexOf(":");
            const proto = protoAndAuth.slice(0, colonIdx);
            const auth = protoAndAuth.slice(colonIdx + 1);
            const [user, pass] = auth.split(":");
            customTurn = [{ urls: `${proto}:${hostPart}`, username: user, credential: pass }];
          } else {
            customTurn = [{ urls: val }];
          }
        } else if (val.startsWith("{") || val.startsWith("[")) {
          customTurn = JSON.parse(val);
        }
      } catch (e) {
        console.warn("[WebRTC] Errore parsing param ?turn:", e);
      }
    }
  }

  if (customTurn) {
    if (Array.isArray(customTurn)) servers.push(...customTurn);
    else servers.push(customTurn);
  }
  return servers;
}

const P2P_ICE_SERVERS = getEffectiveIceServers();

window.multiGbaSetTurnServer = (urls, username, credential) => {
  const cfg = { urls, username, credential };
  localStorage.setItem("multigba_turn_config", JSON.stringify(cfg));
  console.log("[WebRTC] Server TURN salvato nel localStorage:", cfg);
  return cfg;
};
window.rebitSetTurnServer = window.multiGbaSetTurnServer;

window.multiGbaClearTurnServer = () => {
  localStorage.removeItem("multigba_turn_config");
  localStorage.removeItem("rebit_turn_config");
  console.log("[WebRTC] Server TURN personalizzato rimosso.");
};
window.rebitClearTurnServer = window.multiGbaClearTurnServer;

// Canale dati "veloce" (input + ping): non ordinato, zero ritrasmissioni. Il canale PeerJS e' ordinato+affidabile:
// un solo pacchetto perso blocca TUTTI i successivi per >=200 ms (head-of-line blocking) => stallo => overlay.
// Ogni pacchetto porta gia' gli ultimi 32 input, quindi una perdita si recupera col pacchetto dopo.
// Compatibile con client vecchi: se il canale non si apre si ricade su conn.send().
function netOpenFastChannel(conn, onData) {
  if (/[?&]fast=0\b/.test(location.search)) return;   // ?fast=0 => solo canale affidabile
  try {
    const pc = conn.peerConnection;
    if (!pc || typeof pc.createDataChannel !== "function") return;
    const dc = pc.createDataChannel("fast", { negotiated: true, id: 7, ordered: false, maxRetransmits: 0 });
    dc.binaryType = "arraybuffer";
    dc.onmessage = (e) => onData(e.data);
    conn._fast = dc;
  } catch (e) { console.warn("[Net] canale veloce non disponibile:", e); }
}
// Se il canale veloce non consegna (NAT/browser strani) si torna al canale affidabile per tutta la sessione,
// per tutti i giocatori: meglio un po' di ritardo che una partita bloccata.
function netFastFallback(notify) {
  if (netFastBroken) return;
  netFastBroken = true;
  console.warn("[Net] canale veloce disattivato: uso il canale affidabile");
  if (!notify) return;
  const m = { type: "fast_off" };
  if (myPlayerId === 1) { for (const g of Object.values(connectedGuests)) if (g && g.conn && g.conn.open) { try { g.conn.send(m); } catch (e) {} } }
  else if (activeP2PConn && activeP2PConn.open) { try { activeP2PConn.send(m); } catch (e) {} }
}
function netSend(conn, buf) {
  if (!conn) return;
  const dc = conn._fast;
  if (!netFastBroken && dc && dc.readyState === "open") { try { dc.send(buf); return; } catch (e) {} }
  if (conn.open) { try { conn.send(buf); } catch (e) {} }
}
