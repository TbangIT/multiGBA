// Relay MQTT - elenco broker pubblici, connessione con timeout e misura della latenza reale (eco).
// Nessuna registrazione: sono broker pubblici condivisi. Per questo i messaggi sono cifrati (mqtt-codec.js).
// Override: ?mqtt=wss://mio-broker:8084/mqtt,ws://altro:8083   oppure   window.REBIT_MQTT_BROKERS = [...]
const RebitMqttBrokers = (() => {
  // L'ORDINE conta: e' l'ordine di failover uguale per tutti i giocatori (ognuno passa al successivo nello stesso modo).
  const DEFAULTS = [
    "wss://broker.emqx.io:8084/mqtt",
    "wss://broker.hivemq.com:8884/mqtt",
    "wss://test.mosquitto.org:8081",
  ];
  const rid = () => Math.random().toString(36).slice(2, 10);

  function list() {
    const m = /[?&]mqtt=([^&]+)/.exec(location.search);
    if (m) return decodeURIComponent(m[1]).split(",").map((s) => s.trim()).filter(Boolean);
    return (window.REBIT_MQTT_BROKERS || DEFAULTS).slice();
  }
  function opts(extra) {
    return Object.assign({
      protocolVersion: 4, clean: true, keepalive: 30, reconnectPeriod: 1000, connectTimeout: 6000,
      resubscribe: true, queueQoSZero: false,   // un input vecchio accodato offline e' peggio di un input perso
    }, window.REBIT_MQTT_OPTS || {}, extra || {});
  }
  // Connessione con timeout. Dopo 'connect' la gestione degli errori passa alla sessione.
  function connect(url, extra, timeoutMs) {
    return new Promise((resolve, reject) => {
      let done = false, client = null;
      const fail = (e) => { if (done) return; done = true; clearTimeout(timer); try { client && client.end(true); } catch (_) {} reject(e instanceof Error ? e : new Error(String(e))); };
      const timer = setTimeout(() => fail(new Error("timeout")), timeoutMs || 6000);
      try { client = mqtt.connect(url, opts(extra)); } catch (e) { return fail(e); }
      client.on("error", (e) => { if (!done) fail(e); });
      client.on("connect", () => { if (done) return; done = true; clearTimeout(timer); resolve(client); });
    });
  }
  // Latenza reale client->broker->client (mediana di n eco su un topic privato).
  async function rtt(client, n) {
    const topic = "rebit-gba/v1/probe/" + rid(), times = []; let wake = null;
    const onMsg = (t) => { if (t === topic && wake) wake(true); };
    client.on("message", onMsg);
    try {
      await new Promise((res, rej) => client.subscribe(topic, { qos: 0 }, (e) => (e ? rej(e) : res())));
      for (let i = 0; i < (n || 3); i++) {
        const t0 = performance.now();
        const ok = await new Promise((res) => { wake = res; setTimeout(() => res(false), 2000); client.publish(topic, "p", { qos: 0 }); });
        if (!ok) break;
        times.push(performance.now() - t0);
      }
    } finally { client.removeListener("message", onMsg); try { client.unsubscribe(topic); } catch (_) {} }
    if (!times.length) return Infinity;
    times.sort((a, b) => a - b); return times[Math.floor(times.length / 2)];
  }
  // Prova TUTTI i broker in parallelo: {ok: [{url,i,client,rtt}] dal piu' veloce, bad: [{url,error}]}
  async function rank(urls, timeoutMs) {
    const all = await Promise.all(urls.map(async (url, i) => {
      try { const client = await connect(url, { clientId: "rbp" + rid() }, timeoutMs); return { url, i, client, rtt: await rtt(client, 3) }; }
      catch (e) { return { url, i, error: String(e.message || e) }; }
    }));
    const ok = all.filter((x) => x.client && isFinite(x.rtt)).sort((a, b) => a.rtt - b.rtt);
    all.filter((x) => x.client && !isFinite(x.rtt)).forEach((x) => x.client.end(true));
    return { ok, bad: all.filter((x) => !x.client || !isFinite(x.rtt)).map((x) => ({ url: x.url, error: x.error || "nessuna eco" })) };
  }
  return { list, connect, rtt, rank, rid };
})();
