// Rebit mGBA Online - WebRTC P2P Netplay Driver (GitHub Pages Edition)
// Full implementation with Save Management (.sav / SRAM) and 2-Player Link Cable via direct WebRTC DataChannel (signaling manuale, nessun broker: vedi p2p-link.js).

window.Module = null;
window.romBytes = null;
window.localSram = null;

let loadedRomName = "Gioco GBA";
let loadedRomBaseName = "gba_game";

let isRunning = false;
let roomSpeed = 1; // 1 = 60 FPS, 2 = 120 FPS
let currentMode = "solo"; // "solo" | "dual" | "netplay"

const GBA_WIDTH = 240;
const GBA_HEIGHT = 160;
const GBA_STRIDE = 256;
const SRAM_SIZE = 131072; // 128 KB standard Flash SRAM

// GBA Button Bitmasks (12-bit)
const KEY_A = 1 << 0;
const KEY_B = 1 << 1;
const KEY_SELECT = 1 << 2;
const KEY_START = 1 << 3;
const KEY_RIGHT = 1 << 4;
const KEY_LEFT = 1 << 5;
const KEY_UP = 1 << 6;
const KEY_DOWN = 1 << 7;
const KEY_R = 1 << 8;
const KEY_L = 1 << 9;

window.GBA_KEYS = { KEY_A, KEY_B, KEY_SELECT, KEY_START, KEY_RIGHT, KEY_LEFT, KEY_UP, KEY_DOWN, KEY_R, KEY_L };

window.setTouchButton = function(mask, isDown) {
  if (isDown) {
    currentKeys |= mask;
  } else {
    currentKeys &= ~mask;
  }
};

window.toggleTouchSpeed = function() {
  const newSpeed = roomSpeed === 1 ? 2 : 1;
  setSpeed(newSpeed);
  if (activeP2PConn && activeP2PConn.open) {
    try { activeP2PConn.send({ type: "change_speed", speed: newSpeed }); } catch(e) {}
  }
};

const GBA_BUTTONS = [
  { id: "UP", label: "D-Pad Su", mask: KEY_UP, defaultPrimary: "ArrowUp", defaultSecondary: "KeyW" },
  { id: "DOWN", label: "D-Pad Giu", mask: KEY_DOWN, defaultPrimary: "ArrowDown", defaultSecondary: "KeyS" },
  { id: "LEFT", label: "D-Pad Sinistra", mask: KEY_LEFT, defaultPrimary: "ArrowLeft", defaultSecondary: "KeyA" },
  { id: "RIGHT", label: "D-Pad Destra", mask: KEY_RIGHT, defaultPrimary: "ArrowRight", defaultSecondary: "KeyD" },
  { id: "A", label: "Pulsante A (Conferma)", mask: KEY_A, defaultPrimary: "KeyZ", defaultSecondary: "KeyJ" },
  { id: "B", label: "Pulsante B (Annulla)", mask: KEY_B, defaultPrimary: "KeyX", defaultSecondary: "KeyK" },
  { id: "START", label: "Pulsante START", mask: KEY_START, defaultPrimary: "Enter", defaultSecondary: "KeyM" },
  { id: "SELECT", label: "Pulsante SELECT", mask: KEY_SELECT, defaultPrimary: "ShiftRight", defaultSecondary: "ShiftLeft" },
  { id: "L", label: "Dorsale L", mask: KEY_L, defaultPrimary: "KeyQ", defaultSecondary: "KeyU" },
  { id: "R", label: "Dorsale R", mask: KEY_R, defaultPrimary: "KeyE", defaultSecondary: "KeyI" },
  { id: "SPEED", label: "Velocita 2x (Fast Forward)", mask: 0, defaultPrimary: "Space", defaultSecondary: "Tab" },
];

let userKeybinds = {};
try {
  const storedBindsV3 = localStorage.getItem("gba_custom_keybinds_v3");
  if (storedBindsV3) {
    userKeybinds = JSON.parse(storedBindsV3);
  } else {
    const storedBindsV2 = localStorage.getItem("gba_custom_keybinds_v2");
    if (storedBindsV2) {
      const v2 = JSON.parse(storedBindsV2);
      GBA_BUTTONS.forEach((b) => {
        userKeybinds[b.id] = {
          primary: v2[b.id] || b.defaultPrimary,
          secondary: b.defaultSecondary
        };
      });
    }
  }
} catch (e) {
  console.warn("Could not load custom keybinds", e);
}

// Ensure every button has a primary and secondary slot defined
GBA_BUTTONS.forEach((b) => {
  if (!userKeybinds[b.id] || typeof userKeybinds[b.id] !== "object") {
    userKeybinds[b.id] = {
      primary: b.defaultPrimary,
      secondary: b.defaultSecondary
    };
  } else {
    if (userKeybinds[b.id].primary === undefined) userKeybinds[b.id].primary = b.defaultPrimary;
    if (userKeybinds[b.id].secondary === undefined) userKeybinds[b.id].secondary = b.defaultSecondary;
  }
});

let codeToMask = {};
let speedKeys = new Set();

function rebuildKeyLookup() {
  codeToMask = {};
  speedKeys = new Set();
  GBA_BUTTONS.forEach((b) => {
    const bind = userKeybinds[b.id];
    if (!bind) return;
    if (b.mask > 0) {
      if (bind.primary) codeToMask[bind.primary] = (codeToMask[bind.primary] || 0) | b.mask;
      if (bind.secondary) codeToMask[bind.secondary] = (codeToMask[bind.secondary] || 0) | b.mask;
    } else if (b.id === "SPEED") {
      if (bind.primary) speedKeys.add(bind.primary);
      if (bind.secondary) speedKeys.add(bind.secondary);
    }
  });
}
rebuildKeyLookup();

let listeningTarget = null; // { buttonId: string, slot: "primary" | "secondary" }

let inGameNoticeTimeout = null;
function showInGameNotice(text, durationMs = 6000) {
  const banner = document.getElementById("gameNotification");
  const bannerText = document.getElementById("gameNotificationText");
  if (!banner) return;
  if (bannerText) {
    bannerText.innerText = text;
  } else {
    banner.innerText = text;
  }
  banner.style.display = "flex";
  if (inGameNoticeTimeout) clearTimeout(inGameNoticeTimeout);
  if (durationMs > 0) {
    inGameNoticeTimeout = setTimeout(() => {
      banner.style.display = "none";
    }, durationMs);
  }
}

function hideInGameNotice() {
  const banner = document.getElementById("gameNotification");
  if (!banner) return;
  banner.style.display = "none";
  if (inGameNoticeTimeout) clearTimeout(inGameNoticeTimeout);
}

const btnCloseGameNotification = document.getElementById("btnCloseGameNotification");
if (btnCloseGameNotification) {
  btnCloseGameNotification.addEventListener("click", (e) => {
    e.stopPropagation();
    hideInGameNotice();
  });
}

let currentKeys = 0;
let p2Keys = 0;

// Canvas and Rendering
const canvas = document.getElementById("screenCanvas");
const ctx = canvas.getContext("2d", { alpha: false, desynchronized: true });
ctx.imageSmoothingEnabled = false;

let soloImageData = ctx.createImageData(GBA_WIDTH, GBA_HEIGHT);
let soloPixels = new Uint32Array(soloImageData.data.buffer);

let dualImageData = ctx.createImageData(GBA_WIDTH * 2, GBA_HEIGHT);
let dualPixels = new Uint32Array(dualImageData.data.buffer);

// UI Elements
const loadingOverlay = document.getElementById("loadingOverlay");
const loadingText = document.getElementById("loadingText");
const loadingDetail = document.getElementById("loadingDetail");
const progressBar = document.getElementById("progressBar");
const fpsBadge = document.getElementById("fpsBadge");
const speedBadge = document.getElementById("speedBadge");
const romBadge = document.getElementById("romBadge");
const saveBadge = document.getElementById("saveBadge");
const modeBadge = document.getElementById("modeBadge");

const btnPlayPause = document.getElementById("btnPlayPause");
const btnSpeedToggle = document.getElementById("btnSpeedToggle");
const btnAudioToggle = document.getElementById("btnAudioToggle");
const btnReset = document.getElementById("btnReset");
const btnImportSave = document.getElementById("btnImportSave");
const btnExportSave = document.getElementById("btnExportSave");
const inputSaveFile = document.getElementById("inputSaveFile");
const btnOpenNetplayModal = document.getElementById("btnOpenNetplayModal");
const modeSelect = document.getElementById("modeSelect");

// Modal Elements
const netplayModal = document.getElementById("netplayModal");
const btnCloseNetplayModal = document.getElementById("btnCloseNetplayModal");
const tabHostBtn = document.getElementById("tabHostBtn");
const tabJoinBtn = document.getElementById("tabJoinBtn");
const tabHostContent = document.getElementById("tabHostContent");
const tabJoinContent = document.getElementById("tabJoinContent");
const btnStartHosting = document.getElementById("btnStartHosting");
const hostWaitingArea = document.getElementById("hostWaitingArea");
const hostOfferCode = document.getElementById("hostOfferCode");
const hostAnswerInput = document.getElementById("hostAnswerInput");
const btnHostConnect = document.getElementById("btnHostConnect");
const joinAnswerCode = document.getElementById("joinAnswerCode");
const btnCopyAnswerCode = document.getElementById("btnCopyAnswerCode");
const generatedRoomCode = document.getElementById("generatedRoomCode");
const btnCopyRoomCode = document.getElementById("btnCopyRoomCode");
const btnCopyRoomLink = document.getElementById("btnCopyRoomLink");
const hostStatusNotice = document.getElementById("hostStatusNotice");
const btnJoinExistingRoom = document.getElementById("btnJoinExistingRoom");
const joinRoomCode = document.getElementById("joinRoomCode");
const joinStatusArea = document.getElementById("joinStatusArea");
const joinStatusNotice = document.getElementById("joinStatusNotice");
const activeNetplayBanner = document.getElementById("activeNetplayBanner");
const activeNetplayDetail = document.getElementById("activeNetplayDetail");
const btnDisconnectNetplay = document.getElementById("btnDisconnectNetplay");

// Canvas Overlay Elements (Background pause & network sync)
const canvasOverlay = document.getElementById("canvasOverlay");
const overlayCard = document.getElementById("overlayCard");
const overlayIcon = document.getElementById("overlayIcon");
const overlayTitle = document.getElementById("overlayTitle");
const overlaySubtitle = document.getElementById("overlaySubtitle");
const overlayHint = document.getElementById("overlayHint");

// Debug: Pause on background toggle
const chkPauseOnBackground = document.getElementById("chkPauseOnBackground");
let pauseOnBackground = localStorage.getItem("pauseOnBackground") === "1";
if (chkPauseOnBackground) {
  chkPauseOnBackground.checked = pauseOnBackground;
  chkPauseOnBackground.addEventListener("change", (e) => {
    pauseOnBackground = e.target.checked;
    localStorage.setItem("pauseOnBackground", pauseOnBackground ? "1" : "0");
    if (!pauseOnBackground && isBackgroundPaused) {
      isBackgroundPaused = false;
      hideCanvasOverlay();
    }
  });
}

let isBackgroundPaused = false;
let consecutiveWaitTicks = 0;

let isOverlayDismissed = false;
let lastOverlayTitle = "";

function showCanvasOverlay(icon, title, subtitle, hint, onCardClick = null, force = false) {
  if (!canvasOverlay) return;
  if (isOverlayDismissed && lastOverlayTitle === title && !force) {
    return;
  }
  if (lastOverlayTitle !== title) {
    isOverlayDismissed = false;
  }
  lastOverlayTitle = title;

  overlayIcon.innerText = icon;
  overlayTitle.innerText = title;
  overlaySubtitle.innerText = subtitle;
  overlayHint.innerText = hint;
  canvasOverlay.style.display = "flex";

  overlayCard.onclick = (e) => {
    if (e.target && e.target.id === "btnCloseOverlay") return;
    if (onCardClick) onCardClick();
    else if (isBackgroundPaused) {
      isBackgroundPaused = false;
      hideCanvasOverlay();
    }
  };
}

function hideCanvasOverlay() {
  if (!canvasOverlay) return;
  canvasOverlay.style.display = "none";
}

const btnCloseOverlay = document.getElementById("btnCloseOverlay");
if (btnCloseOverlay) {
  btnCloseOverlay.addEventListener("click", (e) => {
    e.stopPropagation();
    isOverlayDismissed = true;
    hideCanvasOverlay();
  });
}

// =============================================================
// Audio engine (v2.6)
// -------------------------------------------------------------
// Cosa NON andava (misurato sul core reale, vedi CORREZIONI.md):
//  * _mgba_demo_run_frame() NON esegue un frame GBA intero: ne esegue ~0.65.
//    Il vecchio loop la contava come "1 frame" => gioco al ~65% della velocita'
//    e audio prodotto a ~21.000 campioni/s invece di 32.768: buffer sempre
//    vuoto, silenzi a raffica (~32% del tempo) e pitch "stirato" dal drift control.
// Come funziona ora:
//  * il tempo emulato si misura in frame video REALI (contatore del core), non in
//    chiamate a run_frame (vedi runCoreOneVideoFrame / pumpEmulation);
//  * l'audio esce da un AudioWorklet (thread audio dedicato: immune ai rallentamenti
//    del thread principale). Fallback automatico: ScriptProcessor;
//  * rapporto di ricampionamento FISSO (nessuna variazione di pitch). La piccola deriva
//    tra clock audio e clock video si corregge variando di <= 1% la velocita' di
//    EMULAZIONE (invisibile), mai l'altezza del suono.
// =============================================================
const GBA_AUDIO_RING_SRC = `
class GbaAudioRing {
  constructor(cap) {
    this.cap = cap || 16384;
    this.l = new Float32Array(this.cap);
    this.r = new Float32Array(this.cap);
    this.target = 4000;   // dopo un taglio per eccesso si riparte da qui (campioni core, ~120 ms)
    this.high = 9000;     // oltre questo livello si scarta il vecchio (evita latenza accumulata)
    this.primeAt = 1200;
    this.ratio = 1;       // campioni core consumati per ogni campione in uscita
    this.rx = 0; this.underruns = 0; this.trims = 0;
    this.reset();
  }
  reset() {
    this.wp = 0; this.rp = 0; this.n = 0; this.frac = 0;
    this.primed = false; this.primeAt = 1200;
    this.lastL = 0; this.lastR = 0; this.rx = 0;
  }
  push(d, count) {
    const cap = this.cap, l = this.l, r = this.r;
    let start = 0;
    if (count > cap) { start = count - cap; count = cap; }
    this.rx += count;
    if (this.n + count > this.high) {
      let drop = this.n + count - this.target;
      if (drop > this.n) drop = this.n;
      if (drop > 0) {
        this.rp = (this.rp + drop) % cap;
        this.n -= drop;
        this.trims++;
      }
    }
    let wp = this.wp, o = start * 2;
    for (let i = 0; i < count; i++) {
      l[wp] = d[o++]; r[wp] = d[o++];
      if (++wp === cap) wp = 0;
    }
    this.wp = wp;
    this.n += count;
  }
  pull(outL, outR, len) {
    const cap = this.cap, l = this.l, r = this.r, ratio = this.ratio;
    let n = this.n, rp = this.rp, frac = this.frac, i = 0;
    let lastL = this.lastL, lastR = this.lastR;
    if (!this.primed && n >= this.primeAt) this.primed = true;
    if (this.primed) {
      for (; i < len; i++) {
        if (n < 2) { this.primed = false; this.primeAt = 600; this.underruns++; break; }
        const j = rp + 1 === cap ? 0 : rp + 1;
        const l0 = l[rp], r0 = r[rp];
        lastL = l0 + frac * (l[j] - l0);
        lastR = r0 + frac * (r[j] - r0);
        outL[i] = lastL; outR[i] = lastR;
        frac += ratio;
        if (frac >= 1) {
          const w = frac | 0;
          frac -= w; rp += w; if (rp >= cap) rp -= cap; n -= w;
        }
      }
    }
    // fuori da "primed" (avvio / underrun): dissolvenza a zero, senza "pop"
    for (; i < len; i++) {
      lastL *= 0.97; lastR *= 0.97;
      if (lastL < 1e-6 && lastL > -1e-6) lastL = 0;
      if (lastR < 1e-6 && lastR > -1e-6) lastR = 0;
      outL[i] = lastL; outR[i] = lastR;
    }
    this.n = n; this.rp = rp; this.frac = frac; this.lastL = lastL; this.lastR = lastR;
  }
}
`;

