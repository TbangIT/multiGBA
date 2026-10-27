// Relay MQTT - codec dei messaggi (nessuna dipendenza da app.js).
//  * Cifratura AES-GCM: chiave e topic derivati dal codice stanza (PBKDF2). Il broker pubblico vede solo byte cifrati.
//  * Frammentazione: i messaggi di controllo (salvataggi .sav) possono superare i limiti dei broker pubblici.
//  * JSON che trasporta anche binari ({$b: base64}) come fa il canale PeerJS.
// Formato frame (prima di cifrare): [kind u8][fromLen u8][from][msgId u16][idx u16][cnt u16][payload]
const RebitMqttCodec = (() => {
  const enc = new TextEncoder(), dec = new TextDecoder();
  const KIND = { CTRL: 1, BIN: 2, KEEP: 3, BYE: 4, JOIN: 5, WELCOME: 6 };
  const CHUNK = 40 * 1024;

  const isBuf = (v) => { const t = Object.prototype.toString.call(v); return t === "[object ArrayBuffer]" || ArrayBuffer.isView(v); };
  const toU8 = (v) => (ArrayBuffer.isView(v) ? new Uint8Array(v.buffer, v.byteOffset, v.byteLength) : new Uint8Array(v));
  function b64(u8) { let s = ""; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); return btoa(s); }
  function unb64(s) { const bin = atob(s); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return u; }
  const hex = (u8) => Array.from(u8, (b) => b.toString(16).padStart(2, "0")).join("");

  const toJson = (o) => enc.encode(JSON.stringify(o, (k, v) => (isBuf(v) ? { $b: b64(toU8(v)) } : v)));
  const fromJson = (u8) => JSON.parse(dec.decode(u8), (k, v) => (v && typeof v === "object" && typeof v.$b === "string" ? unb64(v.$b).buffer : v));

  async function deriveRoom(code) {
    const subtle = (typeof crypto !== "undefined") && crypto.subtle;
    if (!subtle) throw new Error("WebCrypto non disponibile (serve HTTPS)");
    const base = await subtle.importKey("raw", enc.encode("rebit-gba-v1|" + String(code).toUpperCase()), "PBKDF2", false, ["deriveBits"]);
    const bits = await subtle.deriveBits({ name: "PBKDF2", salt: enc.encode("rebit-gba-salt-v1"), iterations: 60000, hash: "SHA-256" }, base, 320);
    const key = await subtle.importKey("raw", bits.slice(0, 32), "AES-GCM", false, ["encrypt", "decrypt"]);
    return { key, topic: "rebit-gba/v1/" + hex(new Uint8Array(bits.slice(32, 40))) };
  }

  async function seal(key, frame) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, frame));
    const out = new Uint8Array(12 + ct.length); out.set(iv); out.set(ct, 12); return out;
  }
  async function open(key, bytes) {
    const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: bytes.subarray(0, 12) }, key, bytes.subarray(12));
    return new Uint8Array(pt);
  }

  let msgSeq = 0;
  // payload (Uint8Array) -> array di frame (Uint8Array), uno per frammento
  function frames(kind, from, payload) {
    const f = enc.encode(from), id = (msgSeq = (msgSeq + 1) & 0xffff);
    const cnt = Math.max(1, Math.ceil(payload.length / CHUNK)), out = [];
    for (let i = 0; i < cnt; i++) {
      const part = payload.subarray(i * CHUNK, (i + 1) * CHUNK);
      const fr = new Uint8Array(2 + f.length + 6 + part.length), dv = new DataView(fr.buffer);
      fr[0] = kind; fr[1] = f.length; fr.set(f, 2);
      const o = 2 + f.length; dv.setUint16(o, id); dv.setUint16(o + 2, i); dv.setUint16(o + 4, cnt);
      fr.set(part, o + 6); out.push(fr);
    }
    return out;
  }
  function parse(fr) {
    const dv = new DataView(fr.buffer, fr.byteOffset, fr.byteLength), fl = fr[1], o = 2 + fl;
    return { kind: fr[0], from: dec.decode(fr.subarray(2, o)), id: dv.getUint16(o), idx: dv.getUint16(o + 2), cnt: dv.getUint16(o + 4), part: fr.subarray(o + 6) };
  }
  // Riassemblatore: add(frameParsed) -> payload completo (Uint8Array) oppure null
  function Reassembler() {
    const parts = new Map();
    return {
      add(p) {
        if (p.cnt === 1) return p.part;
        const k = p.from + ":" + p.id; let e = parts.get(k);
        if (!e) { e = { got: 0, arr: new Array(p.cnt), t: Date.now() }; parts.set(k, e); }
        if (!e.arr[p.idx]) { e.arr[p.idx] = p.part; e.got++; }
        for (const [kk, v] of parts) if (Date.now() - v.t > 15000) parts.delete(kk);
        if (e.got < p.cnt) return null;
        parts.delete(k);
        const len = e.arr.reduce((n, a) => n + a.length, 0), out = new Uint8Array(len); let o = 0;
        for (const a of e.arr) { out.set(a, o); o += a.length; }
        return out;
      },
    };
  }
  return { KIND, isBuf, toU8, toJson, fromJson, deriveRoom, seal, open, frames, parse, Reassembler };
})();
