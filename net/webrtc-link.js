// WebRTC (PeerJS): configurazione ICE e canale dati "veloce" per input/ping.
// Usa variabili di app.js solo a runtime (netFastBroken, myPlayerId, connectedGuests, activeP2PConn).

// STUN pubblici: bastano per le reti normali. I TURN gratuiti senza registrazione sono ormai inattivi/inaffidabili:
// con NAT simmetrici e hotspot mobili si passa al relay MQTT (net/mqtt-link.js).
const P2P_ICE_SERVERS = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun1.l.google.com:19302" },
  { urls: "stun:stun2.l.google.com:19302" },
  { urls: "stun:stun3.l.google.com:19302" },
  { urls: "stun:stun4.l.google.com:19302" },
  { urls: "stun:global.stun.twilio.com:3478" },
  { urls: "stun:stun.cloudflare.com:3478" },
  // Free public TURN relay servers for fallback across NATs, 4G/5G, and restrictive firewalls
  {
    urls: [
      "turn:openrelay.metered.ca:80",
      "turn:openrelay.metered.ca:443",
      "turn:openrelay.metered.ca:443?transport=tcp"
    ],
    username: "openrelayproject",
    credential: "openrelayproject"
  }
];

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