const GBA_AUDIO_WORKLET_SRC = `
class GbaAudioProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.ring = new GbaAudioRing(16384);
    this.epoch = 0;
    this.acc = 0;
    this.statEvery = Math.max(128, Math.round(sampleRate * 0.025));
    this.port.onmessage = (e) => {
      const m = e.data;
      if (m.t === "pcm") this.ring.push(m.d, m.n);
      else if (m.t === "ratio") this.ring.ratio = m.r;
      else if (m.t === "reset") { this.ring.reset(); this.epoch = m.epoch; }
    };
  }
  process(inputs, outputs) {
    const out = outputs[0];
    const L = out[0], R = out[1] || out[0];
    this.ring.pull(L, R, L.length);
    this.acc += L.length;
    if (this.acc >= this.statEvery) {
      this.acc = 0;
      const g = this.ring;
      this.port.postMessage({ t: "stat", epoch: this.epoch, fill: g.n, rx: g.rx, primed: g.primed, under: g.underruns, trims: g.trims });
    }
    return true;
  }
}
registerProcessor("gba-audio", GbaAudioProcessor);
`;

let audioCtx = null;
let audioNode = null;          // AudioWorkletNode (modo "worklet")
let audioScriptNode = null;    // ScriptProcessorNode (modo "script", fallback)
let audioRingLocal = null;     // ring sul thread principale (solo modo "script")
let audioMode = "none";        // "none" | "worklet" | "script"
let audioEnabled = true;
let audioInitStarted = false;
let audioCoreRate = 32768;     // frequenza reale del core (mGBA: 32768 Hz)
let audioEpoch = 0;            // incrementa a ogni reset, per scartare statistiche vecchie
let audioSent = 0;             // campioni inviati al worklet dall'ultimo reset
let audioStat = null;          // ultimo report del worklet {fill, rx, primed, under, trims, at}
let audioPaceSmooth = 1;
// Buffer audio "adattivo": parte da ~73 ms; ogni underrun lo allarga (fino a ~195 ms, per PC/tab
// con rallentamenti), poi si restringe piano quando torna tutto liscio.
const AUDIO_TARGET_MIN = 2400;
const AUDIO_TARGET_MAX = 6400;
let audioTargetFill = AUDIO_TARGET_MIN;
let audioSeenUnderruns = null;
let audioLastUnderAt = 0;
const AUDIO_BATCH_CAP = 8192;
const audioBatch = new Float32Array(AUDIO_BATCH_CAP * 2);
let audioBatchN = 0;

function audioRatio() {
  if (!audioCtx) return 1;
  return (audioCoreRate / audioCtx.sampleRate) * (roomSpeed === 2 ? 2 : 1);
}

function audioApplyRatio() {
  if (!audioCtx) return;
  const r = audioRatio();
  if (audioNode) audioNode.port.postMessage({ t: "ratio", r });
  if (audioRingLocal) audioRingLocal.ratio = r;
}

function audioReset() {
  audioBatchN = 0;
  audioSent = 0;
  audioEpoch++;
  audioStat = null;
  audioPaceSmooth = 1;
  if (audioNode) audioNode.port.postMessage({ t: "reset", epoch: audioEpoch });
  if (audioRingLocal) audioRingLocal.reset();
}

function setupAudioFallbackScriptProcessor() {
  if (audioMode !== "none" || !audioCtx) return;
  try {
    const Ring = new Function(GBA_AUDIO_RING_SRC + "; return GbaAudioRing;")();
    audioRingLocal = new Ring(16384);
    audioRingLocal.ratio = audioRatio();
    audioScriptNode = audioCtx.createScriptProcessor(1024, 0, 2);
    audioScriptNode.onaudioprocess = (e) => {
      audioRingLocal.pull(e.outputBuffer.getChannelData(0), e.outputBuffer.getChannelData(1), e.outputBuffer.length);
    };
    audioScriptNode.connect(audioCtx.destination);
    audioMode = "script";
    console.log("[Audio] modo ScriptProcessor (fallback), sampleRate", audioCtx.sampleRate);
  } catch (err) {
    console.warn("[Audio] Impossibile creare l'audio:", err);
  }
}

function setupAudioGraph() {
  const ctx = audioCtx;
  if (ctx.audioWorklet && typeof AudioWorkletNode !== "undefined") {
    let url = null;
    try {
      url = URL.createObjectURL(new Blob([GBA_AUDIO_RING_SRC + GBA_AUDIO_WORKLET_SRC], { type: "application/javascript" }));
    } catch (e) { url = null; }
    if (url) {
      ctx.audioWorklet.addModule(url).then(() => {
        URL.revokeObjectURL(url);
        const node = new AudioWorkletNode(ctx, "gba-audio", { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2] });
        node.port.onmessage = (e) => {
          const m = e.data;
          if (m && m.t === "stat" && m.epoch === audioEpoch) { m.at = performance.now(); audioStat = m; }
        };
        node.connect(ctx.destination);
        audioNode = node;
        audioMode = "worklet";
        audioReset();
        audioApplyRatio();
        console.log("[Audio] modo AudioWorklet, sampleRate", ctx.sampleRate, "Hz, core", audioCoreRate, "Hz");
      }).catch((err) => {
        console.warn("[Audio] AudioWorklet non disponibile, uso il fallback:", err);
        setupAudioFallbackScriptProcessor();
      });
      return;
    }
  }
  setupAudioFallbackScriptProcessor();
}

function initAudio() {
  if (!audioInitStarted) {
    audioInitStarted = true;
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) return;
    try {
      const mod = window.Module;
      if (mod && typeof mod._mgba_demo_audio_sample_rate === "function") {
        audioCoreRate = mod._mgba_demo_audio_sample_rate() || 32768;
      }
    } catch (e) {}
    // Contesto alla frequenza NATIVA del core: il browser ricampiona verso la scheda audio
    // con il suo resampler di alta qualita' e noi non dobbiamo interpolare nulla (a 1x).
    try {
      audioCtx = new AudioContextClass({ sampleRate: audioCoreRate, latencyHint: "interactive" });
    } catch (e1) {
      try { audioCtx = new AudioContextClass({ latencyHint: "interactive" }); }
      catch (e2) { audioCtx = new AudioContextClass(); }
    }
    setupAudioGraph();
  }
  if (audioCtx && audioCtx.state === "suspended") {
    audioCtx.resume().catch(() => {});
  }
}

// Riempimento stimato del buffer audio (campioni core) oppure null se non misurabile.
function audioEstimatedFill() {
  if (audioMode === "script" && audioRingLocal) {
    return { fill: audioRingLocal.n, primed: audioRingLocal.primed };
  }
  if (audioMode === "worklet" && audioStat && performance.now() - audioStat.at < 300) {
    return { fill: Math.max(0, audioStat.fill + (audioSent - audioStat.rx)), primed: audioStat.primed };
  }
  return null;
}

function audioUnderrunCount() {
  if (audioMode === "worklet") return audioStat ? audioStat.under : null;
  if (audioMode === "script" && audioRingLocal) return audioRingLocal.underruns;
  return null;
}

function audioAdaptTarget() {
  const u = audioUnderrunCount();
  if (u === null) return;
  const now = performance.now();
  if (audioSeenUnderruns === null) {
    audioSeenUnderruns = u;
    audioLastUnderAt = now;
  } else if (u > audioSeenUnderruns) {
    audioSeenUnderruns = u;
    audioLastUnderAt = now;
    audioTargetFill = Math.min(AUDIO_TARGET_MAX, audioTargetFill + 800);
  } else if (audioTargetFill > AUDIO_TARGET_MIN && now - audioLastUnderAt > 8000) {
    audioLastUnderAt = now;
    audioTargetFill = Math.max(AUDIO_TARGET_MIN, audioTargetFill - 200);
  }
}

// Fattore di velocita' dell'emulazione (0.99 .. 1.01) per tenere il buffer audio al livello
// desiderato. Buffer che si svuota -> si emula un filo piu' veloce; che si riempie -> piu' lento.
function audioPaceFactor() {
  let target = 1;
  if (audioEnabled && audioCtx && audioCtx.state === "running") {
    audioAdaptTarget();
    const s = audioEstimatedFill();
    if (s) {
      const err = (audioTargetFill - s.fill) / audioCoreRate; // secondi; > 0 = audio in calo
      target = 1 + Math.max(-0.01, Math.min(0.01, err * 0.25));
    }
  }
  audioPaceSmooth += (target - audioPaceSmooth) * 0.1;
  return audioPaceSmooth;
}

function audioAppend(pcm16, frames) {
  if (audioBatchN + frames > AUDIO_BATCH_CAP) audioFlush();
  let o = audioBatchN * 2;
  for (let i = 0, e = frames * 2; i < e; i++) audioBatch[o++] = pcm16[i] / 32768;
  audioBatchN += frames;
}

function audioFlush() {
  if (audioBatchN <= 0) return;
  const n = audioBatchN;
  audioBatchN = 0;
  if (audioMode === "worklet" && audioNode) {
    const out = audioBatch.slice(0, n * 2);
    audioNode.port.postMessage({ t: "pcm", d: out, n }, [out.buffer]);
    audioSent += n;
  } else if (audioMode === "script" && audioRingLocal) {
    audioRingLocal.push(audioBatch, n);
  }
}

// Svuota SEMPRE il buffer audio del core (anche se muto), per non farlo mai saturare.
function audioDrainCore(idx) {
  const M = window.Module;
  if (!M || typeof M._mgba_demo_audio_available !== "function") return;
  const live = audioEnabled && audioMode !== "none";
  for (let guard = 0; guard < 16; guard++) {
    const avail = M._mgba_demo_audio_available(idx);
    if (!(avail > 0)) break;
    const rc = M._mgba_demo_audio_read(idx, Math.min(avail, 2048));
    if (!(rc > 0)) break;
    if (live) {
      const ptr = M._mgba_demo_audio_buffer();
      if (!ptr) break;
      audioAppend(new Int16Array(M.HEAP16.buffer, ptr, rc * 2), rc);
    }
  }
}

window.gbaAudioDebug = () => {
  const s = audioEstimatedFill();
  return {
    mode: audioMode,
    ctxState: audioCtx ? audioCtx.state : null,
    ctxSampleRate: audioCtx ? audioCtx.sampleRate : null,
    coreRate: audioCoreRate,
    fillSamples: s ? Math.round(s.fill) : null,
    fillMs: s ? Math.round((s.fill / audioCoreRate) * 1000) : null,
    primed: s ? !!s.primed : null,
    underruns: audioMode === "worklet" ? (audioStat ? audioStat.under : null) : (audioRingLocal ? audioRingLocal.underruns : null),
    trims: audioMode === "worklet" ? (audioStat ? audioStat.trims : null) : (audioRingLocal ? audioRingLocal.trims : null),
    targetMs: Math.round((audioTargetFill / audioCoreRate) * 1000),
    paceFactor: Number(audioPaceSmooth.toFixed(4)),
  };
};

window.addEventListener("pointerdown", () => initAudio(), { passive: true, once: false });

// Modal and Input Detection Guards
function isAnyModalOpen() {
  const m1 = document.getElementById("netplayModal");
  const m2 = document.getElementById("savestateModal");
  const m3 = document.getElementById("keybindsModal");
  const m4 = document.getElementById("manualExchangeModal");
  return (m1 && m1.style.display !== "none" && m1.offsetParent !== null) ||
         (m2 && m2.style.display !== "none" && m2.offsetParent !== null) ||
         (m3 && m3.style.display !== "none" && m3.offsetParent !== null) ||
         (m4 && m4.style.display !== "none" && m4.offsetParent !== null);
}

function isInputField(el) {
  if (!el) return false;
  const tag = el.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || el.isContentEditable;
}

function openModal(modalEl) {
  if (!modalEl) return;
  currentKeys = 0;
  p2Keys = 0;
  modalEl.style.display = "flex";
}

function closeModal(modalEl) {
  if (!modalEl) return;
  modalEl.style.display = "none";
  currentKeys = 0;
  p2Keys = 0;
  listeningTarget = null;
  const c = document.getElementById("screenCanvas");
  if (c) c.focus();
}

// Keyboard input listeners
const P2_KEY_MAPPINGS = {
  KeyI: KEY_UP,
  KeyK: KEY_DOWN,
  KeyJ: KEY_LEFT,
  KeyL: KEY_RIGHT,
  KeyO: KEY_A,
  KeyP: KEY_B,
  KeyU: KEY_START,
  KeyY: KEY_SELECT,
  Numpad8: KEY_UP,
  Numpad2: KEY_DOWN,
  Numpad4: KEY_LEFT,
  Numpad6: KEY_RIGHT,
  Numpad1: KEY_A,
  Numpad3: KEY_B,
  NumpadEnter: KEY_START,
};

