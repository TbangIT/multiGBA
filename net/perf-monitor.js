// Diagnostica prestazioni: e' la RETE o e' mGBA (CPU)?  F3 = pannello, F4 = profilo lag (minimo/bilanciato/sicuro), ?perf=1 = pannello all'avvio.
// Finestre da 1 s: costo di emulazione per passo (medio/p95/max), render, tempo fermo ad aspettare un giocatore, margine degli input remoti,
// "in ritardo sul tempo reale" (CPU che non regge), blocchi del thread principale (rAF e long task), RTT applicativo vs RTT di rete puro.
// Non cambia il comportamento del gioco: solo misure. Hook chiamati da app.js: raf(), step(), render(), stallBegin/End(), behind(), margin().
const perf = (() => {
  const KEEP = 20;
  const fresh = () => ({ t0: performance.now(), raf: 0, gapMax: 0, pumpMs: 0, pumpMax: 0, steps: 0, calls: 0, emu: [], emuMove: 0, nMove: 0, emuIdle: 0, nIdle: 0,
    renders: 0, renderMs: 0, stallMs: 0, stalls: 0, stallPid: {}, behind: 0, marginMin: Infinity, marginSum: 0, marginN: 0, long: 0, longMax: 0 });
  let w = fresh(), hist = [], lastRaf = 0, stallPid = 0, hudEl = null, hudOn = false, tickN = 0;
  let netRtt = null, pathKind = "", longObs = null;

  try {   // long task: blocchi >50 ms del thread principale (Chrome/Edge)
    longObs = new PerformanceObserver((l) => { for (const e of l.getEntries()) { w.long++; if (e.duration > w.longMax) w.longMax = e.duration; } });
    longObs.observe({ entryTypes: ["longtask"] });
  } catch (_) {}

  const pct = (a, p) => { if (!a.length) return 0; const s = a.slice().sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(s.length * p))]; };
  const f1 = (x) => (isFinite(x) ? x.toFixed(1) : "-");

  function raf(now, pumpMs) {
    if (lastRaf) { const g = now - lastRaf; if (g > w.gapMax) w.gapMax = g; }
    lastRaf = now; w.raf++; w.pumpMs += pumpMs; if (pumpMs > w.pumpMax) w.pumpMax = pumpMs;
  }
  function step(emuMs, calls, moving) {
    w.steps++; w.calls += calls; if (w.emu.length < 400) w.emu.push(emuMs);
    if (moving) { w.emuMove += emuMs; w.nMove++; } else { w.emuIdle += emuMs; w.nIdle++; }
  }
  const render = (ms) => { w.renders++; w.renderMs += ms; };
  const stallBegin = (pid) => { stallPid = pid; };
  const stallEnd = (ms) => { w.stallMs += ms; w.stalls++; w.stallPid[stallPid] = (w.stallPid[stallPid] || 0) + ms; };
  const behind = () => { w.behind++; };
  const margin = (fr) => { if (fr < w.marginMin) w.marginMin = fr; w.marginSum += fr; w.marginN++; };

  async function sampleNetRtt() {   // RTT di rete PURO (stats ICE): non include il ritardo del thread principale
    try {
      const conns = (myPlayerId === 1) ? Object.values(connectedGuests).map((g) => g && g.conn) : [activeP2PConn];
      let best = null, kind = "";
      for (const c of conns) {
        if (!c) continue;
        if (c.type === "mqtt") { kind = "relay MQTT"; continue; }
        const pc = c.peerConnection; if (!pc || !pc.getStats) continue;
        const rep = await pc.getStats();
        rep.forEach((r) => {
          if (r.type === "candidate-pair" && (r.nominated || r.state === "succeeded") && typeof r.currentRoundTripTime === "number") {
            best = Math.max(best || 0, r.currentRoundTripTime * 1000);
            const lc = rep.get(r.localCandidateId); kind = "WebRTC " + ((lc && lc.candidateType) || "");
          }
        });
      }
      netRtt = best; pathKind = kind;
    } catch (_) {}
  }

  function summarize(now) {
    const dt = (now - w.t0) / 1000, speed = netSpeed(), frameMs = GBA_FRAME_MS / speed, n = w.steps;
    const emuSum = w.emu.reduce((a, b) => a + b, 0), emuMean = n ? emuSum / w.emu.length : 0;
    const s = {
      t: Math.round(now), speed, frameMs: +frameMs.toFixed(2), sps: +(n / dt).toFixed(1), targetSps: +(1000 / frameMs).toFixed(1), drawFps: +(w.renders / dt).toFixed(1),
      rafHz: +(w.raf / dt).toFixed(0), rafGapMax: +w.gapMax.toFixed(0), pumpMax: +w.pumpMax.toFixed(1), longTasks: w.long, longMax: +w.longMax.toFixed(0),
      emuMean: +emuMean.toFixed(2), emuP95: +pct(w.emu, 0.95).toFixed(2), emuMax: +pct(w.emu, 1).toFixed(2), callsPerStep: n ? +(w.calls / n).toFixed(2) : null,
      emuMoving: w.nMove >= 10 ? +(w.emuMove / w.nMove).toFixed(2) : null, emuIdle: w.nIdle >= 10 ? +(w.emuIdle / w.nIdle).toFixed(2) : null,
      renderMs: w.renders ? +(w.renderMs / w.renders).toFixed(2) : 0,
      cpuBudgetPct: Math.round(100 * emuMean / frameMs), busyPct: Math.round(100 * (emuSum + w.renderMs) / (dt * 1000)),
      stallPct: Math.round(100 * w.stallMs / (dt * 1000)), stalls: w.stalls, stallWho: Object.entries(w.stallPid).sort((a, b) => b[1] - a[1]).map(([p]) => +p)[0] || 0,
      behind: w.behind, marginMin: isFinite(w.marginMin) ? w.marginMin : null, marginAvg: w.marginN ? +(w.marginSum / w.marginN).toFixed(1) : null,
      appRtt: Math.round(netRttMs || 0), rttDev: Math.round(netRttDev || 0), netRtt: netRtt === null ? null : Math.round(netRtt), path: pathKind,
      delayFrames: netInputDelay, lagMs: Math.round(netInputDelay * frameMs), lagMode: netLagMode,
    };
    s.verdict = verdict(s);
    return s;
  }

  function verdict(s) {
    if (!s.sps) return "in pausa / nessun passo";
    const slow = s.sps < s.targetSps * 0.94;
    const cpu = s.cpuBudgetPct > 85 || s.busyPct > 80 || s.behind > 0;
    const net = s.stallPct >= 8;
    const hint = (s.netRtt !== null && s.appRtt - s.netRtt > 15) ? ` Il ping applicativo (${s.appRtt} ms) supera quello di rete (${s.netRtt} ms): il thread principale e' lento a rispondere.` : "";
    if (!slow && !net) return s.cpuBudgetPct > 70 ? `OK ma al limite: mGBA usa il ${s.cpuBudgetPct}% del tempo disponibile.` : "OK: velocita' piena.";
    if (cpu && net) return `CPU e rete insieme. mGBA ${s.emuMean} ms/passo su ${s.frameMs} disponibili (${s.cpuBudgetPct}%), fermo ${s.stallPct}% ad aspettare P${s.stallWho}.${hint}`;
    if (cpu) return `CPU (mGBA): ${s.emuMean} ms/passo (picco ${s.emuP95}) su ${s.frameMs} disponibili = ${s.cpuBudgetPct}%. Prova 1x o chiudi altre schede.`;
    if (net) return `RETE: fermo ${s.stallPct}% del tempo ad aspettare P${s.stallWho}; margine input min ${s.marginMin ?? "-"} frame, RTT ${s.appRtt} ms (jitter ${s.rttDev}).${hint}`;
    if (s.longTasks || s.rafGapMax > 60) return `Thread principale bloccato: ${s.longTasks} long task (max ${s.longMax} ms), rAF max ${s.rafGapMax} ms. Non e' ne' rete ne' mGBA: GC, altre schede o estensioni.`;
    return "Rallentamento senza causa evidente (ne' CPU ne' rete): copia il report e mandalo.";
  }

  function hudText(s) {
    if (!s) return "raccolta dati...";
    const L = [];
    L.push(`PASSI ${s.sps}/${s.targetSps} al s  |  SCHERMO ${s.drawFps} FPS  |  rAF ${s.rafHz} Hz (gap max ${s.rafGapMax} ms)`);
    L.push(`mGBA ${s.emuMean} ms/passo (p95 ${s.emuP95}, max ${s.emuMax}) = ${s.cpuBudgetPct}% di ${s.frameMs} ms  |  chiamate/passo ${s.callsPerStep ?? "-"}`);
    if (s.emuMoving !== null && s.emuIdle !== null) L.push(`in movimento ${s.emuMoving} ms vs fermo ${s.emuIdle} ms  |  render ${s.renderMs} ms`);
    else L.push(`render ${s.renderMs} ms  |  thread occupato ${s.busyPct}%  |  long task ${s.longTasks}`);
    if (currentMode === "netplay") {
      L.push(`ATTESA RETE ${s.stallPct}% (${s.stalls} stalli${s.stallWho ? ", P" + s.stallWho : ""})  |  margine input min ${s.marginMin ?? "-"} / medio ${s.marginAvg ?? "-"} fr  |  in ritardo ${s.behind}`);
      L.push(`RTT app ${s.appRtt} ms (jitter ${s.rttDev})  |  RTT rete ${s.netRtt === null ? "n/d" : s.netRtt + " ms"} ${s.path}`);
      L.push(`LAG tuo: ${s.lagMs} ms (${s.delayFrames} fr)  |  profilo ${NET_LAG_MODES[s.lagMode].label} [F4]`);
    }
    L.push(`>> ${s.verdict}`);
    return L.join("\n");
  }

  function ensureHud() {
    if (hudEl) return hudEl;
    hudEl = document.createElement("div");
    hudEl.id = "perfHud";
    hudEl.style.cssText = "position:fixed;left:8px;top:8px;z-index:99999;max-width:min(560px,94vw);background:rgba(8,12,20,.82);color:#bfe;font:11px/1.4 ui-monospace,Consolas,monospace;padding:7px 9px;border-radius:6px;white-space:pre-wrap;pointer-events:auto;display:none";
    hudEl.title = "clic = copia il report";
    hudEl.addEventListener("click", () => { copyReport(); });
    document.body.appendChild(hudEl);
    return hudEl;
  }
  function setHud(on) { hudOn = on; const e = ensureHud(); e.style.display = on ? "block" : "none"; if (on) e.textContent = hudText(hist[hist.length - 1]); }

  function report() {
    const last = hist[hist.length - 1] || null;
    return {
      app: "rebit-gba", when: new Date().toISOString(), mode: currentMode, players: netplayPlayerCount, me: myPlayerId, speed: netSpeed(),
      transport: activeP2PConn ? (activeP2PConn.type === "mqtt" ? "mqtt" : "webrtc") : (myPlayerId === 1 ? "host" : "-"), lagMode: netLagMode,
      browser: { ua: navigator.userAgent, cores: navigator.hardwareConcurrency || null, memGB: navigator.deviceMemory || null },
      verdict: last && last.verdict, last, history: hist.slice(-12),
    };
  }
  async function copyReport() {
    const txt = JSON.stringify(report(), null, 1);
    try { await navigator.clipboard.writeText(txt); if (hudEl) { const t = hudEl.textContent; hudEl.textContent = "Report copiato negli appunti."; setTimeout(() => { if (hudEl) hudEl.textContent = t; }, 1200); } }
    catch (_) { console.log("[perf] report:\n" + txt); }
    return txt;
  }

  function tick(now) {
    if (now - w.t0 < 1000) return;
    const s = summarize(now); hist.push(s); if (hist.length > KEEP) hist.shift(); w = fresh();
    if ((++tickN & 1) === 0) sampleNetRtt();
    if (hudOn && hudEl) hudEl.textContent = hudText(s);
  }

  window.addEventListener("keydown", (e) => {
    if (e.key === "F3") { e.preventDefault(); setHud(!hudOn); }
    else if (e.key === "F4" && currentMode === "netplay") { e.preventDefault(); const m = netCycleLagMode(); if (hudOn) hudEl.textContent = hudText(hist[hist.length - 1]) + `\nprofilo lag: ${NET_LAG_MODES[m].label}`; }
  });
  if (/[?&]perf=1\b/.test(location.search)) window.addEventListener("load", () => setHud(true));

  const api = { raf, step, render, stallBegin, stallEnd, behind, margin, tick, report, copyReport, hud: setHud, text: () => hudText(hist[hist.length - 1]) };
  window.gbaPerf = api;
  return api;
})();
