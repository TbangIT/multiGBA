// Relay MQTT: riserva quando WebRTC non riesce (NAT simmetrici, hotspot mobili, firewall). Solo connessioni in uscita.
// Espone una "connessione" con la STESSA interfaccia di PeerJS (on/send/close/open): il resto dell'app non cambia.
//
//   Topic (B = rebit-gba/v1/<hash del codice stanza>):  B/h = casella dell'host,  B/g/<id> = casella di un guest,  B/b = avvisi dell'host,
//   B/in = INPUT di tutti: ognuno pubblica una volta, il broker li distribuisce (l'host non rilancia: con 4 giocatori erano ~9 invii cifrati/frame)
//   Handshake: il guest si collega A TUTTI i broker e ripete JOIN ogni secondo; l'host risponde WELCOME sul broker che ha scelto
//   (il piu' veloce, misurato). Il primo WELCOME decide il broker della stanza. Non servono messaggi "retained".
//   Failover: se il broker cade, tutti passano al successivo nell'ORDINE FISSO dell'elenco; gli input persi si recuperano
//   da soli (ogni pacchetto porta gli ultimi 32 frame).
const RebitMqtt = (() => {
  const C = RebitMqttCodec, K = C.KIND, B = RebitMqttBrokers;
  const KEEP_MS = 2000, DEAD_MS = 10000, FAILOVER_MS = 4000, JOIN_EVERY_MS = 1000;
  const EMPTY = new Uint8Array(0);
  let hostCtl = null, guestCtl = null;

  // ---- Sessione: un client MQTT + cifratura + riassemblaggio + failover ----
  class Session {
    constructor(room, myId, urls, subs, willTopic, onFrame, onState) {
      Object.assign(this, { room, myId, urls, subs, willTopic, onFrame, onState });
      this.client = null; this.idx = -1; this.closed = false; this.rotating = false; this.badSince = 0;
      this.tx = Promise.resolve(); this.rx = Promise.resolve(); this.txDepth = 0; this.lastBcast = null; this.reasm = C.Reassembler(); this.onReconnected = null;
      this.watch = setInterval(() => this._watch(), 1000);
    }
    async connectIdx(idx, timeoutMs) {
      const will = this.willTopic ? { topic: this.willTopic, qos: 0, payload: await C.seal(this.room.key, C.frames(K.BYE, this.myId, EMPTY)[0]) } : undefined;
      const client = await B.connect(this.urls[idx], { clientId: "rb" + this.myId + "_" + idx, will }, timeoutMs);
      if (this.closed) { client.end(true); throw new Error("chiusa"); }
      this._attach(client, idx);
    }
    _attach(client, idx) {
      this.client = client; this.idx = idx; this.badSince = 0;
      client.on("error", () => {});
      client.on("message", (topic, payload) => this._rx(topic, payload));
      client.on("connect", () => { this.badSince = 0; });
      for (const t of this.subs) client.subscribe(t, { qos: 0 });
      this.onState && this.onState({ state: "up", url: this.urls[idx], idx });
    }
    send(topic, kind, payload, qos) {
      if (kind === K.BIN && this.txDepth > 4) return;   // coda cifratura piena: l'input successivo porta comunque la storia
      const frs = C.frames(kind, this.myId, payload);
      this.txDepth++;
      this.tx = this.tx.then(async () => {
        for (const fr of frs) {
          const sealed = await C.seal(this.room.key, fr);
          if (this.client && !this.closed) this.client.publish(topic, sealed, { qos });
        }
      }).catch(() => {}).then(() => { this.txDepth--; });
    }
    _rx(topic, payload) {   // catena di promise: decifratura asincrona ma consegna IN ORDINE
      const bytes = C.toU8(payload);
      this.rx = this.rx.then(async () => {
        let pt; try { pt = await C.open(this.room.key, bytes); } catch (_) { return; }   // chiave diversa o messaggio manomesso
        const p = C.parse(pt); if (p.from === this.myId) return;
        const full = this.reasm.add(p); if (full) this.onFrame(p.kind, p.from, full, topic);
      }).catch(() => {});
    }
    _watch() {
      if (this.closed || this.rotating || !this.client) return;
      if (this.client.connected) { this.badSince = 0; return; }
      this.badSince = this.badSince || Date.now();
      if (Date.now() - this.badSince > FAILOVER_MS) this.rotate();
    }
    async rotate() {
      if (this.rotating || this.closed) return; this.rotating = true;
      try { this.client && this.client.end(true); } catch (_) {}
      this.onState && this.onState({ state: "failover", url: this.urls[this.idx], idx: this.idx });
      for (let k = 1; k <= this.urls.length * 2 && !this.closed; k++) {
        const next = (this.idx + k) % this.urls.length;
        try { await this.connectIdx(next, 5000); this.rotating = false; this.onReconnected && this.onReconnected(); return; }
        catch (_) { await new Promise((r) => setTimeout(r, 800)); }
      }
      this.rotating = false;   // nessun broker: _watch riprovera'
      this.badSince = Date.now();
    }
    close() { this.closed = true; clearInterval(this.watch); try { this.client && this.client.end(true); } catch (_) {} }
  }

  // ---- Connessione logica host<->un guest (stessa interfaccia di PeerJS DataConnection) ----
  class MqttConn {
    constructor(session, sendTopic, label, inTopic) {
      this.s = session; this.topic = sendTopic; this.inTopic = inTopic; this.label = label; this.open = false; this.type = "mqtt";
      this._h = {}; this._openEmitted = false; this._seen = Date.now(); this._ka = null;
    }
    on(ev, fn) {
      (this._h[ev] = this._h[ev] || []).push(fn);
      if (ev === "open" && this._openEmitted) setTimeout(fn, 0);   // iscrizione tardiva: come se l'evento fosse appena partito
      return this;
    }
    _emit(ev, ...a) { for (const f of (this._h[ev] || []).slice()) { try { f(...a); } catch (e) { console.error("[MQTT conn]", ev, e); } } }
    _open() {
      if (this.open) return; this.open = true; this._seen = Date.now();
      this._ka = setInterval(() => this._tick(), KEEP_MS);
      setTimeout(() => { this._openEmitted = true; this._emit("open"); }, 0);
    }
    _tick() {
      this.s.send(this.topic, K.KEEP, EMPTY, 0);
      if (Date.now() - this._seen > DEAD_MS) this._die();
    }
    _die() { if (!this.open) return; this.open = false; clearInterval(this._ka); setTimeout(() => this._emit("close"), 0); }
    send(data) {
      if (!this.open) return;
      if (C.isBuf(data)) {
        const ping = typeof netPacketIsPing === "function" && netPacketIsPing(data);
        if (ping) return this.s.send(this.topic, K.BIN, C.toU8(data), 0);   // ping: punto-a-punto (RTT per giocatore)
        // input: UNA pubblicazione su B/in per tutti. Salta i pacchetti gia' arrivati da B/in (il broker li ha gia' distribuiti)
        // e i duplicati (l'app chiama send() una volta per guest con lo stesso buffer).
        if (data.__rbIn || data === this.s.lastBcast) return;
        this.s.lastBcast = data;
        this.s.send(this.inTopic, K.BIN, C.toU8(data), 0);                  // QoS0: la ridondanza copre le perdite
      }
      else this.s.send(this.topic, K.CTRL, C.toJson(data), 1);                // controllo (lobby, salvataggi): QoS1
    }
    close() { if (!this.open) return; this.s.send(this.topic, K.BYE, EMPTY, 0); this._die(); }
    _in(kind, payload, viaIn) {
      this._seen = Date.now();
      if (kind === K.BIN) { const u = new Uint8Array(payload.length); u.set(payload); if (viaIn) u.buffer.__rbIn = true; this._emit("data", u.buffer); }
      else if (kind === K.CTRL) { try { this._emit("data", C.fromJson(payload)); } catch (e) { console.warn("[MQTT] JSON non valido", e); } }
      else if (kind === K.BYE) this._die();
    }
  }

  // ---- HOST: scegli il broker piu' veloce, ascolta i JOIN, crea una MqttConn per ogni guest ----
  async function hostStart(roomCode, onIncoming, onStatus) {
    hostStop();
    const ctl = hostCtl = { session: null, conns: new Map(), stopped: false };
    const say = (s) => { if (!ctl.stopped && onStatus) onStatus(s); };
    const room = await C.deriveRoom(roomCode), urls = B.list(), me = "H" + B.rid();
    say({ phase: "probe" });
    const { ok, bad } = await B.rank(urls, 6000);
    if (ctl.stopped) { ok.forEach((r) => r.client.end(true)); return; }
    if (!ok.length) { say({ phase: "none", bad }); throw new Error("nessun broker MQTT raggiungibile"); }
    ok.forEach((r) => r.client.end(true));
    const base = room.topic;
    const onFrame = (kind, from, payload, topic) => {
      let conn = ctl.conns.get(from);
      if (kind === K.JOIN) {
        let meta = null;
        if (payload && payload.length > 0) {
          try { meta = C.fromJson(payload); } catch (_) {}
        }
        const token = (meta && (meta.session_token || meta.token)) || (typeof meta === "string" ? meta : null);
        if (!conn || !conn.open) {
          conn = new MqttConn(ctl.session, base + "/g/" + from, from, base + "/in");
          if (meta) conn.metadata = meta;
          if (token) conn.clientSessionToken = token;
          ctl.conns.set(from, conn); conn._open(); onIncoming(conn);
        } else if (token && !conn.clientSessionToken) {
          if (meta) conn.metadata = meta;
          conn.clientSessionToken = token;
        }
        ctl.session.send(base + "/g/" + from, K.WELCOME, EMPTY, 0);
      } else if (conn) conn._in(kind, payload, topic === base + "/in");
    };
    const s = ctl.session = new Session(room, me, urls, [base + "/h", base + "/in"], base + "/b", onFrame,
      (st) => say(Object.assign({ phase: st.state }, st)));
    // prova i broker nell'ordine di velocita' misurato
    for (const r of ok) { try { await s.connectIdx(r.i, 6000); say({ phase: "ready", url: r.url, rtt: Math.round(r.rtt), alternatives: ok.length - 1, bad }); return; } catch (_) {} }
    say({ phase: "none", bad }); throw new Error("connessione al broker fallita");
  }
  function hostStop() {
    if (!hostCtl) return;
    const c = hostCtl; hostCtl = null; c.stopped = true;
    for (const conn of c.conns.values()) { try { conn.close(); } catch (_) {} }
    setTimeout(() => c.session && c.session.close(), 300);   // lascia partire i BYE
  }

  // ---- GUEST: si collega a tutti i broker, JOIN ripetuto; il primo WELCOME sceglie il broker. Ritorna una promise con .cancel() ----
  function guestJoin(roomCode, onStatus, timeoutMs, meta) {
    guestStop();
    const ctl = guestCtl = { cands: [], done: false, conn: null };
    const say = (s) => { if (onStatus && !ctl.done) onStatus(s); };
    const sessionToken = (meta && typeof meta === "object") ? (meta.session_token || meta.token) : (typeof meta === "string" ? meta : null);
    const joinPayload = meta ? (typeof meta === "object" ? C.toJson(meta) : C.toJson({ session_token: meta })) : EMPTY;
    const promise = new Promise(async (resolve, reject) => {
      let timer = null, joinTimer = null;
      const finish = (err, conn) => {
        if (ctl.done) return; ctl.done = true; clearTimeout(timer); clearInterval(joinTimer);
        if (err) { ctl.cands.forEach((s) => s.close()); reject(err); } else resolve(conn);
      };
      ctl.cancel = () => finish(new Error("annullato"));
      try {
        const room = await C.deriveRoom(roomCode), urls = B.list(), me = "G" + B.rid(), base = room.topic;
        const inbox = base + "/g/" + me;
        timer = setTimeout(() => finish(new Error("nessuna risposta dall'host via MQTT")), timeoutMs || 15000);
        let welcomed = false;
        const sendJoin = () => { if (!welcomed) for (const s of ctl.cands) if (s.client && s.client.connected) s.send(base + "/h", K.JOIN, joinPayload, 0); };
        joinTimer = setInterval(sendJoin, JOIN_EVERY_MS);
        say({ phase: "connecting", brokers: urls.length });
        let failures = 0;
        urls.forEach((url, i) => {
          const s = new Session(room, me, urls, [inbox, base + "/b", base + "/in"], base + "/h", null, null);
          s.onFrame = (kind, from, payload, topic) => {
            if (ctl.done && ctl.conn && ctl.conn.s !== s) return;
            if (kind === K.WELCOME) {
              welcomed = true;
              if (!ctl.conn) {   // primo WELCOME: questo e' il broker della stanza
                ctl.cands.filter((x) => x !== s).forEach((x) => x.close());
                ctl.cands = [s];
                const conn = ctl.conn = new MqttConn(s, base + "/h", from, base + "/in");
                if (meta) conn.metadata = typeof meta === "object" ? meta : { session_token: meta };
                if (sessionToken) conn.clientSessionToken = sessionToken;
                conn._open();
                s.onState = (st) => { if (st.state === "failover") say({ phase: "failover" }); };
                s.onReconnected = () => { welcomed = false; sendJoin(); };   // sul nuovo broker l'host deve rivederci
                finish(null, conn);
              }
            } else if (ctl.conn && ctl.conn.s === s) ctl.conn._in(kind, payload, topic === base + "/in");
          };
          s.connectIdx(i, 6000).then(() => { say({ phase: "connected", url }); sendJoin(); })
            .catch(() => { if (++failures >= urls.length && !ctl.done) finish(new Error("nessun broker MQTT raggiungibile")); });
          ctl.cands.push(s);
        });
      } catch (e) { finish(e); }
    });
    promise.cancel = () => ctl.cancel && ctl.cancel();
    return promise;
  }
  function guestStop() {
    if (!guestCtl) return; const c = guestCtl; guestCtl = null;
    if (!c.done && c.cancel) c.cancel();
    if (c.conn) { try { c.conn.close(); } catch (_) {} setTimeout(() => c.conn.s.close(), 300); }
    else c.cands.forEach((s) => s.close());
  }

  const available = () => typeof mqtt !== "undefined" && typeof crypto !== "undefined" && !!crypto.subtle;
  function closeAll() { hostStop(); guestStop(); }
  return { available, hostStart, hostStop, guestJoin, guestStop, closeAll, MqttConn };
})();
window.RebitMqtt = RebitMqtt;