window.addEventListener("keydown", (e) => {
  if (listeningTarget) {
    e.preventDefault();
    e.stopPropagation();
    const { buttonId, slot } = listeningTarget;
    if (e.code === "Escape") {
      listeningTarget = null;
      renderKeybindsUI();
      return;
    }
    userKeybinds[buttonId][slot] = e.code;
    localStorage.setItem("gba_custom_keybinds_v3", JSON.stringify(userKeybinds));
    rebuildKeyLookup();
    listeningTarget = null;
    renderKeybindsUI();
    return;
  }

  if (isInputField(e.target)) {
    return;
  }

  if (isAnyModalOpen()) {
    currentKeys = 0;
    p2Keys = 0;
    return;
  }

  if (e.code in codeToMask) {
    currentKeys |= codeToMask[e.code];
    e.preventDefault();
  }
  if (currentMode === "dual" && e.code in P2_KEY_MAPPINGS) {
    p2Keys |= P2_KEY_MAPPINGS[e.code];
    e.preventDefault();
  }
  if (speedKeys.has(e.code)) {
    setSpeed(2); // Fast forward
    e.preventDefault();
  }
  initAudio();
});

window.addEventListener("keyup", (e) => {
  if (listeningTarget) return;

  if (isInputField(e.target)) {
    return;
  }

  if (isAnyModalOpen()) {
    currentKeys = 0;
    p2Keys = 0;
    return;
  }

  if (e.code in codeToMask) {
    currentKeys &= ~codeToMask[e.code];
    e.preventDefault();
  }
  if (currentMode === "dual" && e.code in P2_KEY_MAPPINGS) {
    p2Keys &= ~P2_KEY_MAPPINGS[e.code];
    e.preventDefault();
  }
  if (speedKeys.has(e.code)) {
    setSpeed(1);
    e.preventDefault();
  }
});

window.addEventListener("blur", () => {
  currentKeys = 0;
  p2Keys = 0;
  if (pauseOnBackground && isRunning) {
    isBackgroundPaused = true;
    showCanvasOverlay(
      "[PAUSA]",
      "Gioco in Pausa",
      "La finestra ha perso il focus (Debug attivo)",
      "Clicca qui o torna sulla finestra per riprendere"
    );
  }
});

window.addEventListener("focus", () => {
  currentKeys = 0;
  p2Keys = 0;
  if (pauseOnBackground && isBackgroundPaused) {
    isBackgroundPaused = false;
    hideCanvasOverlay();
  }
});

document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    currentKeys = 0;
    p2Keys = 0;
    if (pauseOnBackground && isRunning) {
      isBackgroundPaused = true;
      showCanvasOverlay(
        "[PAUSA]",
        "Scheda in Background",
        "Simulazione sospesa per debug / risparmio risorse",
        "Torna su questa scheda per continuare"
      );
    }
  } else {
    if (pauseOnBackground && isBackgroundPaused) {
      isBackgroundPaused = false;
      hideCanvasOverlay();
    }
  }
});

// Helper for Base64 and Uint8Array
function uint8ToBase64(bytes) {
  let binary = "";
  const len = bytes.byteLength;
  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return window.btoa(binary);
}

function base64ToUint8(base64) {
  const binary = window.atob(base64);
  const len = binary.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

// Browser-Persistent .sav Storage Management (per-game in localStorage)
function getSramStorageKey(romBase) {
  const base = romBase || loadedRomBaseName || "default_gba";
  const sanitized = base.replace(/[^a-zA-Z0-9_-]/g, "_").toLowerCase();
  return `gba_sav_${sanitized}`;
}

function saveSramToBrowserStorage(romBase, bytes) {
  if (!bytes || bytes.length === 0) return false;
  try {
    const key = getSramStorageKey(romBase);
    const b64 = uint8ToBase64(bytes);
    localStorage.setItem(key, b64);
    localStorage.setItem("gba_sav_last_active_key", key);
    localStorage.setItem("gba_sav_last_active_rom", loadedRomName);
    localStorage.setItem("gba_sav_last_active_time", Date.now().toString());

    let index = {};
    try {
      const storedIdx = localStorage.getItem("gba_saves_index");
      if (storedIdx) index = JSON.parse(storedIdx);
    } catch (e) {}
    index[key] = {
      romName: loadedRomName,
      romBaseName: loadedRomBaseName,
      size: bytes.length,
      updatedAt: new Date().toISOString()
    };
    localStorage.setItem("gba_saves_index", JSON.stringify(index));
    return true;
  } catch (err) {
    console.warn("Could not save SRAM to browser storage", err);
    return false;
  }
}

function loadSramFromBrowserStorage(romBase) {
  try {
    const key = getSramStorageKey(romBase);
    const stored = localStorage.getItem(key);
    if (stored) {
      const bytes = base64ToUint8(stored);
      if (bytes && bytes.length === SRAM_SIZE) {
        return bytes;
      }
    }
    const legacy = localStorage.getItem("pokemon_quetzal_sram");
    if (legacy) {
      const bytes = base64ToUint8(legacy);
      if (bytes && bytes.length === SRAM_SIZE) {
        return bytes;
      }
    }
  } catch (err) {
    console.warn("Could not load SRAM from browser storage", err);
  }
  return null;
}

function loadSavedSram() {
  const bytes = loadSramFromBrowserStorage(loadedRomBaseName);
  if (bytes && !isSramEmpty(bytes)) {
    saveBadge.innerText = "Salvataggio: Browser (128 KB)";
    return bytes;
  }
  try {
    const lastKey = localStorage.getItem("gba_sav_last_active_key");
    if (lastKey) {
      const stored = localStorage.getItem(lastKey);
      if (stored) {
        const b = base64ToUint8(stored);
        if (b && b.length === SRAM_SIZE && !isSramEmpty(b)) {
          saveBadge.innerText = "Salvataggio: Ripristinato (128 KB)";
          return b;
        }
      }
    }
  } catch (e) {}
  saveBadge.innerText = "Salvataggio: Nuovo (128 KB)";
  return new Uint8Array(SRAM_SIZE);
}

function isSramEmpty(bytes) {
  if (!bytes || bytes.length === 0) return true;
  let nonZero = 0;
  let nonFF = 0;
  const step = Math.max(1, Math.floor(bytes.length / 512));
  for (let i = 0; i < bytes.length; i += step) {
    if (bytes[i] !== 0x00) nonZero++;
    if (bytes[i] !== 0xFF) nonFF++;
    if (nonZero > 10 && nonFF > 10) return false;
  }
  return true;
}

function persistSram(bytes) {
  if (!bytes || bytes.length === 0) return;
  saveSramToBrowserStorage(loadedRomBaseName, bytes);
  saveBadge.innerText = "Salvataggio: Salvato!";
  setTimeout(() => {
    saveBadge.innerText = "Salvataggio: Browser (128 KB)";
  }, 2000);
}

function exportCurrentSram(playerIndex = 0) {
  if (!window.Module) return window.localSram || new Uint8Array(SRAM_SIZE);
  try {
    const ptr = window.Module._mgba_demo_export_save(playerIndex) >>> 0;
    const size = window.Module._mgba_demo_export_save_size() >>> 0;
    if (ptr && size > 0) {
      return window.Module.HEAPU8.slice(ptr, ptr + size);
    }
  } catch (err) {
    console.warn("Error exporting SRAM from core", err);
  }
  return window.localSram || new Uint8Array(SRAM_SIZE);
}

// Download ROM with progress bar
async function fetchRomWithProgress(url) {
  loadingText.innerText = `Download ROM (${loadedRomName})...`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`HTTP ${response.status} loading ROM`);

  const contentLength = Number(response.headers.get("content-length")) || 33554432;
  const reader = response.body.getReader();
  let receivedBytes = 0;
  const chunks = [];

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    receivedBytes += value.length;
    const percent = Math.min(100, Math.round((receivedBytes / contentLength) * 100));
    progressBar.style.width = percent + "%";
    loadingDetail.innerText = `${(receivedBytes / (1024 * 1024)).toFixed(1)} MB / ${(contentLength / (1024 * 1024)).toFixed(1)} MB (${percent}%)`;
  }

  const allChunks = new Uint8Array(receivedBytes);
  let position = 0;
  for (const chunk of chunks) {
    allChunks.set(chunk, position);
    position += chunk.length;
  }
  return allChunks;
}

// WASM Memory Pointers
let rom1Ptr = 0;
let rom2Ptr = 0;
let sram1Ptr = 0;
let sram2Ptr = 0;

function freeAllocatedPointers() {
  if (!window.Module) return;
  try {
    if (typeof window.Module._mgba_demo_destroy === "function") {
      window.Module._mgba_demo_destroy();
    }
  } catch (e) {
    console.warn("mgba_demo_destroy notice:", e);
  }
  if (rom1Ptr) { window.Module._free(rom1Ptr); rom1Ptr = 0; }
  if (rom2Ptr) { window.Module._free(rom2Ptr); rom2Ptr = 0; }
  if (sram1Ptr) { window.Module._free(sram1Ptr); sram1Ptr = 0; }
  if (sram2Ptr) { window.Module._free(sram2Ptr); sram2Ptr = 0; }
}

// Boot single player with ROM and local SRAM
function startSinglePlayer(sramBytes) {
  if (!window.Module || !window.romBytes) return;
  freeAllocatedPointers();

  const romSize = window.romBytes.byteLength;
  rom1Ptr = window.Module._malloc(romSize);
  window.Module.HEAPU8.set(window.romBytes, rom1Ptr);

  const sram = sramBytes || window.localSram || new Uint8Array(SRAM_SIZE);
  sram1Ptr = window.Module._malloc(SRAM_SIZE);
  window.Module.HEAPU8.set(sram, sram1Ptr);

  rom2Ptr = window.Module._malloc(romSize);
  window.Module.HEAPU8.set(window.romBytes, rom2Ptr);

  sram2Ptr = window.Module._malloc(SRAM_SIZE);
  window.Module.HEAPU8.fill(0, sram2Ptr, sram2Ptr + SRAM_SIZE);

  canvas.width = GBA_WIDTH;
  canvas.height = GBA_HEIGHT;
  canvas.style.width = "720px";
  canvas.style.height = "480px";
  modeBadge.innerText = "Modalita: Singolo (P1)";
  currentMode = "solo";
  setScreenView("solo");
  if (btnToggleScreenView) btnToggleScreenView.style.display = "none";
  if (modeSelect) modeSelect.value = "solo";

  if (window.Module && typeof window.Module._mgba_demo_audio_clear === "function") {
    try {
      window.Module._mgba_demo_audio_clear(0);
      window.Module._mgba_demo_audio_clear(1);
    } catch(e) {}
  }
  audioReset();

  const res = window.Module._mgba_demo_load_game_multi(
    rom1Ptr, romSize,
    rom2Ptr, romSize,
    0, 0, 0, 0,
    sram1Ptr, SRAM_SIZE,
    sram2Ptr, SRAM_SIZE,
    0, 0, 0, 0,
    2, 0
  );
  console.log("startSinglePlayer load_game_multi returned:", res);
  isRunning = true;
}

// Boot local split-screen dual co-op
function startDualScreenCoop() {
  if (!window.Module || !window.romBytes) return;
  freeAllocatedPointers();

  const romSize = window.romBytes.byteLength;
  rom1Ptr = window.Module._malloc(romSize);
  rom2Ptr = window.Module._malloc(romSize);
  window.Module.HEAPU8.set(window.romBytes, rom1Ptr);
  window.Module.HEAPU8.set(window.romBytes, rom2Ptr);

  sram1Ptr = window.Module._malloc(SRAM_SIZE);
  sram2Ptr = window.Module._malloc(SRAM_SIZE);
  window.Module.HEAPU8.set(window.localSram || new Uint8Array(SRAM_SIZE), sram1Ptr);
  window.Module.HEAPU8.fill(0, sram2Ptr, sram2Ptr + SRAM_SIZE);

  canvas.width = GBA_WIDTH * 2;
  canvas.height = GBA_HEIGHT;
  canvas.style.width = "960px";
  canvas.style.height = "320px";
  modeBadge.innerText = "Modalita: Dual Co-Op Link (P1 + P2)";
  currentMode = "dual";
  setScreenView("split");
  if (btnToggleScreenView) btnToggleScreenView.style.display = "inline-flex";

  if (window.Module && typeof window.Module._mgba_demo_audio_clear === "function") {
    try {
      window.Module._mgba_demo_audio_clear(0);
      window.Module._mgba_demo_audio_clear(1);
    } catch(e) {}
  }
  audioReset();

  const res = window.Module._mgba_demo_load_game_multi(
    rom1Ptr, romSize,
    rom2Ptr, romSize,
    0, 0, 0, 0,
    sram1Ptr, SRAM_SIZE,
    sram2Ptr, SRAM_SIZE,
    0, 0, 0, 0,
    2, -1
  );
  console.log("startDualScreenCoop load_game_multi returned:", res);
  isRunning = true;
}

// Boot Synchronized Online Netplay Multi-Core with exchanged saves
function startNetplayMultiCore(hostSramBytes, guestSramBytes, localPlayerId, viewMode = "solo") {
  if (!window.Module || !window.romBytes) return;
  freeAllocatedPointers();

  const romSize = window.romBytes.byteLength;
  rom1Ptr = window.Module._malloc(romSize);
  rom2Ptr = window.Module._malloc(romSize);
  window.Module.HEAPU8.set(window.romBytes, rom1Ptr);
  window.Module.HEAPU8.set(window.romBytes, rom2Ptr);

  sram1Ptr = window.Module._malloc(SRAM_SIZE);
  sram2Ptr = window.Module._malloc(SRAM_SIZE);

  const hostSave = (hostSramBytes && hostSramBytes.length === SRAM_SIZE) ? hostSramBytes : new Uint8Array(SRAM_SIZE);
  const guestSave = (guestSramBytes && guestSramBytes.length === SRAM_SIZE) ? guestSramBytes : new Uint8Array(SRAM_SIZE);

  window.Module.HEAPU8.set(hostSave, sram1Ptr);
  window.Module.HEAPU8.set(guestSave, sram2Ptr);

  currentMode = "netplay";
  myPlayerId = localPlayerId;
  remotePlayerId = localPlayerId === 1 ? 2 : 1;

  if (btnToggleScreenView) btnToggleScreenView.style.display = "inline-flex";
  setScreenView(viewMode || "solo");

  if (window.Module && typeof window.Module._mgba_demo_audio_clear === "function") {
    try {
      window.Module._mgba_demo_audio_clear(0);
      window.Module._mgba_demo_audio_clear(1);
    } catch(e) {}
  }
  audioReset();

  modeBadge.innerText = `Online: P${myPlayerId} (${netplayRoomSpeed}x Speed - P2P)`;
  modeBadge.className = "badge active";

  const res = window.Module._mgba_demo_load_game_multi(
    rom1Ptr, romSize,
    rom2Ptr, romSize,
    0, 0, 0, 0,
    sram1Ptr, SRAM_SIZE,
    sram2Ptr, SRAM_SIZE,
    0, 0, 0, 0,
    2, -1
  );
  console.log(`startNetplayMultiCore (Player ${myPlayerId}) load_game_multi returned:`, res);

  if (netplayRtcEpoch && typeof window.Module._mgba_demo_set_rtc_epoch === "function") {
    try {
      window.Module._mgba_demo_set_rtc_epoch(netplayRtcEpoch);
    } catch (e) {
      console.warn("set_rtc_epoch notice:", e);
    }
  }

  totalFramesSimulated = 0;
  maxRemoteFrame = -1;
  localInputByFrame = {};
  localInputHistory = [];
  remoteInputHistory = {};
  lastKnownRemoteKeys = 0;
  latestRemoteKeys = 0;
  consecutiveWaitTicks = 0;
  localInputByFrame[0] = 0;
  localInputByFrame[1] = 0;
  remoteInputHistory[0] = 0;
  remoteInputHistory[1] = 0;
  if (modeSelect) modeSelect.disabled = true;
  isRunning = true;
}

