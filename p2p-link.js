// p2p-link.js - WebRTC DataChannel P2P senza broker di segnalazione.
//
// Sostituisce PeerJS. Lo scambio di offerta/risposta (SDP + candidati ICE) avviene
// "a mano" tramite un codice compatto (o un link) che i due giocatori si passano via
// chat. Nessun server oltre a GitHub Pages (file statici) e ai server STUN pubblici,
// che servono solo a scoprire il proprio indirizzo pubblico: i dati di gioco non
// passano mai da loro.
//
// Espone la stessa interfaccia di PeerJS DataConnection usata da app.js:
//   link.open, link.send(x), link.close(), link.on(evento, cb)
// Eventi: "open", "data", "close", "error", "iceStateChanged".
(function (root) {
  "use strict";

  const CHUNK_SIZE = 15000;       // caratteri per messaggio di controllo (< 16 KB: sicuro ovunque)
  const GATHER_TIMEOUT_MS = 6000; // tempo massimo per raccogliere i candidati ICE
  const SIGNAL_PREFIX = "GBA1";   // versione del formato del codice

  // ---------- utilita' base64url / compressione ----------
  function toB64Url(bytes) {
    let bin = "";
    for (let i = 0; i < bytes.length; i += 0x8000) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    }
    return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }

  function fromB64Url(str) {
    let s = str.replace(/-/g, "+").replace(/_/g, "/");
    while (s.length % 4) s += "=";
    const bin = atob(s);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  async function pipeBytes(bytes, transform) {
    const buf = await new Response(new Blob([bytes]).stream().pipeThrough(transform)).arrayBuffer();
    return new Uint8Array(buf);
  }

  // Codice = "GBA1" + [0|1 compressione] + base64url(JSON {v,t,s})
  async function encodeSignal(type, sdp) {
    let bytes = new TextEncoder().encode(JSON.stringify({ v: 1, t: type, s: sdp }));
    let tag = "0";
    if (typeof CompressionStream !== "undefined") {
      try {
        bytes = await pipeBytes(bytes, new CompressionStream("deflate-raw"));
        tag = "1";
      } catch (e) { /* ripiega su non compresso */ }
    }
    return SIGNAL_PREFIX + tag + toB64Url(bytes);
  }

  // Accetta codice puro, link completo (#o=... / #a=...) o testo con spazi/a-capo.
  async function decodeSignal(text) {
    const flat = String(text || "").replace(/\s+/g, "");
    const m = flat.match(/GBA1([01])([A-Za-z0-9_-]+)/);
    if (!m) throw new Error("Codice non valido: deve iniziare con GBA1");
    let bytes = fromB64Url(m[2]);
    if (m[1] === "1") {
      if (typeof DecompressionStream === "undefined") {
        throw new Error("Questo browser non supporta la decompressione del codice. Aggiornalo.");
      }
      bytes = await pipeBytes(bytes, new DecompressionStream("deflate-raw"));
    }
    const obj = JSON.parse(new TextDecoder().decode(bytes));
    if (!obj || obj.v !== 1 || (obj.t !== "o" && obj.t !== "a") || typeof obj.s !== "string") {
      throw new Error("Codice non valido o di una versione diversa");
    }
    return obj;
  }

  // Controllo binario senza instanceof (che fallisce tra realm diversi, es. iframe).
  function isBinary(d) {
    return !!d && typeof d === "object" &&
      (Object.prototype.toString.call(d) === "[object ArrayBuffer]" || ArrayBuffer.isView(d));
  }

  function toArrayBuffer(d) {
    if (Object.prototype.toString.call(d) === "[object ArrayBuffer]") return d;
    if (ArrayBuffer.isView(d)) return d.buffer.slice(d.byteOffset, d.byteOffset + d.byteLength);
    return d;
  }

  // ---------- il link P2P ----------
  class P2PLink {
    constructor(role, iceServers) {
      this.role = role; // "host" | "guest"
      this._h = {};
      this._opened = false;
      this._closed = false;
      this._failedEmitted = false;
      this._txId = 0;
      this._rx = new Map();
      this._timers = {};
      this.candidates = { host: 0, srflx: 0, prflx: 0, relay: 0, v6: 0 }; // v6 = indirizzi IPv6 globali

      this.pc = new RTCPeerConnection({ iceServers: iceServers || [] });

      // Canali "negotiated": stesso id su entrambi i lati, niente attesa di ondatachannel.
      // ctrl  = affidabile e ordinato (handshake, salvataggi, comandi)
      // input = non ordinato, senza ritrasmissioni: ogni pacchetto contiene gia' gli
      //         ultimi frame di input, quindi un pacchetto perso non blocca il lockstep.
      this.ctrl = this.pc.createDataChannel("ctrl", { negotiated: true, id: 0, ordered: true });
      this.input = this.pc.createDataChannel("input", {
        negotiated: true, id: 1, ordered: false, maxRetransmits: 0,
      });
      this.ctrl.binaryType = "arraybuffer";
      this.input.binaryType = "arraybuffer";

      const maybeOpen = () => {
        if (this._opened || this._closed) return;
        if (this.ctrl.readyState === "open" && this.input.readyState === "open") {
          this._opened = true;
          this._clear("ice");
          this._emit("open");
        }
      };
      this.ctrl.onopen = maybeOpen;
      this.input.onopen = maybeOpen;

      this.ctrl.onmessage = (ev) => this._onCtrl(ev.data);
      this.input.onmessage = (ev) => this._emit("data", toArrayBuffer(ev.data));
      this.ctrl.onclose = () => this._remoteClosed();

      this.pc.onicecandidate = (ev) => {
        if (!ev.candidate) return;
        const t = ev.candidate.type ||
          ((/ typ (\w+)/.exec(ev.candidate.candidate || "")) || [])[1];
        if (t && t in this.candidates) this.candidates[t]++;
        const addr = ev.candidate.address || ((ev.candidate.candidate || "").split(" ")[4] || "");
        if (addr.indexOf(":") >= 0 && !/^fe80/i.test(addr)) this.candidates.v6++;
      };

      this.pc.oniceconnectionstatechange = () => {
        const s = this.pc.iceConnectionState;
        this._emit("iceStateChanged", s);
        if (s === "failed") {
          this._fail("ice-failed");
        } else if (s === "disconnected") {
          // Puo' essere transitorio: aspetta prima di dichiarare la caduta.
          this._clear("disc");
          this._timers.disc = setTimeout(() => {
            if (this.pc.iceConnectionState === "disconnected") this._remoteClosed();
          }, 6000);
        } else if (s === "connected" || s === "completed") {
          this._clear("disc");
        } else if (s === "closed") {
          this._remoteClosed();
        }
      };
    }

    // ----- eventi -----
    on(evt, cb) {
      (this._h[evt] = this._h[evt] || []).push(cb);
      return this;
    }
    _emit(evt, arg) {
      for (const cb of this._h[evt] || []) {
        try { cb(arg); } catch (e) { console.error("[P2PLink] handler", evt, e); }
      }
    }
    _clear(name) {
      if (this._timers[name]) { clearTimeout(this._timers[name]); this._timers[name] = null; }
    }
    _fail(type) {
      if (this._failedEmitted || this._closed || this._opened) return;
      this._failedEmitted = true;
      this._emit("error", { type, candidates: Object.assign({}, this.candidates) });
    }
    _remoteClosed() {
      if (this._closed) return;
      this._teardown();
      this._emit("close");
    }
    _teardown() {
      this._closed = true;
      for (const k of Object.keys(this._timers)) this._clear(k);
      try { this.ctrl.close(); } catch (e) {}
      try { this.input.close(); } catch (e) {}
      try { this.pc.close(); } catch (e) {}
    }

    get open() {
      return !this._closed && this.ctrl.readyState === "open" && this.input.readyState === "open";
    }

    // ----- signaling manuale -----
    async _waitGathering() {
      const t0 = Date.now();
      while (this.pc.iceGatheringState !== "complete" && Date.now() - t0 < GATHER_TIMEOUT_MS) {
        await new Promise((r) => setTimeout(r, 100));
      }
    }

    // Host: crea il codice invito.
    async createOffer() {
      await this.pc.setLocalDescription(await this.pc.createOffer());
      await this._waitGathering();
      return encodeSignal("o", this.pc.localDescription.sdp);
    }

    // Guest: riceve il codice invito, restituisce il codice risposta.
    async acceptOffer(code) {
      const sig = await decodeSignal(code);
      if (sig.t !== "o") throw new Error("Questo e' un codice RISPOSTA, qui serve il codice INVITO dell'Host");
      await this.pc.setRemoteDescription({ type: "offer", sdp: sig.s });
      await this.pc.setLocalDescription(await this.pc.createAnswer());
      await this._waitGathering();
      return encodeSignal("a", this.pc.localDescription.sdp);
    }

    // Host: riceve la risposta del guest.
    async acceptAnswer(code) {
      const sig = await decodeSignal(code);
      if (sig.t !== "a") throw new Error("Questo e' un codice INVITO, qui serve il codice RISPOSTA del compagno");
      await this.pc.setRemoteDescription({ type: "answer", sdp: sig.s });
    }

    // Se entro ms il canale non e' aperto, segnala l'errore (con diagnostica candidati).
    armTimeout(ms) {
      this._clear("ice");
      this._timers.ice = setTimeout(() => this._fail("ice-timeout"), ms);
    }

    // ----- invio -----
    send(data) {
      if (this._closed) return;
      if (isBinary(data)) {
        if (this.input.readyState === "open") this.input.send(data);
        return;
      }
      const json = JSON.stringify(data);
      const id = (this._txId++).toString(36);
      const total = Math.max(1, Math.ceil(json.length / CHUNK_SIZE));
      for (let i = 0; i < total; i++) {
        this.ctrl.send(id + ":" + i + ":" + total + ":" + json.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE));
      }
    }

    _onCtrl(raw) {
      if (typeof raw !== "string") return;
      const a = raw.indexOf(":");
      const b = raw.indexOf(":", a + 1);
      const c = raw.indexOf(":", b + 1);
      if (a < 0 || b < 0 || c < 0) return;
      const id = raw.slice(0, a);
      const idx = parseInt(raw.slice(a + 1, b), 10);
      const total = parseInt(raw.slice(b + 1, c), 10);
      const piece = raw.slice(c + 1);
      let entry = this._rx.get(id);
      if (!entry) { entry = { parts: new Array(total), got: 0 }; this._rx.set(id, entry); }
      if (entry.parts[idx] === undefined) { entry.parts[idx] = piece; entry.got++; }
      if (entry.got === total) {
        this._rx.delete(id);
        let msg;
        try { msg = JSON.parse(entry.parts.join("")); } catch (e) { return; }
        this._emit("data", msg);
      }
    }

    // Chiusura voluta dall'utente: non emette "close" (il chiamante sa gia' cosa sta facendo).
    close() { this._teardown(); }
    destroy() { this.close(); }
  }

  const api = { P2PLink, encodeSignal, decodeSignal, isBinary };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.P2P = api;
})(typeof window !== "undefined" ? window : globalThis);