// Frame Timing and Animation Loop
let frameCount = 0;
let lastFpsTime = performance.now();
let lastAutoSavestateWallClock = Date.now();
let totalFramesSimulated = 0;
let maxRemoteFrame = -1;
let localInputByFrame = {};
let localInputHistory = [];
let remoteInputHistory = {};
let lastKnownRemoteKeys = 0;
let latestRemoteKeys = 0;
let netplayViewMode = "solo";

// Web Worker for background fallback precision timer
let timerWorker = null;
let lastRafTime = performance.now();
let lastPumpTime = performance.now();
let pumpDebtMs = 0; // tempo emulato "dovuto" (in ms a velocita' 1x) non ancora eseguito
let isLoopBusy = false;

// Un frame video del GBA dura 280896 cicli a 16.777.216 Hz = 59.7275 Hz (NON 60 Hz esatti).
const GBA_FRAME_MS = 1000 / (16777216 / 280896);

try {
  const blob = new Blob([`
    let timer = null;
    self.onmessage = function(e) {
      if (e.data.action === "start" || e.data.action === "interval") {
        if (timer) clearInterval(timer);
        timer = setInterval(function() {
          self.postMessage("tick");
        }, e.data.interval || 16);
      } else if (e.data.action === "stop") {
        if (timer) clearInterval(timer);
        timer = null;
      }
    };
  `], { type: "application/javascript" });
  timerWorker = new Worker(URL.createObjectURL(blob));
  timerWorker.onmessage = () => {
    // Only drive stepping from Web Worker if requestAnimationFrame has stalled (tab hidden in background)
    const now = performance.now();
    if (now - lastRafTime > 75) {
      if (isRunning && window.Module && !isLoopBusy && !(isBackgroundPaused && pauseOnBackground)) {
        isLoopBusy = true;
        try {
          // Stesso pacing del rAF (accumulatore sul tempo reale): niente piu' "un frame per tick".
          const steps = pumpEmulation(now);
          if (steps > 0) renderCanvasOnly();
        } finally {
          isLoopBusy = false;
        }
      }
    }
  };
} catch (e) {
  console.warn("Worker timer creation failed, using rAF only", e);
}

// _mgba_demo_run_frame() avanza di ~0.65 frame GBA per chiamata (core dual in lockstep), non di 1.
// Per avere "1 passo = 1 frame video" si richiama run_frame finche' il contatore frame del core
// avanza. Se il core fosse gia' 1:1 il ciclo gira una volta sola (nessun costo extra).
// I tasti restano impostati per tutte le chiamate del passo, quindi il netplay resta deterministico.
const CORE_MAX_CALLS_PER_FRAME = 4;
let coreFrameCounterReliable = true;
let coreFrameCounterStuck = 0;

function runCoreOneVideoFrame() {
  const M = window.Module;
  if (!coreFrameCounterReliable || typeof M._mgba_demo_get_frame !== "function") {
    M._mgba_demo_run_frame();
    return 1;
  }
  const before = M._mgba_demo_get_frame(0);
  let calls = 0;
  let after = before;
  do {
    M._mgba_demo_run_frame();
    calls++;
    after = M._mgba_demo_get_frame(0);
  } while (after === before && calls < CORE_MAX_CALLS_PER_FRAME);

  if (after === before) {
    // Contatore fermo: se succede di continuo non e' affidabile, si torna a 1 chiamata per passo.
    if (++coreFrameCounterStuck >= 30) {
      coreFrameCounterReliable = false;
      console.warn("[Core] Il contatore frame non avanza: pacing a 1 chiamata per frame.");
    }
  } else {
    coreFrameCounterStuck = 0;
  }
  return calls;
}

// Fa avanzare l'emulazione in base al TEMPO REALE trascorso (usato da rAF e dal worker di fallback).
// Ritorna quanti frame emulati sono stati eseguiti.
function pumpEmulation(now) {
  const elapsed = Math.min(Math.max(now - lastPumpTime, 0), 100);
  lastPumpTime = now;
  if (!isRunning || !window.Module) {
    pumpDebtMs = 0;
    return 0;
  }

  const speed = roomSpeed === 2 ? 2 : 1;
  pumpDebtMs += elapsed * speed * audioPaceFactor();

  const extraCatchup = (currentMode === "netplay" && maxRemoteFrame > totalFramesSimulated + 2) ? 1 : 0;
  const maxSteps = 6 * speed + extraCatchup; // fino a ~100 ms di recupero dopo uno stallo

  let steps = 0;
  while (pumpDebtMs >= GBA_FRAME_MS && steps < maxSteps) {
    const advanced = runSingleSimulationFrame();
    if (!advanced) {
      pumpDebtMs = 0;
      break;
    }
    pumpDebtMs -= GBA_FRAME_MS;
    steps++;
  }

  // Dopo un blocco lungo non si tenta di recuperare tutto: si riparte da qui.
  if (pumpDebtMs > GBA_FRAME_MS * 3) pumpDebtMs = GBA_FRAME_MS;

  audioFlush();
  return steps;
}

function runSingleSimulationFrame() {
  if (!isRunning || !window.Module) return false;

  // 1. Controller Inputs & Netplay Lockstep
  if (currentMode === "netplay" && activeP2PConn && activeP2PConn.open && netplayConnected) {
    const targetFrame = totalFramesSimulated + 2;
    if (!(targetFrame in localInputByFrame)) {
      localInputByFrame[targetFrame] = currentKeys;
      localInputHistory.push({ frame: targetFrame, keys: currentKeys });
      if (localInputHistory.length > 48) localInputHistory.shift();
    }

    // Send binary packet over WebRTC DataChannel
    const gbrb = packGbrbInput(myPlayerId, targetFrame, localInputHistory);
    const rbal = packRbalFrame(0, gbrb);
    try { activeP2PConn.send(rbal); } catch(e) {}

    // Strict Lockstep Check: Do we have peer's input for totalFramesSimulated?
    if (!(totalFramesSimulated in remoteInputHistory)) {
      consecutiveWaitTicks++;
      if (consecutiveWaitTicks >= 4) {
        if (consecutiveWaitTicks >= 180) {
          activateEmergencyRecoveryMode("Compagno non risponde da oltre 3s!");
        }
        if (consecutiveWaitTicks > 600) {
          showCanvasOverlay(
            "[!]",
            "Connessione Interrotta",
            "Nessun pacchetto ricevuto dall'altro giocatore da oltre 10s",
            "Clicca su '[!] Recupera Sessione' in alto per continuare in singolo senza perdere progressi!",
            () => recoverSessionToSinglePlayer()
          );
        } else {
          showCanvasOverlay(
            "[...]",
            "Sincronizzazione Rete...",
            `In attesa dei pacchetti del Giocatore ${remotePlayerId}...`,
            "La simulazione riprendera automaticamente non appena arrivano i dati"
          );
        }
      }
      return false; // Wait until peer input arrives
    }

    if (consecutiveWaitTicks >= 4) {
      hideCanvasOverlay();
    }
    consecutiveWaitTicks = 0;

    const localKeys = localInputByFrame[totalFramesSimulated] !== undefined ? localInputByFrame[totalFramesSimulated] : 0;
    const remoteKeys = remoteInputHistory[totalFramesSimulated] !== undefined ? remoteInputHistory[totalFramesSimulated] : 0;

    const p1 = myPlayerId === 1 ? localKeys : remoteKeys;
    const p2 = myPlayerId === 2 ? localKeys : remoteKeys;
    window.Module._mgba_demo_set_keys(0, p1);
    window.Module._mgba_demo_set_keys(1, p2);

    delete localInputByFrame[totalFramesSimulated - 60];
    delete remoteInputHistory[totalFramesSimulated - 60];
  } else if (currentMode === "dual") {
    window.Module._mgba_demo_set_keys(0, currentKeys);
    window.Module._mgba_demo_set_keys(1, p2Keys);
  } else {
    window.Module._mgba_demo_set_keys(0, currentKeys);
    window.Module._mgba_demo_set_keys(1, 0);
  }

  // 2. Step GBA Emulation: UN frame video reale (puo' richiedere 1-2 chiamate a run_frame)
  runCoreOneVideoFrame();
  totalFramesSimulated++;
  frameCount++;

  // 3. Audio del core -> motore audio (si svuota sempre il buffer del core)
  audioDrainCore(currentMode === "netplay" && myPlayerId === 2 ? 1 : 0);

  // 4. Auto-save check every ~15 seconds (.sav Flash SRAM)
  if (totalFramesSimulated > 0 && totalFramesSimulated % 900 === 0) {
    const sram = exportCurrentSram(currentMode === "netplay" && myPlayerId === 2 ? 1 : 0);
    if (sram && sram.length > 0 && !isSramEmpty(sram)) {
      window.localSram = sram;
      saveSramToBrowserStorage(loadedRomBaseName, sram);
    }
  }

  // 5. Auto emergency savestate check every 2 minutes in RAM
  if (totalFramesSimulated > 0 && (totalFramesSimulated % 7200 === 0 || Date.now() - lastAutoSavestateWallClock >= 120000)) {
    lastAutoSavestateWallClock = Date.now();
    createEmergencySavestate(true);
  }

  return true;
}

function renderCanvasOnly() {
  if (currentMode === "dual" || (currentMode === "netplay" && netplayViewMode === "split")) {
    const p1FbPtr = window.Module._mgba_demo_get_framebuffer(0);
    const p2FbPtr = window.Module._mgba_demo_get_framebuffer(1);
    const totalWidth = GBA_WIDTH * 2;

    if (p1FbPtr && p2FbPtr && dualPixels) {
      const p1View = new Uint32Array(window.Module.HEAPU8.buffer, p1FbPtr, GBA_STRIDE * GBA_HEIGHT);
      const p2View = new Uint32Array(window.Module.HEAPU8.buffer, p2FbPtr, GBA_STRIDE * GBA_HEIGHT);

      for (let y = 0; y < GBA_HEIGHT; y++) {
        const srcRow = y * GBA_STRIDE;
        const dstRow = y * totalWidth;
        for (let x = 0; x < GBA_WIDTH; x++) {
          dualPixels[dstRow + x] = p1View[srcRow + x] | 0xFF000000;
        }
        for (let x = 0; x < GBA_WIDTH; x++) {
          dualPixels[dstRow + GBA_WIDTH + x] = p2View[srcRow + x] | 0xFF000000;
        }
      }
      ctx.putImageData(dualImageData, 0, 0);
    }
  } else {
    const activeScreenIdx = currentMode === "netplay" && myPlayerId === 2 ? 1 : 0;
    const fbPtr = window.Module._mgba_demo_get_framebuffer(activeScreenIdx);
    if (fbPtr) {
      const fbView = new Uint32Array(window.Module.HEAPU8.buffer, fbPtr, GBA_STRIDE * GBA_HEIGHT);
      for (let y = 0; y < GBA_HEIGHT; y++) {
        const srcRow = y * GBA_STRIDE;
        const dstRow = y * GBA_WIDTH;
        for (let x = 0; x < GBA_WIDTH; x++) {
          soloPixels[dstRow + x] = fbView[srcRow + x] | 0xFF000000;
        }
      }
      ctx.putImageData(soloImageData, 0, 0);
    }
  }
}

function mainRafLoop(now) {
  requestAnimationFrame(mainRafLoop);
  if (!now) now = performance.now();
  lastRafTime = now;

  if (isBackgroundPaused && pauseOnBackground) {
    lastPumpTime = now;
    return;
  }

  if (isRunning && window.Module) {
    const steps = pumpEmulation(now);

    if (steps > 0) {
      renderCanvasOnly();
    }

    // FPS update every 500ms
    if (now - lastFpsTime >= 500) {
      const actualFps = Math.round((frameCount * 1000) / (now - lastFpsTime));
      fpsBadge.innerHTML = `<span class="indicator"></span> ${actualFps} FPS`;
      window.lastReportedFps = actualFps;
      frameCount = 0;
      lastFpsTime = now;
    }
  } else {
    lastPumpTime = now;
    pumpDebtMs = 0;
  }
}

function setSpeed(speed) {
  roomSpeed = speed;
  if (timerWorker) {
    timerWorker.postMessage({ action: "interval", interval: 16 });
  }
  if (speed === 2) {
    speedBadge.innerText = "Velocita: 2x (120 FPS)";
    speedBadge.className = "badge speed-2x";
    btnSpeedToggle.innerText = "[>>] Velocita: 2x";
  } else {
    roomSpeed = 1;
    speedBadge.innerText = "Velocita: 1x (60 FPS)";
    speedBadge.className = "badge";
    btnSpeedToggle.innerText = "[>>] Velocita: 1x";
  }
  audioApplyRatio();
}

// -------------------------------------------------------------
// Online Link Cable Netplay Implementation (WebRTC P2P)
// -------------------------------------------------------------
let peer = null;
let activeP2PConn = null;
let netplayConnected = false;
window.netplayConnected = false;
let myPlayerId = 1;
let remotePlayerId = 2;
let netplayRoomSpeed = 1;
let netplayRtcEpoch = 0;
let currentRoomCode = "";

function packGbrbInput(origin, frame, recentInputs) {
  const sampleList = recentInputs && recentInputs.length > 0
    ? recentInputs
    : [{ frame: frame, keys: currentKeys }];
  const sampleCount = Math.min(sampleList.length, 32);
  const totalSize = 40 + sampleCount * 8;
  const buf = new ArrayBuffer(totalSize);
  const view = new DataView(buf);
  view.setUint8(0, 0x47); // 'G'
  view.setUint8(1, 0x42); // 'B'
  view.setUint8(2, 0x52); // 'R'
  view.setUint8(3, 0x42); // 'B'
  view.setUint8(4, 1);
  view.setUint8(5, 1);
  view.setUint8(6, origin);
  view.setUint8(7, sampleCount);
  view.setUint8(8, 3);
  view.setUint8(9, 0);
  view.setUint16(10, 40);
  view.setUint32(12, 10001);
  view.setUint32(16, frame);
  view.setUint32(20, frame > 0 ? frame - 1 : 0xFFFFFFFF);
  view.setUint32(24, frame);
  view.setUint32(28, frame);
  view.setUint32(32, 0xFFFFFFFF);
  view.setUint32(36, 0xFFFFFFFF);

  const startIdx = sampleList.length - sampleCount;
  for (let i = 0; i < sampleCount; i++) {
    const s = sampleList[startIdx + i];
    const offset = 40 + i * 8;
    view.setUint32(offset, s.frame);
    view.setUint16(offset + 4, s.keys);
    view.setUint16(offset + 6, 0);
  }
  return buf;
}

function packRbalFrame(target, payload) {
  const buf = new Uint8Array(8 + payload.byteLength);
  const view = new DataView(buf.buffer);
  view.setUint32(0, 0x5242414C, true); // 'RBAL' LE
  view.setUint8(4, 1);
  view.setUint8(5, target);
  view.setUint8(6, 0);
  view.setUint8(7, 0);
  buf.set(new Uint8Array(payload), 8);
  return buf.buffer;
}

function unpackRbal(data) {
  const view = new DataView(data);
  const origin = view.getUint8(5);
  const payload = data.slice(8);
  return { origin, payload };
}

function unpackGbrb(data) {
  const view = new DataView(data);
  const origin = view.getUint8(6);
  const sampleCount = view.getUint8(7);
  const samples = [];
  for (let i = 0; i < sampleCount; i++) {
    const offset = 40 + i * 8;
    samples.push({
      frame: view.getUint32(offset),
      held: view.getUint16(offset + 4),
      pressed: view.getUint16(offset + 6),
    });
  }
  return { origin, samples };
}

// Server ICE: SOLO STUN. Servono unicamente a scoprire il proprio indirizzo pubblico;
// i dati di gioco non passano mai da loro. GitHub NON offre alcun servizio TURN (relay):
// per le reti piu' ostili (NAT simmetrico / CGNAT) non esiste un fallback gratuito "dentro
// GitHub". Se vuoi un relay devi aggiungere qui un TURN tuo, ad esempio:
//   { urls: "turn:turn.example.com:3478", username: "utente", credential: "password" }
const P2P_ICE_SERVERS = [
  { urls: ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"] },
  { urls: "stun:stun.cloudflare.com:3478" },
  { urls: "stun:global.stun.twilio.com:3478" },
];
const P2P_CONNECT_TIMEOUT_MS = 40000;
const HOST_BUNDLE_RESEND_MS = 4000;
const GUEST_HELLO_RESEND_MS = 2000;

let p2pHandshakeTimer = null;
let guestJoinTimeoutTimer = null;

function stopP2PHandshakeTimer() {
  if (p2pHandshakeTimer) {
    clearInterval(p2pHandshakeTimer);
    p2pHandshakeTimer = null;
  }
}

function clearGuestJoinTimeout() {
  if (guestJoinTimeoutTimer) {
    clearTimeout(guestJoinTimeoutTimer);
    guestJoinTimeoutTimer = null;
  }
}

function setNotice(el, text, isError = false) {
  if (!el) return;
  el.textContent = text;
  el.style.whiteSpace = "pre-line";
  el.style.color = isError ? "#f87171" : "";
}

function getLocalSramForHandshake() {
  let mySram = window.localSram;
  if (!mySram || mySram.length !== SRAM_SIZE) mySram = exportCurrentSram(0);
  if (!mySram || mySram.length !== SRAM_SIZE) {
    mySram = new Uint8Array(SRAM_SIZE);
    mySram.fill(0xff);
  }
  window.localSram = mySram;
  return mySram;
}

function describeIceFailure(info) {
  const c = (info && info.candidates) || {};
  let why;
  if (!c.srflx && !c.relay && !c.v6) {
    why = "Il browser non ha trovato un indirizzo pubblico (STUN bloccato da firewall, VPN o estensione anti-WebRTC?).";
  } else {
    why = "I due router non riescono a stabilire un collegamento diretto (probabile NAT simmetrico/CGNAT, tipico di molte reti mobili). GitHub non offre un relay TURN.";
  }
  return "[ERRORE] Connessione P2P non riuscita.\n" + why +
    "\nProva: hotspot del telefono su uno dei due, una rete con IPv6, oppure disattiva VPN/estensioni WebRTC." +
    "\nFate i passaggi in fretta: dopo che il compagno genera la risposta, incollatela all'Host entro ~30 secondi." +
    "\nPoi ripartite con un NUOVO invito.";
}

function resetNetplayButtons(role) {
  if (role === 1) {
    btnStartHosting.style.display = "block";
    btnHostConnect.disabled = true;
  } else {
    btnJoinExistingRoom.style.display = "block";
  }
}

let lastBundleSentAt = 0;

function setupDataConnection(conn, role) {
  activeP2PConn = conn;
  myPlayerId = role;
  remotePlayerId = myPlayerId === 1 ? 2 : 1;
  const notice = role === 1 ? hostStatusNotice : joinStatusNotice;

  conn.on("iceStateChanged", (s) => {
    console.log(`[WebRTC ICE] State (${role === 1 ? 'Host' : 'Guest'}):`, s);
    if (netplayConnected) return;
    if (s === "checking") {
      setNotice(notice, "Negoziazione dei router in corso (STUN)...");
    } else if (s === "connected" || s === "completed") {
      setNotice(notice, "Router collegati! Apertura canale di gioco...");
    }
  });

  conn.on("open", () => {
    console.log(`[WebRTC P2P] DataChannel aperto con successo! Ruolo: Giocatore ${myPlayerId}`);
    clearGuestJoinTimeout();
    if (myPlayerId === 1) {
      // Host: l'epoch RTC va deciso UNA volta sola e usato identico da entrambi i lati.
      const mySram = getLocalSramForHandshake();
      persistSram(mySram);
      netplayRtcEpoch = Math.floor(Date.now() / 1000);

      const sendHostBundle = () => {
        if (netplayConnected || !activeP2PConn || !activeP2PConn.open) return;
        console.log("[WebRTC Host] Invio ready_and_bundle...");
        lastBundleSentAt = Date.now();
        activeP2PConn.send({
          type: "ready_and_bundle",
          player: 2,
          room_speed: netplayRoomSpeed,
          rtc_epoch: netplayRtcEpoch,
          sramBase64: uint8ToBase64(mySram),
        });
      };

      sendHostBundle();
      stopP2PHandshakeTimer();
      p2pHandshakeTimer = setInterval(sendHostBundle, HOST_BUNDLE_RESEND_MS);
      setNotice(hostStatusNotice, "Compagno connesso! Scambio salvataggi (.sav)...");
    } else {
      setNotice(joinStatusNotice, "Canale P2P aperto! Scambio salvataggi con l'Host...");
      const sendGuestHello = () => {
        if (netplayConnected || !activeP2PConn || !activeP2PConn.open) return;
        console.log("[WebRTC Guest] Invio guest_hello...");
        activeP2PConn.send({ type: "guest_hello" });
      };
      sendGuestHello();
      stopP2PHandshakeTimer();
      p2pHandshakeTimer = setInterval(sendGuestHello, GUEST_HELLO_RESEND_MS);
    }
  });

  conn.on("data", (data) => {
    const isBin = (typeof P2P !== "undefined" && P2P.isBinary && P2P.isBinary(data)) ||
      data instanceof ArrayBuffer || (data && typeof data === "object" && (Object.prototype.toString.call(data) === "[object ArrayBuffer]" || ArrayBuffer.isView(data)));
    if (isBin) {
      const buf = data instanceof ArrayBuffer ? data : (ArrayBuffer.isView(data) ? data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) : data);
      try {
        const { origin, payload } = unpackRbal(buf);
        if (payload && payload.byteLength >= 48) {
          const gbrb = unpackGbrb(payload);
          if (gbrb && gbrb.samples && gbrb.samples.length > 0) {
            for (const s of gbrb.samples) {
              remoteInputHistory[s.frame] = s.held;
              if (s.frame > maxRemoteFrame) {
                maxRemoteFrame = s.frame;
              }
            }
            const newest = gbrb.samples[gbrb.samples.length - 1];
            latestRemoteKeys = newest.held;
            lastKnownRemoteKeys = newest.held;
          }
        }
      } catch (err) {
        console.warn("[WebRTC P2P] Error reading peer input packet:", err);
      }
    } else if (data && typeof data === "object") {
      handleP2PControlMessage(data);
    } else if (typeof data === "string") {
      try {
        handleP2PControlMessage(JSON.parse(data));
      } catch (e) {}
    }
  });

  conn.on("close", () => {
    console.log("[WebRTC P2P] Connessione P2P chiusa dal peer.");
    stopP2PHandshakeTimer();
    clearGuestJoinTimeout();
    if (!netplayConnected) {
      setNotice(notice, "Connessione chiusa dall'altro giocatore o caduta prima dell'avvio.", true);
      resetNetplayButtons(role);
    } else {
      handleP2PDisconnect();
    }
  });

  conn.on("error", (err) => {
    console.warn("[WebRTC P2P] Errore connessione:", err);
    stopP2PHandshakeTimer();
    clearGuestJoinTimeout();
    if (netplayConnected) return; // in partita se ne occupa l'evento "close"
    setNotice(notice, describeIceFailure(err), true);
    resetNetplayButtons(role);
    try { conn.close(); } catch (e) {}
  });
}

function handleP2PControlMessage(msg) {
  if (msg.type === "guest_hello" && myPlayerId === 1 && !netplayConnected) {
    // Il canale e' affidabile: reinvia il bundle solo se l'ultimo invio e' vecchio.
    if (Date.now() - lastBundleSentAt < 3000) return;
    const mySram = getLocalSramForHandshake();
    if (activeP2PConn && activeP2PConn.open) {
      lastBundleSentAt = Date.now();
      activeP2PConn.send({
        type: "ready_and_bundle",
        player: 2,
        room_speed: netplayRoomSpeed,
        rtc_epoch: netplayRtcEpoch,
        sramBase64: uint8ToBase64(mySram),
      });
    }
  } else if (msg.type === "ready_and_bundle" && myPlayerId === 2) {
    // Duplicato: il core e' gia' partito, rilanciarlo azzererebbe i frame e causerebbe desync.
    if (netplayConnected) return;
    stopP2PHandshakeTimer();
    clearGuestJoinTimeout();

    netplayRoomSpeed = msg.room_speed || 1;
    netplayRtcEpoch = msg.rtc_epoch || Math.floor(Date.now() / 1000);
    setSpeed(netplayRoomSpeed);

    setNotice(joinStatusNotice, "Host pronto! Invio il mio salvataggio (.sav)...");

    const mySram = getLocalSramForHandshake();
    persistSram(mySram);

    const sendGuestBundle = () => {
      if (!activeP2PConn || !activeP2PConn.open) return;
      activeP2PConn.send({
        type: "guest_bundle",
        sramBase64: uint8ToBase64(mySram),
      });
    };
    sendGuestBundle();
    p2pHandshakeTimer = setInterval(sendGuestBundle, HOST_BUNDLE_RESEND_MS);

    const hostSram = base64ToUint8(msg.sramBase64);
    const guestSram = mySram;

    const chosenView = document.getElementById("joinScreenView").value;
    startNetplayMultiCore(hostSram, guestSram, 2, chosenView);

    netplayConnected = true;
    window.netplayConnected = true;
    netplayModal.style.display = "none";
    activeNetplayBanner.style.display = "block";
    activeNetplayDetail.innerText = `Collegato come Giocatore 2 (${netplayRoomSpeed}x Speed - P2P Diretto).`;
  } else if (msg.type === "guest_bundle" && myPlayerId === 1) {
    // Conferma sempre (idempotente), ma avvia il core una sola volta.
    try { activeP2PConn.send({ type: "bundle_ack" }); } catch (e) {}
    if (netplayConnected) return;
    stopP2PHandshakeTimer();
    const guestSram = base64ToUint8(msg.sramBase64);
    const hostSram = getLocalSramForHandshake();

    const chosenView = document.getElementById("hostScreenView").value;
    startNetplayMultiCore(hostSram, guestSram, 1, chosenView);

    netplayConnected = true;
    window.netplayConnected = true;
    netplayModal.style.display = "none";
    activeNetplayBanner.style.display = "block";
    activeNetplayDetail.innerText = `Collegato come Giocatore 1 (${netplayRoomSpeed}x Speed - P2P Diretto).`;
  } else if (msg.type === "bundle_ack") {
    stopP2PHandshakeTimer();
  } else if (msg.type === "change_speed") {
    setSpeed(msg.speed || 1);
  }
}

function handleP2PDisconnect() {
  stopP2PHandshakeTimer();
  clearGuestJoinTimeout();
  if (isRecoveringSession) return;
  netplayConnected = false;
  window.netplayConnected = false;
  modeBadge.innerText = "Netplay Disconnesso";
  modeBadge.className = "badge";
  activeNetplayBanner.style.display = "none";
  if (modeSelect) modeSelect.disabled = false;
  activateEmergencyRecoveryMode("Compagno disconnesso o rete caduta");
  showCanvasOverlay(
    "[!]",
    "Compagno Disconnesso",
    "La sessione multiplayer P2P e terminata. Puoi recuperare subito la tua partita!",
    "Clicca qui o su '[!] Recupera Sessione' in alto per continuare in singolo",
    () => recoverSessionToSinglePlayer()
  );
}

// -------------------------------------------------------------
// UI Event Handlers
// -------------------------------------------------------------
btnPlayPause.addEventListener("click", () => {
  if (currentMode === "netplay") {
    showInGameNotice("[AVVISO] La pausa non e disponibile durante la sessione online per evitare desincronizzazioni.", 4000);
    return;
  }
  isRunning = !isRunning;
  btnPlayPause.innerText = isRunning ? "[||] Pausa" : "[>] Riprendi";
});

btnSpeedToggle.addEventListener("click", () => {
  const nextSpeed = roomSpeed === 1 ? 2 : 1;
  setSpeed(nextSpeed);
  if (currentMode === "netplay" && activeP2PConn && activeP2PConn.open) {
    activeP2PConn.send({
      type: "change_speed",
      speed: nextSpeed,
    });
  }
});

btnAudioToggle.addEventListener("click", () => {
  initAudio();
  audioEnabled = !audioEnabled;
  btnAudioToggle.innerText = audioEnabled ? "[Audio] Attivo" : "[Audio] Muto";
  audioReset();
});

btnReset.addEventListener("click", () => {
  if (currentMode === "netplay") {
    showInGameNotice("[AVVISO] Il riavvio locale durante una sessione online causerebbe una desincronizzazione. Esci dal Cavo Link prima di riavviare.", 5000);
    return;
  }
  if (window.Module) {
    window.Module._mgba_demo_reset();
    console.log("mGBA core reset.");
  }
});

// ROM File Loading Handlers
const btnLoadRom = document.getElementById("btnLoadRom");
const inputRomFile = document.getElementById("inputRomFile");
if (btnLoadRom && inputRomFile) {
  btnLoadRom.addEventListener("click", () => inputRomFile.click());
  inputRomFile.addEventListener("change", (e) => {
    const file = e.target.files[0];
    if (!file) return;
    loadedRomName = file.name;
    loadedRomBaseName = file.name.replace(/\.[^/.]+$/, "");
    const reader = new FileReader();
    reader.onload = (event) => {
      window.romBytes = new Uint8Array(event.target.result);
      romBadge.innerText = `ROM: ${loadedRomName}`;
      console.log(`[ROM] Caricata ROM ${loadedRomName} (${window.romBytes.length} bytes)`);

      // Automatic restoration of .sav from browser storage for this ROM
      const browserSram = loadSramFromBrowserStorage(loadedRomBaseName);
      if (browserSram && !isSramEmpty(browserSram)) {
        window.localSram = browserSram;
        saveBadge.innerText = "Salvataggio: Browser (128 KB)";
        showInGameNotice(`[💾 Progressi Caricati] Trovato e caricato salvataggio nel browser per "${loadedRomName}"!`, 4500);
      } else {
        window.localSram = new Uint8Array(SRAM_SIZE);
        saveBadge.innerText = "Salvataggio: Nuovo (128 KB)";
        showInGameNotice(`[ROM] Caricata: ${loadedRomName}. Nessun salvataggio pregresso trovato nel browser.`, 3500);
      }

      startSinglePlayer(window.localSram);
    };
    reader.readAsArrayBuffer(file);
  });
}

// Instant Save to Browser Button
const btnSaveBrowserNow = document.getElementById("btnSaveBrowserNow");
if (btnSaveBrowserNow) {
  btnSaveBrowserNow.addEventListener("click", () => {
    const activeIdx = currentMode === "netplay" && myPlayerId === 2 ? 1 : 0;
    const sram = exportCurrentSram(activeIdx);
    if (!sram || sram.length === 0 || isSramEmpty(sram)) {
      showInGameNotice("[AVVISO] Nessun dato salvato in gioco al momento. Salva prima dal menu del gioco (START -> Salva).", 5000);
      return;
    }
    window.localSram = sram;
    saveSramToBrowserStorage(loadedRomBaseName, sram);
    btnSaveBrowserNow.innerText = "[✓ Salvato!]";
    btnSaveBrowserNow.style.background = "#059669";
    showInGameNotice(`[💾 Salvato nel Browser] I progressi di "${loadedRomName}" sono memorizzati nel browser! Pronti anche dopo il refresh.`, 4500);
    setTimeout(() => {
      btnSaveBrowserNow.innerText = "[💾 Salva nel Browser]";
      btnSaveBrowserNow.style.background = "#065f46";
    }, 2500);
  });
}

// Save to Browser on Page Refresh or Tab Close
window.addEventListener("beforeunload", () => {
  if (isRunning && window.Module) {
    const activeIdx = currentMode === "netplay" && myPlayerId === 2 ? 1 : 0;
    const sram = exportCurrentSram(activeIdx);
    if (sram && sram.length > 0 && !isSramEmpty(sram)) {
      saveSramToBrowserStorage(loadedRomBaseName, sram);
    }
  }
});

window.addEventListener("pagehide", () => {
  if (isRunning && window.Module) {
    const activeIdx = currentMode === "netplay" && myPlayerId === 2 ? 1 : 0;
    const sram = exportCurrentSram(activeIdx);
    if (sram && sram.length > 0 && !isSramEmpty(sram)) {
      saveSramToBrowserStorage(loadedRomBaseName, sram);
    }
  }
});

// Save Management Handlers
btnExportSave.addEventListener("click", () => {
  const activeIdx = currentMode === "netplay" && myPlayerId === 2 ? 1 : 0;
  const sram = exportCurrentSram(activeIdx);
  if (!sram || sram.length === 0) {
    showInGameNotice("[AVVISO] Nessun dato di salvataggio disponibile ancora.", 4000);
    return;
  }
  window.localSram = sram;
  persistSram(sram);

  const blob = new Blob([sram], { type: "application/octet-stream" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${loadedRomBaseName}.sav`;
  a.click();
  URL.revokeObjectURL(url);
  console.log(`Downloaded ${loadedRomBaseName}.sav successfully.`);
  showInGameNotice(`[OK] Salvataggio scaricato: ${loadedRomBaseName}.sav`, 4000);
});

btnImportSave.addEventListener("click", () => {
  inputSaveFile.click();
});

inputSaveFile.addEventListener("change", (e) => {
  const file = e.target.files[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = (event) => {
    const raw = new Uint8Array(event.target.result);
    if (raw.length < 32768) {
      showInGameNotice(`[ERRORE] Il file di salvataggio e troppo piccolo (${raw.length} byte).`, 5000);
      return;
    }

    const fullSram = new Uint8Array(SRAM_SIZE);
    fullSram.fill(0xff);

    if (raw.length >= SRAM_SIZE) {
      fullSram.set(raw.subarray(0, SRAM_SIZE));
    } else {
      fullSram.set(raw);
    }

    window.localSram = fullSram;
    persistSram(fullSram);

    showInGameNotice(`[OK] Salvataggio (${(raw.length / 1024).toFixed(1)} KB) importato! Il gioco riparte con i tuoi dati.`, 5000);
    startSinglePlayer(fullSram);
  };
  reader.readAsArrayBuffer(file);
});

// -------------------------------------------------------------
// Emergency Savestate & Save Conversion Implementation
// -------------------------------------------------------------
const btnOpenSavestateModal = document.getElementById("btnOpenSavestateModal");
const savestateModal = document.getElementById("savestateModal");
const btnCloseSavestateModal = document.getElementById("btnCloseSavestateModal");
const btnCreateEmergencySavestate = document.getElementById("btnCreateEmergencySavestate");
const btnConvertSavestateToSav = document.getElementById("btnConvertSavestateToSav");
const btnRestoreEmergencySavestate = document.getElementById("btnRestoreEmergencySavestate");
const savestateStatusNotice = document.getElementById("savestateStatusNotice");

function exportCurrentState(playerIndex = 0) {
  if (!window.Module) return null;
  try {
    const ptr = window.Module._mgba_demo_export_state(playerIndex) >>> 0;
    const size = window.Module._mgba_demo_export_state_size() >>> 0;
    if (ptr && size > 0) {
      return window.Module.HEAPU8.slice(ptr, ptr + size);
    }
  } catch (err) {
    console.warn("Error exporting state from core", err);
  }
  return null;
}

function importCurrentState(playerIndex = 0, stateBytes) {
  if (!window.Module || !stateBytes || stateBytes.length === 0) return false;
  try {
    const ptr = window.Module._malloc(stateBytes.length);
    window.Module.HEAPU8.set(stateBytes, ptr);
    const res = window.Module._mgba_demo_import_state(playerIndex, ptr, stateBytes.length);
    window.Module._free(ptr);
    return res !== 0;
  } catch (err) {
    console.warn("Error importing state to core", err);
    return false;
  }
}

function showSavestateNotice(msg, isSuccess = true) {
  if (!savestateStatusNotice) return;
  savestateStatusNotice.style.background = isSuccess ? "#064e3b" : "#7f1d1d";
  savestateStatusNotice.style.borderColor = isSuccess ? "#10b981" : "#ef4444";
  savestateStatusNotice.style.color = isSuccess ? "#a7f3d0" : "#fca5a5";
  savestateStatusNotice.innerText = msg;
}

function updateSavestateStatusUI() {
  if (!savestateStatusNotice) return;
  const metaStr = localStorage.getItem("last_emergency_savestate_meta");
  if (metaStr) {
    try {
      const meta = JSON.parse(metaStr);
      const d = new Date(meta.timestamp);
      savestateStatusNotice.style.background = "#27272a";
      savestateStatusNotice.style.borderColor = "#3f3f46";
      savestateStatusNotice.style.color = "#d4d4d8";
      savestateStatusNotice.innerText = `Ultimo savestate ${meta.isAuto ? 'automatico' : 'manuale'}: ${d.toLocaleTimeString()} (Frame ${meta.frame}, ${(meta.size / 1024).toFixed(1)} KB)`;
      return;
    } catch (e) {}
  }
  savestateStatusNotice.innerText = "Ultimo savestate: Nessuno ancora registrato.";
}

window.lastEmergencyStateBytes = null;
let isEmergencyRecoveryActive = false;
let isRecoveringSession = false;

function activateEmergencyRecoveryMode(reason = "Interruzione Connessione") {
  if (isRecoveringSession) return;
  isEmergencyRecoveryActive = true;
  if (btnOpenSavestateModal) {
    btnOpenSavestateModal.innerText = "[!] Recupera Sessione";
    btnOpenSavestateModal.classList.add("btn-emergency-active");
  }
  const recBtn = document.getElementById("btnEmergencyRecoverAndSave");
  if (recBtn) {
    recBtn.innerText = "[!] Ripristina Sessione Subito in Singolo";
    recBtn.style.display = "block";
  }
}

function deactivateEmergencyRecoveryMode() {
  isEmergencyRecoveryActive = false;
  if (btnOpenSavestateModal) {
    btnOpenSavestateModal.innerText = "[#] Savestate di Emergenza";
    btnOpenSavestateModal.classList.remove("btn-emergency-active");
  }
  const recBtn = document.getElementById("btnEmergencyRecoverAndSave");
  if (recBtn) recBtn.style.display = "none";
}

function createEmergencySavestate(isAuto = false) {
  if (!window.Module || !isRunning) return;
  const activeIdx = currentMode === "netplay" && myPlayerId === 2 ? 1 : 0;
  const stateBytes = exportCurrentState(activeIdx);
  if (!stateBytes || stateBytes.length === 0) {
    showSavestateNotice("Errore durante l'esportazione dello stato mGBA.", false);
    return;
  }

  window.lastEmergencyStateBytes = stateBytes;

  try {
    localStorage.setItem("last_emergency_savestate", uint8ToBase64(stateBytes));
    const meta = {
      timestamp: Date.now(),
      frame: totalFramesSimulated,
      size: stateBytes.length,
      isAuto: isAuto
    };
    localStorage.setItem("last_emergency_savestate_meta", JSON.stringify(meta));
    const sizeKb = (stateBytes.length / 1024).toFixed(1);
    if (!isAuto) {
      showSavestateNotice(`[OK] Savestate salvato in RAM & Storage (~${sizeKb} KB, Frame ${totalFramesSimulated})!`, true);
    } else {
      console.log(`[Auto-Savestate 2min] Snapshot salvato in RAM (${sizeKb} KB) al frame ${totalFramesSimulated}`);
      updateSavestateStatusUI();
    }
  } catch (err) {
    console.warn("Could not save emergency state to localStorage", err);
    showSavestateNotice("Salvato in RAM (localStorage non disponibile o pieno)", true);
  }
}

function restoreEmergencySavestate() {
  const base64 = localStorage.getItem("last_emergency_savestate");
  if (!base64 && !window.lastEmergencyStateBytes) {
    showSavestateNotice("Nessun savestate di emergenza salvato trovato in memoria.", false);
    return;
  }
  const stateBytes = window.lastEmergencyStateBytes || base64ToUint8(base64);
  const activeIdx = currentMode === "netplay" && myPlayerId === 2 ? 1 : 0;
  const ok = importCurrentState(activeIdx, stateBytes);
  if (ok) {
    showSavestateNotice("[OK] Savestate di emergenza ripristinato con successo nel core!", true);
  } else {
    showSavestateNotice("Errore durante il ripristino dello stato nel core mGBA.", false);
  }
}

function recoverSessionToSinglePlayer() {
  console.log("[Recovery] Ripristino sessione in singolo dall'ultimo savestate...");
  isRecoveringSession = true;

  // 1. Hide canvas overlay immediately
  hideCanvasOverlay();

  // 2. Safely close WebRTC P2P connection
  if (activeP2PConn) {
    try { activeP2PConn.close(); } catch (e) {}
    activeP2PConn = null;
  }
  if (peer) {
    try { peer.destroy(); } catch (e) {}
    peer = null;
  }
  netplayConnected = false;
  window.netplayConnected = false;
  consecutiveWaitTicks = 0;
  activeNetplayBanner.style.display = "none";

  // 3. Reset canvas and screen view back to single player (720x480)
  canvas.width = GBA_WIDTH;
  canvas.height = GBA_HEIGHT;
  canvas.style.width = "720px";
  canvas.style.height = "480px";
  netplayViewMode = "solo";
  setScreenView("solo");

  modeBadge.innerText = "Modalita: Singolo (Recuperato)";
  modeBadge.className = "badge active";
  currentMode = "solo";
  if (modeSelect) {
    modeSelect.value = "solo";
    modeSelect.disabled = false;
  }

  // 4. Reset emergency recovery UI
  deactivateEmergencyRecoveryMode();
  if (savestateModal) savestateModal.style.display = "none";

  // 5. Restore hardware state from RAM snapshot into Core 0
  const stateBytes = window.lastEmergencyStateBytes || (localStorage.getItem("last_emergency_savestate") ? base64ToUint8(localStorage.getItem("last_emergency_savestate")) : null);
  if (stateBytes && stateBytes.length > 100000) {
    importCurrentState(0, stateBytes);
    console.log("[Recovery] Hardware snapshot applicato su Core 0.");
  } else {
    console.warn("[Recovery] Nessuno snapshot valido trovato in RAM o storage.");
  }

  // 6. Resume game execution
  isRunning = true;
  if (btnPlayPause) btnPlayPause.innerText = "[||] Pausa";

  // 7. Finish recovery phase
  setTimeout(() => {
    isRecoveringSession = false;
  }, 300);

  // 8. Remind user to save in-game immediately
  showInGameNotice("[AVVISO] Sessione ripristinata in singolo! Salva subito dal menu di gioco (START -> Salva) per salvare i progressi.", 10000);
}

const btnEmergencyRecoverAndSave = document.getElementById("btnEmergencyRecoverAndSave");
if (btnEmergencyRecoverAndSave) {
  btnEmergencyRecoverAndSave.addEventListener("click", recoverSessionToSinglePlayer);
}

const inputSavestateFile = document.getElementById("inputSavestateFile");
const btnImportSavestateFile = document.getElementById("btnImportSavestateFile");
const btnExportSavestateFile = document.getElementById("btnExportSavestateFile");

if (btnExportSavestateFile) {
  btnExportSavestateFile.addEventListener("click", () => {
    const activeIdx = currentMode === "netplay" && myPlayerId === 2 ? 1 : 0;
    const state = exportCurrentState(activeIdx) || window.lastEmergencyStateBytes;
    if (!state) {
      showSavestateNotice("Nessun savestate da esportare.", false);
      return;
    }
    const blob = new Blob([state], { type: "application/octet-stream" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${loadedRomBaseName}_emergency.state`;
    a.click();
    URL.revokeObjectURL(url);
    showSavestateNotice("[OK] Snapshot .state (~390 KB) scaricato!", true);
  });
}

if (btnImportSavestateFile && inputSavestateFile) {
  btnImportSavestateFile.addEventListener("click", () => inputSavestateFile.click());
  inputSavestateFile.addEventListener("change", (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (event) => {
      const bytes = new Uint8Array(event.target.result);
      if (bytes.length < 100000) {
        showSavestateNotice("File snapshot non valido o troppo piccolo.", false);
        return;
      }
      window.lastEmergencyStateBytes = bytes;
      localStorage.setItem("last_emergency_savestate", uint8ToBase64(bytes));
      const activeIdx = currentMode === "netplay" && myPlayerId === 2 ? 1 : 0;
      importCurrentState(activeIdx, bytes);
      showSavestateNotice(`[OK] Snapshot (${(bytes.length / 1024).toFixed(1)} KB) caricato e applicato!`, true);
    };
    reader.readAsArrayBuffer(file);
  });
}

function convertSavestateToSav() {
  const activeIdx = currentMode === "netplay" && myPlayerId === 2 ? 1 : 0;
  let sram = exportCurrentSram(activeIdx);
  if (isSramEmpty(sram)) {
    const base64 = localStorage.getItem("last_emergency_savestate");
    if (base64) {
      const stateBytes = base64ToUint8(base64);
      importCurrentState(activeIdx, stateBytes);
      sram = exportCurrentSram(activeIdx);
    }
  }

  if (isSramEmpty(sram) && window.localSram && !isSramEmpty(window.localSram)) {
    sram = window.localSram;
  }

  const finalSave = new Uint8Array(SRAM_SIZE);
  finalSave.fill(0xff);
  if (sram && sram.length > 0) {
    finalSave.set(sram.subarray(0, Math.min(sram.length, SRAM_SIZE)));
  }

  const blob = new Blob([finalSave], { type: "application/octet-stream" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${loadedRomBaseName}_converted.sav`;
  a.click();
  URL.revokeObjectURL(url);

  showSavestateNotice(`[OK] Convertito e scaricato '${loadedRomBaseName}_converted.sav' (128 KB standard Flash)!`, true);
}

if (btnOpenSavestateModal) {
  btnOpenSavestateModal.addEventListener("click", () => {
    if (isEmergencyRecoveryActive) {
      recoverSessionToSinglePlayer();
    } else {
      savestateModal.style.display = "flex";
      updateSavestateStatusUI();
    }
  });
}

if (btnCloseSavestateModal) {
  btnCloseSavestateModal.addEventListener("click", () => {
    savestateModal.style.display = "none";
  });
}

if (btnCreateEmergencySavestate) {
  btnCreateEmergencySavestate.addEventListener("click", () => createEmergencySavestate(false));
}

if (btnRestoreEmergencySavestate) {
  btnRestoreEmergencySavestate.addEventListener("click", restoreEmergencySavestate);
}

if (btnConvertSavestateToSav) {
  btnConvertSavestateToSav.addEventListener("click", convertSavestateToSav);
}

// Keybindings UI Logic
const btnOpenKeybindsModal = document.getElementById("btnOpenKeybindsModal");
const keybindsModal = document.getElementById("keybindsModal");
const btnCloseKeybindsModal = document.getElementById("btnCloseKeybindsModal");
const keybindContainer = document.getElementById("keybindContainer");

function formatKeyCode(code) {
  if (!code) return "Nessuno";
  if (code.startsWith("Key")) return code.replace("Key", "");
  if (code.startsWith("Digit")) return code.replace("Digit", "");
  if (code === "ArrowUp") return "Freccia Su";
  if (code === "ArrowDown") return "Freccia Giu";
  if (code === "ArrowLeft") return "Freccia Sinistra";
  if (code === "ArrowRight") return "Freccia Destra";
  if (code === "Space") return "Spazio";
  if (code === "Enter") return "Invio";
  if (code === "ShiftRight") return "Shift Dx";
  if (code === "ShiftLeft") return "Shift Sx";
  if (code === "Backspace") return "Backspace";
  return code;
}

function renderKeybindsUI() {
  if (!keybindContainer) return;
  keybindContainer.innerHTML = "";
  GBA_BUTTONS.forEach((b) => {
    const bind = userKeybinds[b.id] || { primary: b.defaultPrimary, secondary: b.defaultSecondary };

    const row = document.createElement("div");
    row.className = "keybind-row";

    const label = document.createElement("span");
    label.className = "keybind-label";
    label.innerText = b.label;

    const slotsContainer = document.createElement("div");
    slotsContainer.className = "keybind-slots";

    // Primary Slot
    const slotPrim = document.createElement("div");
    slotPrim.className = "keybind-slot";
    const badgePrim = document.createElement("span");
    badgePrim.className = "keybind-slot-badge";
    badgePrim.innerText = "Primario";
    const btnPrim = document.createElement("button");
    const isListeningPrim = listeningTarget && listeningTarget.buttonId === b.id && listeningTarget.slot === "primary";
    btnPrim.className = "keybind-btn" + (isListeningPrim ? " listening" : "");
    btnPrim.innerText = isListeningPrim ? "Premi un tasto..." : formatKeyCode(bind.primary);
    btnPrim.onclick = (e) => {
      e.stopPropagation();
      listeningTarget = isListeningPrim ? null : { buttonId: b.id, slot: "primary" };
      renderKeybindsUI();
    };
    slotPrim.appendChild(badgePrim);
    slotPrim.appendChild(btnPrim);

    // Secondary Slot
    const slotSec = document.createElement("div");
    slotSec.className = "keybind-slot";
    const badgeSec = document.createElement("span");
    badgeSec.className = "keybind-slot-badge";
    badgeSec.innerText = "Secondario";
    const btnSec = document.createElement("button");
    const isListeningSec = listeningTarget && listeningTarget.buttonId === b.id && listeningTarget.slot === "secondary";
    btnSec.className = "keybind-btn keybind-btn-secondary" + (isListeningSec ? " listening" : "");
    btnSec.innerText = isListeningSec ? "Premi un tasto..." : formatKeyCode(bind.secondary);
    btnSec.onclick = (e) => {
      e.stopPropagation();
      listeningTarget = isListeningSec ? null : { buttonId: b.id, slot: "secondary" };
      renderKeybindsUI();
    };
    slotSec.appendChild(badgeSec);
    slotSec.appendChild(btnSec);

    // Clear Button
    const clearBtn = document.createElement("button");
    clearBtn.className = "keybind-clear-btn";
    clearBtn.title = "Azzera comandi per questo tasto";
    clearBtn.innerText = "✕";
    clearBtn.onclick = (e) => {
      e.stopPropagation();
      userKeybinds[b.id] = { primary: "", secondary: "" };
      localStorage.setItem("gba_custom_keybinds_v3", JSON.stringify(userKeybinds));
      rebuildKeyLookup();
      listeningTarget = null;
      renderKeybindsUI();
    };

    slotsContainer.appendChild(slotPrim);
    slotsContainer.appendChild(slotSec);
    slotsContainer.appendChild(clearBtn);

    row.appendChild(label);
    row.appendChild(slotsContainer);
    keybindContainer.appendChild(row);
  });
}

function applyKeybindPreset(preset) {
  userKeybinds = JSON.parse(JSON.stringify(preset));
  localStorage.setItem("gba_custom_keybinds_v3", JSON.stringify(userKeybinds));
  rebuildKeyLookup();
  listeningTarget = null;
  renderKeybindsUI();
}

const presetRebit = document.getElementById("presetRebit");
if (presetRebit) {
  presetRebit.addEventListener("click", () => {
    applyKeybindPreset({
      UP: { primary: "ArrowUp", secondary: "KeyW" },
      DOWN: { primary: "ArrowDown", secondary: "KeyS" },
      LEFT: { primary: "ArrowLeft", secondary: "KeyA" },
      RIGHT: { primary: "ArrowRight", secondary: "KeyD" },
      A: { primary: "KeyZ", secondary: "KeyJ" },
      B: { primary: "KeyX", secondary: "KeyK" },
      START: { primary: "Enter", secondary: "KeyM" },
      SELECT: { primary: "ShiftRight", secondary: "ShiftLeft" },
      L: { primary: "KeyQ", secondary: "KeyU" },
      R: { primary: "KeyE", secondary: "KeyI" },
      SPEED: { primary: "Space", secondary: "Tab" },
    });
  });
}

const presetWasd = document.getElementById("presetWasd");
if (presetWasd) {
  presetWasd.addEventListener("click", () => {
    applyKeybindPreset({
      UP: { primary: "KeyW", secondary: "ArrowUp" },
      DOWN: { primary: "KeyS", secondary: "ArrowDown" },
      LEFT: { primary: "KeyA", secondary: "ArrowLeft" },
      RIGHT: { primary: "KeyD", secondary: "ArrowRight" },
      A: { primary: "KeyJ", secondary: "KeyZ" },
      B: { primary: "KeyK", secondary: "KeyX" },
      START: { primary: "Enter", secondary: "KeyM" },
      SELECT: { primary: "KeyU", secondary: "ShiftRight" },
      L: { primary: "KeyQ", secondary: "ShiftLeft" },
      R: { primary: "KeyE", secondary: "Backspace" },
      SPEED: { primary: "Space", secondary: "Tab" },
    });
  });
}

const presetNumpad = document.getElementById("presetNumpad");
if (presetNumpad) {
  presetNumpad.addEventListener("click", () => {
    applyKeybindPreset({
      UP: { primary: "Numpad8", secondary: "ArrowUp" },
      DOWN: { primary: "Numpad2", secondary: "ArrowDown" },
      LEFT: { primary: "Numpad4", secondary: "ArrowLeft" },
      RIGHT: { primary: "Numpad6", secondary: "ArrowRight" },
      A: { primary: "Numpad1", secondary: "KeyZ" },
      B: { primary: "Numpad3", secondary: "KeyX" },
      START: { primary: "NumpadEnter", secondary: "Enter" },
      SELECT: { primary: "Numpad0", secondary: "ShiftRight" },
      L: { primary: "Numpad7", secondary: "KeyQ" },
      R: { primary: "Numpad9", secondary: "KeyE" },
      SPEED: { primary: "Space", secondary: "Tab" },
    });
  });
}

const presetReset = document.getElementById("presetReset");
if (presetReset) {
  presetReset.addEventListener("click", () => {
    const defaults = {};
    GBA_BUTTONS.forEach((b) => {
      defaults[b.id] = { primary: b.defaultPrimary, secondary: b.defaultSecondary };
    });
    applyKeybindPreset(defaults);
  });
}

if (btnOpenKeybindsModal) {
  btnOpenKeybindsModal.addEventListener("click", () => {
    openModal(keybindsModal);
    renderKeybindsUI();
  });
}

if (btnCloseKeybindsModal) {
  btnCloseKeybindsModal.addEventListener("click", () => {
    closeModal(keybindsModal);
  });
}

// Modal and Link Cable Drawer Handlers
btnOpenNetplayModal.addEventListener("click", () => {
  openModal(netplayModal);
});

btnCloseNetplayModal.addEventListener("click", () => {
  closeModal(netplayModal);
});

tabHostBtn.addEventListener("click", () => {
  tabHostBtn.classList.add("active");
  tabJoinBtn.classList.remove("active");
  tabHostContent.style.display = "block";
  tabJoinContent.style.display = "none";
});

tabJoinBtn.addEventListener("click", () => {
  tabJoinBtn.classList.add("active");
  tabHostBtn.classList.remove("active");
  tabJoinContent.style.display = "block";
  tabHostContent.style.display = "none";
});

async function copyText(text, btn, label) {
  let ok = false;
  try {
    await navigator.clipboard.writeText(text);
    ok = true;
  } catch (e) {
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      ok = document.execCommand("copy");
      document.body.removeChild(ta);
    } catch (e2) {}
  }
  if (btn) {
    btn.innerText = ok ? "[OK] Copiato!" : "[!] Copia a mano";
    setTimeout(() => { btn.innerText = label; }, 2000);
  }
}

function extractRoomCode(input) {
  if (!input) return "";
  const str = input.trim();
  const linkMatch = str.match(/[#&?]room=([a-zA-Z0-9_-]+)/i);
  if (linkMatch && linkMatch[1]) return linkMatch[1].replace(/^gba[-_]?/i, "");
  const hashMatch = str.match(/#(?:room=)?([a-zA-Z0-9_-]+)/i);
  if (hashMatch && hashMatch[1]) return hashMatch[1].replace(/^gba[-_]?/i, "");
  const codeMatch = str.match(/(?:gba[-_]?)?([a-zA-Z0-9]+)/i);
  if (codeMatch && codeMatch[1]) return codeMatch[1];
  return str.replace(/[^a-zA-Z0-9]/g, "");
}

function closeP2PLink() {
  stopP2PHandshakeTimer();
  clearGuestJoinTimeout();
  if (activeP2PConn) {
    try { activeP2PConn.close(); } catch (e) {}
    activeP2PConn = null;
  }
  if (peer) {
    try { peer.destroy(); } catch (e) {}
    peer = null;
  }
}

function resetNetplayUi() {
  btnStartHosting.style.display = "block";
  hostWaitingArea.style.display = "none";
  if (btnHostConnect) btnHostConnect.disabled = true;
  btnJoinExistingRoom.style.display = "block";
  joinStatusArea.style.display = "none";
}

btnStartHosting.addEventListener("click", async () => {
  if (!window.romBytes) {
    showInGameNotice("[ROM] Carica prima il file .gba con il tasto '[ROM] Carica .gba' prima di creare la stanza!", 6000);
    return;
  }
  if (netplayConnected) {
    showInGameNotice("[AVVISO] Sei gia in una sessione online. Esci dal Cavo Link prima di crearne un'altra.", 5000);
    return;
  }
  netplayRoomSpeed = parseInt(document.getElementById("hostRoomSpeed").value, 10) || 1;

  const roomNum = Math.floor(1000 + Math.random() * 9000);
  currentRoomCode = `GBA-${roomNum}`;
  const peerId = `rebit-gba-${roomNum}`;

  btnStartHosting.style.display = "none";
  hostWaitingArea.style.display = "block";
  if (generatedRoomCode) generatedRoomCode.innerText = currentRoomCode;
  setNotice(hostStatusNotice, "Registrazione stanza online in corso...");

  closeP2PLink();

  try {
    peer = new Peer(peerId, {
      debug: 1,
      config: { iceServers: P2P_ICE_SERVERS }
    });

    peer.on("open", (id) => {
      console.log("[WebRTC Host] Stanza registrata con ID:", id);
      setNotice(hostStatusNotice, `Stanza [${currentRoomCode}] attiva! Invia il link al compagno: appena lo apre, la partita parte da sola.`);
    });

    peer.on("connection", (conn) => {
      console.log("[WebRTC Host] Compagno collegato! Apertura canale di gioco...");
      setNotice(hostStatusNotice, "Compagno entrato! Apertura canale di gioco...");
      setupDataConnection(conn, 1);
    });

    peer.on("error", (err) => {
      console.error("[WebRTC Host] Errore broker:", err);
      if (err.type === "unavailable-id") {
        showInGameNotice("[AVVISO] Codice stanza gia in uso. Ritento...", 2000);
        setTimeout(() => { if (!netplayConnected) btnStartHosting.click(); }, 500);
      } else {
        setNotice(hostStatusNotice, `[AVVISO P2P] ${err.type || 'Connessione al broker fallita'}.`, true);
      }
    });
  } catch (err) {
    console.warn("PeerJS init error:", err);
  }

  // Prepara anche il fallback token manuale offline
  try {
    if (typeof P2P !== "undefined" && P2P.P2PLink && hostOfferCode) {
      const manualLink = new P2P.P2PLink("host", P2P_ICE_SERVERS);
      window._manualHostLink = manualLink;
      hostOfferCode.value = "Generazione token offline...";
      manualLink.createOffer().then((off) => {
        hostOfferCode.value = off;
        if (btnHostConnect) btnHostConnect.disabled = false;
      }).catch(() => {});
    }
  } catch (e) {}
});

btnCopyRoomCode.addEventListener("click", () => {
  const code = (generatedRoomCode ? generatedRoomCode.innerText.trim() : "") || currentRoomCode;
  copyText(code, btnCopyRoomCode, "[Copia] Solo Codice");
});

if (btnCopyRoomLink) {
  btnCopyRoomLink.addEventListener("click", () => {
    const code = (generatedRoomCode ? generatedRoomCode.innerText.trim() : "") || currentRoomCode;
    const link = `${window.location.origin}${window.location.pathname}#room=${code}`;
    copyText(link, btnCopyRoomLink, "[Copia] Link Diretto (Invia al compagno)");
  });
}

if (btnHostConnect) {
  btnHostConnect.addEventListener("click", async () => {
    const text = hostAnswerInput ? hostAnswerInput.value.trim() : "";
    if (!text) {
      showInGameNotice("[AVVISO] Incolla prima il codice RISPOSTA del compagno.", 4000);
      return;
    }
    const manualLink = window._manualHostLink;
    if (!manualLink) return;
    try {
      await manualLink.acceptAnswer(text);
      btnHostConnect.disabled = true;
      setNotice(hostStatusNotice, "Risposta accettata. Negoziazione diretta P2P in corso...");
      setupDataConnection(manualLink, 1);
      manualLink.armTimeout(P2P_CONNECT_TIMEOUT_MS);
    } catch (err) {
      console.error("[WebRTC Host] Errore risposta manuale:", err);
      setNotice(hostStatusNotice, `[ERRORE] ${err.message || err}`, true);
    }
  });
}

btnJoinExistingRoom.addEventListener("click", async () => {
  if (!window.romBytes) {
    showInGameNotice("[ROM] Carica prima il file .gba con il tasto '[ROM] Carica .gba' prima di entrare!", 6000);
    return;
  }
  const rawInput = joinRoomCode.value.trim();
  if (!rawInput) {
    showInGameNotice("[AVVISO] Inserisci il codice della stanza (es: GBA-4821) o incolla il link!", 4000);
    return;
  }
  if (netplayConnected) {
    showInGameNotice("[AVVISO] Sei gia in una sessione online. Esci dal Cavo Link prima.", 5000);
    return;
  }

  // Se l'input e' un token manuale offline GBA1...
  if (rawInput.includes("GBA10") || rawInput.includes("GBA11") || rawInput.includes("#o=")) {
    btnJoinExistingRoom.style.display = "none";
    joinStatusArea.style.display = "block";
    setNotice(joinStatusNotice, "Generazione risposta manuale offline...");
    closeP2PLink();
    try {
      const link = new P2P.P2PLink("guest", P2P_ICE_SERVERS);
      peer = link;
      setupDataConnection(link, 2);
      const ans = await link.acceptOffer(rawInput);
      if (joinAnswerCode) joinAnswerCode.value = ans;
      link.armTimeout(P2P_CONNECT_TIMEOUT_MS + 20000);
      setNotice(joinStatusNotice, "Risposta pronta! Copiala e inviala all'Host per collegarvi.");
    } catch (err) {
      console.error("[WebRTC Guest] Errore token manuale:", err);
      setNotice(joinStatusNotice, `[ERRORE] ${err.message || err}`, true);
      btnJoinExistingRoom.style.display = "block";
    }
    return;
  }

  const normalizedNum = extractRoomCode(rawInput);
  if (!normalizedNum) {
    showInGameNotice("[AVVISO] Codice stanza non valido. Esempio: GBA-4821", 4000);
    return;
  }
  const targetPeerId = `rebit-gba-${normalizedNum}`;
  const displayCode = `GBA-${normalizedNum.toUpperCase()}`;

  btnJoinExistingRoom.style.display = "none";
  joinStatusArea.style.display = "block";
  setNotice(joinStatusNotice, `Ricerca stanza [${displayCode}] sul broker P2P...`);

  closeP2PLink();

  clearGuestJoinTimeout();
  guestJoinTimeoutTimer = setTimeout(() => {
    if (!netplayConnected) {
      console.warn("[WebRTC Guest] Timeout di 25s raggiunto.");
      setNotice(joinStatusNotice, `[ERRORE] Timeout: l'Host [${displayCode}] non risponde.\nVerifica che l'Host abbia la stanza aperta e clicca di nuovo su Entra.`, true);
      btnJoinExistingRoom.style.display = "block";
      stopP2PHandshakeTimer();
    }
  }, 25000);

  try {
    peer = new Peer({
      debug: 1,
      config: { iceServers: P2P_ICE_SERVERS }
    });

    peer.on("open", (myGuestId) => {
      console.log("[WebRTC Guest] Connessione a Host:", targetPeerId);
      setNotice(joinStatusNotice, `Host trovato! Negoziazione canale diretto P2P con [${displayCode}]...`);
      const conn = peer.connect(targetPeerId, { reliable: true });
      setupDataConnection(conn, 2);
    });

    peer.on("error", (err) => {
      console.error("[WebRTC Guest] Errore PeerJS:", err);
      clearGuestJoinTimeout();
      stopP2PHandshakeTimer();
      btnJoinExistingRoom.style.display = "block";
      if (err.type === "peer-unavailable") {
        setNotice(joinStatusNotice, `[ERRORE] Stanza [${displayCode}] non trovata!\nAssicurati che l'Host abbia premuto "Crea Stanza" e che il codice coincida.`, true);
      } else {
        setNotice(joinStatusNotice, `[ERRORE P2P] ${err.type || 'Impossibile raggiungere l\'Host'}`, true);
      }
    });
  } catch (err) {
    console.error("PeerJS guest error:", err);
    btnJoinExistingRoom.style.display = "block";
    setNotice(joinStatusNotice, `[ERRORE P2P] Inizializzazione fallita: ${err.message || err}`, true);
  }
});

if (btnCopyAnswerCode) {
  btnCopyAnswerCode.addEventListener("click", () => {
    if (joinAnswerCode) copyText(joinAnswerCode.value.trim(), btnCopyAnswerCode, "[Copia] Risposta Manuale");
  });
}

btnDisconnectNetplay.addEventListener("click", () => {
  closeP2PLink();
  netplayConnected = false;
  window.netplayConnected = false;
  consecutiveWaitTicks = 0;
  if (modeSelect) modeSelect.disabled = false;
  modeBadge.className = "badge";
  activeNetplayBanner.style.display = "none";
  resetNetplayUi();
  hideCanvasOverlay();
  showInGameNotice("[INFO] Disconnesso dal Cavo Link P2P. Ritorno alla modalita singolo.", 4000);
  startSinglePlayer(window.localSram);
});

modeSelect.addEventListener("change", (e) => {
  if (e.target.value === "dual") {
    startDualScreenCoop();
  } else {
    startSinglePlayer(window.localSram);
  }
});

const btnToggleScreenView = document.getElementById("btnToggleScreenView");

function setScreenView(view) {
  // If playing alone in single player, ALWAYS enforce single screen view!
  if (currentMode === "solo") {
    view = "solo";
  }
  netplayViewMode = view;
  if (view === "split") {
    canvas.width = GBA_WIDTH * 2;
    canvas.height = GBA_HEIGHT;
    canvas.style.width = "960px";
    canvas.style.height = "320px";
    if (btnToggleScreenView) {
      btnToggleScreenView.innerText = "[O] Vista: Split-Screen";
      btnToggleScreenView.style.display = currentMode === "solo" ? "none" : "inline-flex";
    }
  } else {
    canvas.width = GBA_WIDTH;
    canvas.height = GBA_HEIGHT;
    canvas.style.width = "720px";
    canvas.style.height = "480px";
    if (btnToggleScreenView) {
      btnToggleScreenView.innerText = "[O] Vista: Singolo";
      btnToggleScreenView.style.display = currentMode === "solo" ? "none" : "inline-flex";
    }
  }
}

if (btnToggleScreenView) {
  btnToggleScreenView.addEventListener("click", () => {
    if (currentMode === "solo") {
      setScreenView("solo");
      btnToggleScreenView.style.display = "none";
      return;
    }
    const nextView = netplayViewMode === "solo" ? "split" : "solo";
    setScreenView(nextView);
  });
}

function checkUrlHashForRoom() {
  const hash = window.location.hash || "";
  // 1-Click automatico: #room=GBA-XXXX oppure #GBA-XXXX oppure #room=XXXX
  const mAuto = hash.match(/[#&?]room=([a-zA-Z0-9_-]+)/i) || hash.match(/[#&?](GBA-[a-zA-Z0-9_-]+)/i);
  if (mAuto) {
    const raw = mAuto[1];
    const num = extractRoomCode(raw);
    if (num) {
      const fullCode = `GBA-${num.toUpperCase()}`;
      if (joinRoomCode) joinRoomCode.value = fullCode;
      if (tabJoinBtn) tabJoinBtn.click();
      netplayModal.style.display = "flex";
      if (!window.romBytes) {
        showInGameNotice(`[P2P] Stanza [${fullCode}] rilevata dal link! Carica la ROM con '[ROM] Carica .gba' e sarai subito connesso!`, 9000);
      } else {
        showInGameNotice(`[P2P] Stanza [${fullCode}] rilevata! Connessione automatica in corso...`, 5000);
        setTimeout(() => {
          if (!netplayConnected && window.romBytes && btnJoinExistingRoom) {
            btnJoinExistingRoom.click();
          }
        }, 300);
      }
      return;
    }
  }

  // Fallback link manuale offline: #o=GBA1...
  const mManual = hash.match(/[#&]o=(GBA1[01][A-Za-z0-9_-]+)/);
  if (mManual) {
    if (joinRoomCode) joinRoomCode.value = mManual[1];
    if (tabJoinBtn) tabJoinBtn.click();
    netplayModal.style.display = "flex";
    showInGameNotice("[P2P] Invito offline rilevato dal link! Carica la ROM, poi premi [Entra].", 9000);
  }
}

// ROM caricata automaticamente all'avvio. Vuoto = nessun download (consigliato su GitHub Pages).
// Esempio: "./roms/MiaRom.gba" (solo se la ROM e' davvero nel repository).
const DEFAULT_ROM_URL = "";

// App Initialization
async function initCore() {
  try {
    loadingText.innerText = "Caricamento mGBA WebAssembly...";
    window.Module = await createMGBAModule({
      locateFile: (path) => {
        if (path.endsWith(".wasm")) return "./cores/mgba_dual_libretro.wasm";
        return "./cores/" + path;
      },
    });
    console.log("mGBA WebAssembly module initialized successfully!");

    // ROM di default (opzionale). Su GitHub Pages la cartella roms/ normalmente NON esiste:
    // lasciando DEFAULT_ROM_URL vuoto si evita una richiesta che darebbe 404.
    if (DEFAULT_ROM_URL) {
      try {
        loadedRomName = DEFAULT_ROM_URL.split("/").pop();
        loadedRomBaseName = loadedRomName.replace(/\.[^/.]+$/, "");
        window.romBytes = await fetchRomWithProgress(DEFAULT_ROM_URL);
        romBadge.innerText = `ROM: ${loadedRomName}`;
      } catch (err) {
        console.warn(`Default ROM not found at ${DEFAULT_ROM_URL}`, err);
        romBadge.innerText = "ROM: Seleziona .gba";
        showInGameNotice("[ROM] Nessuna ROM predefinita trovata. Carica una ROM con il tasto [ROM] Carica .gba", 8000);
      }
    } else {
      romBadge.innerText = "ROM: Seleziona .gba";
      showInGameNotice("[ROM] Carica la tua ROM con il tasto [ROM] Carica .gba per iniziare.", 8000);
    }

    // Load Save from localStorage if present
    window.localSram = loadSavedSram();

    if (window.romBytes) {
      loadingText.innerText = "Avvio Emulazione GBA...";
      startSinglePlayer(window.localSram);
    }

    loadingOverlay.style.display = "none";
    lastRafTime = performance.now();
    lastPumpTime = lastRafTime;
    requestAnimationFrame(mainRafLoop);
    if (timerWorker) {
      timerWorker.postMessage({ action: "start", interval: 16 });
    }

    checkUrlHashForRoom();
  } catch (err) {
    loadingText.innerText = "Errore di avvio!";
    loadingDetail.innerText = err.message;
    console.error(err);
  }
}

window.gbaDebug = {
  getFrame: () => totalFramesSimulated,
  getFps: () => window.lastReportedFps || 0,
  getCanvasData: () => canvas.toDataURL("image/png"),
  isConnected: () => netplayConnected,
  getMode: () => currentMode,
  getPlayerId: () => myPlayerId,
  getRoomCode: () => currentRoomCode,
  getPeer: () => peer,
  getActiveConn: () => activeP2PConn,
  getCurrentKeys: () => currentKeys,
};

window.addEventListener("load", initCore);
