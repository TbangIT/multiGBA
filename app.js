// Rebit mGBA Online - WebRTC P2P Netplay Driver (GitHub Pages Edition)
// Full implementation with Save Management (.sav / SRAM) and 2-Player Link Cable via direct WebRTC DataChannel (PeerJS + STUN/TURN).

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

let gridImageData = ctx.createImageData(GBA_WIDTH * 2, GBA_HEIGHT * 2);
let gridPixels = new Uint32Array(gridImageData.data.buffer);

function updateCanvasAspectRatio(aspectOrMode) {
  let targetMode = aspectOrMode;
  if (!targetMode) {
    if (typeof currentMode !== "undefined" && currentMode === "dual") {
      targetMode = "split";
    } else if (typeof currentMode !== "undefined" && currentMode === "netplay") {
      targetMode = (typeof netplayViewMode !== "undefined" && netplayViewMode) ? netplayViewMode : "solo";
    } else {
      targetMode = "solo";
    }
  }

  let ratio = "3 / 2";
  let ratioVal = 1.5;
  if (targetMode === "split" || targetMode === "dual" || targetMode === "3 / 1") {
    ratio = "3 / 1";
    ratioVal = 3.0;
  } else if (targetMode === "grid" || targetMode === "480 / 320") {
    ratio = "3 / 2";
    ratioVal = 1.5;
  } else {
    ratio = "3 / 2";
    ratioVal = 1.5;
  }
  if (canvas) {
    canvas.style.removeProperty("width");
    canvas.style.removeProperty("height");
    canvas.style.width = "";
    canvas.style.height = "";
    canvas.style.setProperty("--gba-aspect-ratio", ratio);
    canvas.style.setProperty("--gba-ratio-num", String(ratioVal));
  }
  const wrapper = document.getElementById("screenWrapper");
  if (wrapper) {
    wrapper.style.removeProperty("width");
    wrapper.style.removeProperty("height");
    wrapper.style.setProperty("--gba-aspect-ratio", ratio);
    wrapper.style.setProperty("--gba-ratio-num", String(ratioVal));
  }
  document.documentElement.style.setProperty("--gba-aspect-ratio", ratio);
  document.documentElement.style.setProperty("--gba-ratio-num", String(ratioVal));
}
window.updateCanvasAspectRatio = updateCanvasAspectRatio;
updateCanvasAspectRatio("solo");

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
const generatedRoomCode = document.getElementById("generatedRoomCode");
const btnCopyRoomCode = document.getElementById("btnCopyRoomCode");
const btnCopyRoomLink = document.getElementById("btnCopyRoomLink");
const hostStatusNotice = document.getElementById("hostStatusNotice");
const btnHostStartGame = document.getElementById("btnHostStartGame");
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
  // In rete i due PC non devono divergere di velocita': la correzione e' ridotta a +-0.3%.
  if (currentMode === "netplay") target = 1 + (target - 1) * 0.3;
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
  // A blocchi: molto piu' veloce del vecchio ciclo byte-per-byte (niente maxi-stringhe intermedie).
  const parts = [];
  for (let i = 0; i < bytes.byteLength; i += 0x8000) {
    parts.push(String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000)));
  }
  return window.btoa(parts.join(""));
}


// Esegue un lavoro pesante (salvataggi) quando il thread e' libero, non nel mezzo di un frame.
function deferHeavyWork(fn) {
  const run = () => { try { fn(); } catch (e) { console.warn("[deferred]", e); } };
  if (typeof window.requestIdleCallback === "function") window.requestIdleCallback(run, { timeout: 3000 });
  else setTimeout(run, 50);
}

// Firma veloce (FNV-1a su parole da 32 bit) per capire se un blocco di byte e' cambiato.
let lastSavedSramSig = null;
function quickSig(bytes) {
  const n = bytes.byteLength >> 2;
  const w = new Uint32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + n * 4));
  let h = 0x811c9dc5;
  for (let i = 0; i < n; i++) h = Math.imul(h ^ w[i], 0x01000193);
  return h + ":" + bytes.byteLength;
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

// WASM Memory Pointers (Up to 4 Cores)
let rom1Ptr = 0, rom2Ptr = 0, rom3Ptr = 0, rom4Ptr = 0;
let sram1Ptr = 0, sram2Ptr = 0, sram3Ptr = 0, sram4Ptr = 0;

function freeAllocatedPointers() {
  if (!window.Module) return;
  try {
    if (typeof window.Module._mgba_demo_destroy === "function") {
      window.Module._mgba_demo_destroy();
    }
  } catch (e) {
    console.warn("mgba_demo_destroy notice:", e);
  }
  if (rom1Ptr) { try { window.Module._free(rom1Ptr); } catch(e) {} rom1Ptr = 0; }
  if (rom2Ptr) { try { window.Module._free(rom2Ptr); } catch(e) {} rom2Ptr = 0; }
  if (rom3Ptr) { try { window.Module._free(rom3Ptr); } catch(e) {} rom3Ptr = 0; }
  if (rom4Ptr) { try { window.Module._free(rom4Ptr); } catch(e) {} rom4Ptr = 0; }
  if (sram1Ptr) { try { window.Module._free(sram1Ptr); } catch(e) {} sram1Ptr = 0; }
  if (sram2Ptr) { try { window.Module._free(sram2Ptr); } catch(e) {} sram2Ptr = 0; }
  if (sram3Ptr) { try { window.Module._free(sram3Ptr); } catch(e) {} sram3Ptr = 0; }
  if (sram4Ptr) { try { window.Module._free(sram4Ptr); } catch(e) {} sram4Ptr = 0; }
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
  updateCanvasAspectRatio("solo");
  modeBadge.innerText = "Modalita: Singolo (P1)";
  currentMode = "solo";
  netplayPlayerCount = 1;
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
  updateCanvasAspectRatio("dual");
  modeBadge.innerText = "Modalita: Dual Co-Op Link (P1 + P2)";
  currentMode = "dual";
  netplayPlayerCount = 2;
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

// Boot Synchronized Online Netplay Multi-Core with exchanged saves (2, 3, or 4 players)
function startNetplayMultiCore(sramListOrHostSram, arg2, arg3, arg4) {
  if (!window.Module || !window.romBytes) return;
  freeAllocatedPointers();

  let sramList = [];
  let localPlayerId = 1;
  let totalPlayers = 2;
  let viewMode = "solo";

  if (arg2 instanceof Uint8Array || (typeof arg2 === "object" && arg2 !== null && !Number.isInteger(arg2))) {
    // Legacy 2-player signature: startNetplayMultiCore(hostSram, guestSram, localPlayerId, viewMode)
    sramList = [sramListOrHostSram, arg2];
    localPlayerId = arg3 || 1;
    totalPlayers = 2;
    viewMode = arg4 || "solo";
  } else {
    // New multi-player signature: startNetplayMultiCore(sramList, localPlayerId, totalPlayers, viewMode)
    sramList = sramListOrHostSram;
    localPlayerId = arg2 || 1;
    totalPlayers = arg3 || 2;
    viewMode = arg4 || "solo";
  }

  netplayPlayerCount = totalPlayers;
  myPlayerId = localPlayerId;
  remotePlayerId = localPlayerId === 1 ? 2 : 1;
  currentMode = "netplay";

  // Active players set
  connectedPlayerIds = new Set();
  for (let p = 1; p <= totalPlayers; p++) {
    connectedPlayerIds.add(p);
  }

  remotePlayerInputs = { 1: {}, 2: {}, 3: {}, 4: {} };
  remotePlayerMaxFrame = { 1: -1, 2: -1, 3: -1, 4: -1 };

  const romSize = window.romBytes.byteLength;
  rom1Ptr = window.Module._malloc(romSize);
  window.Module.HEAPU8.set(window.romBytes, rom1Ptr);

  rom2Ptr = window.Module._malloc(romSize);
  window.Module.HEAPU8.set(window.romBytes, rom2Ptr);

  if (totalPlayers >= 3) {
    rom3Ptr = window.Module._malloc(romSize);
    window.Module.HEAPU8.set(window.romBytes, rom3Ptr);
  } else {
    rom3Ptr = 0;
  }

  if (totalPlayers >= 4) {
    rom4Ptr = window.Module._malloc(romSize);
    window.Module.HEAPU8.set(window.romBytes, rom4Ptr);
  } else {
    rom4Ptr = 0;
  }

  const getSave = (idx) => {
    let s = null;
    if (Array.isArray(sramList)) {
      s = sramList[idx - 1];
    } else if (sramList && typeof sramList === "object") {
      s = sramList[idx];
    }
    if (s && s.length === SRAM_SIZE) return s;
    const blank = new Uint8Array(SRAM_SIZE);
    blank.fill(0xff);
    return blank;
  };

  sram1Ptr = window.Module._malloc(SRAM_SIZE);
  window.Module.HEAPU8.set(getSave(1), sram1Ptr);

  sram2Ptr = window.Module._malloc(SRAM_SIZE);
  window.Module.HEAPU8.set(getSave(2), sram2Ptr);

  if (totalPlayers >= 3) {
    sram3Ptr = window.Module._malloc(SRAM_SIZE);
    window.Module.HEAPU8.set(getSave(3), sram3Ptr);
  } else {
    sram3Ptr = 0;
  }

  if (totalPlayers >= 4) {
    sram4Ptr = window.Module._malloc(SRAM_SIZE);
    window.Module.HEAPU8.set(getSave(4), sram4Ptr);
  } else {
    sram4Ptr = 0;
  }

  if (btnToggleScreenView) btnToggleScreenView.style.display = "inline-flex";
  setScreenView(viewMode || "solo");

  if (window.Module && typeof window.Module._mgba_demo_audio_clear === "function") {
    for (let c = 0; c < 4; c++) {
      try { window.Module._mgba_demo_audio_clear(c); } catch(e) {}
    }
  }
  audioReset();

  modeBadge.innerText = `Online: P${myPlayerId}/${totalPlayers} (${netplayRoomSpeed}x Speed - P2P)`;
  modeBadge.className = "badge active";

  const res = window.Module._mgba_demo_load_game_multi(
    rom1Ptr, romSize,
    rom2Ptr, romSize,
    rom3Ptr, rom3Ptr ? romSize : 0,
    rom4Ptr, rom4Ptr ? romSize : 0,
    sram1Ptr, SRAM_SIZE,
    sram2Ptr, SRAM_SIZE,
    sram3Ptr, sram3Ptr ? SRAM_SIZE : 0,
    sram4Ptr, sram4Ptr ? SRAM_SIZE : 0,
    totalPlayers, -1
  );
  console.log(`startNetplayMultiCore (Player ${myPlayerId}/${totalPlayers}) load_game_multi returned:`, res);

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
  netResetAdaptiveState();
  for (let f = 0; f < NET_DELAY_INITIAL; f++) {
    localInputByFrame[f] = 0;
    remoteInputHistory[f] = 0;
    for (let p = 1; p <= 4; p++) {
      remotePlayerInputs[p][f] = 0;
    }
  }

  if (modeSelect) modeSelect.disabled = true;
  isRunning = !netHoldStart;   // in attesa del "go": nessuno parte prima che tutti abbiano caricato
  if (netHoldStart) showCanvasOverlay("[...]", "Avvio sincronizzato...", "In attesa che tutti i giocatori carichino il gioco", "Partenza simultanea per tutti", null, true);
}

// Barriera di avvio. Prima l'host partiva subito e restava in stallo mentre i guest ricevevano ~700 KB di
// salvataggi e caricavano 4 ROM: oltre 10 s = "connessione persa". Ora tutti caricano in pausa, poi "go".
function netGo() {
  if (isRunning) return;
  lastPumpTime = performance.now(); pumpDebtMs = 0;
  hideCanvasOverlay();
  isRunning = true;
}
function netHostTryGo(force) {
  if (!netHostLoaded || netGoSent) return;
  if (!force && !Object.values(connectedGuests).every((g) => g.coreReady)) return;
  netGoSent = true; clearTimeout(netGoTimer);
  for (const [slot, g] of Object.entries(connectedGuests)) {
    if (!g.coreReady) handleGuestDisconnect(parseInt(slot, 10));   // troppo lento: non blocca gli altri
  }
  broadcastToGuests({ type: "go" });
  let half = 0;
  for (const x of netPeerRtt.values()) half = Math.max(half, x.rtt / 2);
  setTimeout(netGo, Math.min(half, 150));   // l'host parte quando il "go" arriva ai guest
}

// Frame Timing and Animation Loop
let frameCount = 0;              // passi di EMULAZIONE (a 2x sono 120/s)
let renderCount = 0, lastRenderAt = 0;
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


window.gbaNetDebug = () => ({
  delayFrames: netInputDelay,
  delayMs: Math.round(netInputDelay * GBA_FRAME_MS),
  rttMs: Math.round(netRttMs), rttMinMs: Math.round(netRttMin), jitterMs: Math.round(netRttDev),
  samples: netRttSamples, hostDelay: netHostDelay,
  peers: [...netPeerRtt.values()].map((x) => ({ rtt: Math.round(x.rtt), jitter: Math.round(x.dev) })),
  // se emuMs si avvicina a 16.7 il collo di bottiglia e' la CPU, non la rete
  cpuLoadPct: Math.round(netCpuLoad * 100), fastBroken: netFastBroken,
  callsPerStep: coreStepsTotal ? +(coreCallsTotal / coreStepsTotal).toFixed(2) : null,   // ~1.5 = il bug del 65% era attivo
  emuMs: +netEmuMs.toFixed(1), cpuPct: Math.round(netEmuMs / GBA_FRAME_MS * 100),
  stalls: netStallCount, stallMsTotal: Math.round(netStallMsTotal), stallMsMax: Math.round(netStallMsMax),
  frame: totalFramesSimulated, maxRemoteFrame,
});

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

// run_frame avanza ~0.65 frame per chiamata con giochi reali (misurato in v2.6): contarla come "1 frame"
// fa girare il gioco al ~65% (e audio a scatti). Si richiama finche' il contatore del core 0 avanza.
// Core 0 per TUTTI i client: il numero di chiamate dipende solo dallo stato emulato, quindi resta deterministico.
let coreCallsTotal = 0, coreStepsTotal = 0;
function stepCoreOneFrame() {
  const M = window.Module;
  if (!M) return 1;
  const getF = M._mgba_demo_get_frame;
  const eq = M._mgba_demo_equalize_frames;
  if (!coreFrameCounterReliable || typeof getF !== "function") {
    M._mgba_demo_run_frame();
    if (typeof eq === "function") eq();
    return 1;
  }
  const f0 = getF(0);
  let calls = 0;
  do {
    M._mgba_demo_run_frame();
    if (typeof eq === "function") eq();
    calls++;
  } while (getF(0) === f0 && calls < CORE_MAX_CALLS_PER_FRAME);
  coreCallsTotal += calls; coreStepsTotal++;
  if (getF(0) === f0) { if (++coreFrameCounterStuck > 120) coreFrameCounterReliable = false; }  // contatore inutilizzabile: si torna a 1 chiamata
  else coreFrameCounterStuck = 0;
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

  const extraCatchup = (currentMode === "netplay" && maxRemoteFrame > totalFramesSimulated + netInputDelay) ? 1 : 0;
  const maxSteps = 6 * speed + extraCatchup; // fino a ~100 ms di recupero dopo uno stallo

  let steps = 0, waitingPeer = false;
  const sliceStart = performance.now();
  while (pumpDebtMs >= GBA_FRAME_MS && steps < maxSteps) {
    const r = runSingleSimulationFrame();   // 1 = avanzato, 0 = fermo, -1 = in attesa del compagno
    if (r === 0) {
      pumpDebtMs = 0;
      break;
    }
    if (r < 0) { waitingPeer = true; break; }   // in attesa: il tempo "dovuto" NON si butta, si recupera dopo
    pumpDebtMs -= GBA_FRAME_MS;
    steps++;
    if (performance.now() - sliceStart > 11) break;   // CPU satura: recupero spalmato sui frame successivi, non a raffica
  }

  // Restano passi da fare, non si aspetta nessuno e il tempo e' finito: e' la CPU che non regge (non la rete)
  if (!waitingPeer && pumpDebtMs >= GBA_FRAME_MS) perf.behind();

  if (currentMode === "netplay") {
    const cap = GBA_FRAME_MS * (netInputDelay + 4);
    if (pumpDebtMs > cap) pumpDebtMs = cap;
  } else if (pumpDebtMs > GBA_FRAME_MS * 3) {
    pumpDebtMs = GBA_FRAME_MS;
  }

  audioFlush();
  return steps;
}

function runSingleSimulationFrame() {
  if (!isRunning || !window.Module) return 0;

  // 1. Controller Inputs & Netplay Lockstep
  if (currentMode === "netplay" && netplayConnected) {
    const targetFrame = totalFramesSimulated + netInputDelay;
    for (let fr = netLastScheduled + 1; fr <= targetFrame; fr++) {
      localInputByFrame[fr] = currentKeys;
      localInputHistory.push({ frame: fr, keys: currentKeys });
    }
    if (targetFrame > netLastScheduled) netLastScheduled = targetFrame;
    while (localInputHistory.length > 80) localInputHistory.shift();

    // Pacchetto con la storia degli ultimi 64 frame (a 2x serve piu' storia: i delay di due giocatori si sommano).
    // A 2x se ne invia uno ogni 2 passi (sempre se si e' fermi in attesa): la storia copre il frame saltato, meta' pacchetti e CPU.
    if (netSpeed() === 1 || (totalFramesSimulated & 1) === 0 || netStalling) {
      const gbrb = packGbrbInput(myPlayerId, netLastScheduled, localInputHistory);
      const rbal = packRbalFrame(0, gbrb);
      if (myPlayerId === 1) {
        for (const guest of Object.values(connectedGuests)) if (guest) netSend(guest.conn, rbal);
      } else {
        netSend(activeP2PConn, rbal);
      }
    }

    // Strict Lockstep Check: Do we have all active remote players' inputs for totalFramesSimulated?
    let missingPlayer = null;
    for (const pid of connectedPlayerIds) {
      if (pid === myPlayerId) continue;
      if (!remotePlayerInputs[pid] || !(totalFramesSimulated in remotePlayerInputs[pid])) {
        missingPlayer = pid;
        break;
      }
    }

    if (missingPlayer !== null) {
      const nowMs = performance.now();
      if (!netStalling) {
        netStalling = true;
        netStallStart = nowMs;
        netStallCount++;
        perf.stallBegin(missingPlayer);
        netNoteStall(nowMs);
      }
      const waited = nowMs - netStallStart;
      if (waited >= 400 && netOverlayHideTimer) { clearTimeout(netOverlayHideTimer); netOverlayHideTimer = null; }   // i micro-stalli non tengono acceso l'overlay
      // silenzio = tempo senza ricevere NULLA da quel giocatore. Un PC lento ma vivo non e' una connessione persa.
      const silent = nowMs - Math.max(netPeerSeen[missingPlayer] || 0, netStallStart);
      consecutiveWaitTicks++;
      if (waited > 2000) netFastFallback(true);
      if (silent >= NET_EMERGENCY_AFTER_MS) {
        activateEmergencyRecoveryMode(`Compagno P${missingPlayer} non risponde da oltre 3s!`);
      }
      if (silent > NET_LOST_AFTER_MS || waited > 30000) {
        if (netOverlayLevel !== 2) {
          netOverlayLevel = 2;
          showCanvasOverlay(
            "[!]",
            "Connessione Interrotta",
            `Nessun pacchetto ricevuto dal Giocatore ${missingPlayer} da oltre 10s`,
            "Clicca su '[!] Recupera Sessione' in alto per continuare in singolo senza perdere progressi!",
            () => recoverSessionToSinglePlayer()
          );
        }
      } else if (waited >= NET_OVERLAY_AFTER_MS && netOverlayLevel !== 1) {
        netOverlayLevel = 1;
        showCanvasOverlay(
          "[...]",
          "Sincronizzazione Rete...",
          silent < 1500 ? `Il Giocatore ${missingPlayer} sta rallentando la partita (PC o rete lenti)...` : `In attesa dei pacchetti del Giocatore ${missingPlayer}...`,
          "La simulazione riprenderà automaticamente non appena arrivano i dati"
        );
      }
      return -1; // Wait until peer input arrives
    }

    if (netStalling) {
      const dur = performance.now() - netStallStart;
      perf.stallEnd(dur);
      netStallMsTotal += dur;
      if (dur > netStallMsMax) netStallMsMax = dur;
      netStalling = false;
      if (netOverlayLevel !== 0 && !netOverlayHideTimer) {
        netOverlayHideTimer = setTimeout(() => {   // sparisce solo dopo 0,8 s di gioco fluido
          netOverlayHideTimer = null;
          if (!netStalling) { netOverlayLevel = 0; hideCanvasOverlay(); }
        }, 800);
      }
    }
    consecutiveWaitTicks = 0;

    // Margine = quanti frame di input remoto ho "in anticipo". ~0 = rete al limite, alto = rete con ampio respiro
    let marginFr = Infinity;
    for (const pid of connectedPlayerIds) if (pid !== myPlayerId) marginFr = Math.min(marginFr, remotePlayerMaxFrame[pid] - totalFramesSimulated);
    if (isFinite(marginFr)) perf.margin(marginFr);

    for (let c = 0; c < netplayPlayerCount; c++) {
      const pid = c + 1;
      let keys = 0;
      if (pid === myPlayerId) {
        keys = localInputByFrame[totalFramesSimulated] !== undefined ? localInputByFrame[totalFramesSimulated] : 0;
      } else if (remotePlayerInputs[pid] && remotePlayerInputs[pid][totalFramesSimulated] !== undefined) {
        keys = remotePlayerInputs[pid][totalFramesSimulated];
      } else {
        keys = 0;
      }
      window.Module._mgba_demo_set_keys(c, keys);
    }

    delete localInputByFrame[totalFramesSimulated - 60];
    for (let p = 1; p <= 4; p++) {
      if (remotePlayerInputs[p]) delete remotePlayerInputs[p][totalFramesSimulated - 60];
    }
  } else if (currentMode === "dual") {
    window.Module._mgba_demo_set_keys(0, currentKeys);
    window.Module._mgba_demo_set_keys(1, p2Keys);
  } else {
    window.Module._mgba_demo_set_keys(0, currentKeys);
    window.Module._mgba_demo_set_keys(1, 0);
  }

  // 2. Step GBA Emulation: avanzamento deterministico 1:1 con sincronizzazione SIO hardware
  const emuT0 = performance.now();
  const emuCalls = stepCoreOneFrame();
  const emuDt = performance.now() - emuT0;
  netEmuMs = netEmuMs ? netEmuMs * 0.95 + emuDt * 0.05 : emuDt;
  perf.step(emuDt, emuCalls, currentKeys !== 0);
  totalFramesSimulated++;
  frameCount++;

  // 3. Audio del core -> motore audio (ascolta il proprio giocatore)
  const localCoreIdx = currentMode === "netplay" ? (myPlayerId - 1) : 0;
  audioDrainCore(localCoreIdx);
  if (currentMode === "netplay") {
    for (let c = 0; c < netplayPlayerCount; c++) {
      if (c !== localCoreIdx && typeof window.Module._mgba_demo_audio_clear === "function") {
        try { window.Module._mgba_demo_audio_clear(c); } catch(e) {}
      }
    }
  }

  // 4. Auto-save check every ~15 seconds (.sav Flash SRAM)
  if (totalFramesSimulated > 0 && totalFramesSimulated % 900 === 0) {
    const sramIdx = currentMode === "netplay" ? (myPlayerId - 1) : 0;
    deferHeavyWork(() => {
      const sram = exportCurrentSram(sramIdx);
      if (sram && sram.length > 0 && !isSramEmpty(sram)) {
        const sig = quickSig(sram);
        if (sig === lastSavedSramSig) return;
        window.localSram = sram;
        if (saveSramToBrowserStorage(loadedRomBaseName, sram)) lastSavedSramSig = sig;
      }
    });
  }

  // 5. Emergency Auto-Savestate every ~45 seconds
  const nowWall = Date.now();
  if (totalFramesSimulated > 0 && nowWall - lastAutoSavestateWallClock >= 45000) {
    lastAutoSavestateWallClock = nowWall;
    deferHeavyWork(() => {
      createEmergencySavestate(true);
    });
  }

  return 1;
}

function renderCanvasOnly() {
  if (currentMode === "dual" || (currentMode === "netplay" && netplayViewMode === "split")) {
    const p1FbPtr = window.Module._mgba_demo_get_framebuffer(0);
    const p2FbPtr = window.Module._mgba_demo_get_framebuffer(1);
    const stride0 = (window.Module._mgba_demo_get_stride && window.Module._mgba_demo_get_stride(0)) || GBA_WIDTH;
    const stride1 = (window.Module._mgba_demo_get_stride && window.Module._mgba_demo_get_stride(1)) || GBA_WIDTH;
    const totalWidth = GBA_WIDTH * 2;

    if (p1FbPtr && p2FbPtr && dualPixels) {
      const p1View = new Uint32Array(window.Module.HEAPU8.buffer, p1FbPtr, stride0 * GBA_HEIGHT);
      const p2View = new Uint32Array(window.Module.HEAPU8.buffer, p2FbPtr, stride1 * GBA_HEIGHT);

      for (let y = 0; y < GBA_HEIGHT; y++) {
        const src1Row = y * stride0;
        const src2Row = y * stride1;
        const dstRow = y * totalWidth;
        for (let x = 0; x < GBA_WIDTH; x++) {
          dualPixels[dstRow + x] = p1View[src1Row + x] | 0xFF000000;
        }
        for (let x = 0; x < GBA_WIDTH; x++) {
          dualPixels[dstRow + GBA_WIDTH + x] = p2View[src2Row + x] | 0xFF000000;
        }
      }
      ctx.putImageData(dualImageData, 0, 0);
    }
  } else if (currentMode === "netplay" && netplayViewMode === "grid") {
    const totalW = GBA_WIDTH * 2;
    const p1Fb = window.Module._mgba_demo_get_framebuffer(0);
    const p2Fb = window.Module._mgba_demo_get_framebuffer(1);
    const p3Fb = (netplayPlayerCount >= 3 && window.Module._mgba_demo_get_framebuffer) ? window.Module._mgba_demo_get_framebuffer(2) : 0;
    const p4Fb = (netplayPlayerCount >= 4 && window.Module._mgba_demo_get_framebuffer) ? window.Module._mgba_demo_get_framebuffer(3) : 0;
    const s0 = (window.Module._mgba_demo_get_stride && window.Module._mgba_demo_get_stride(0)) || GBA_WIDTH;
    const s1 = (window.Module._mgba_demo_get_stride && window.Module._mgba_demo_get_stride(1)) || GBA_WIDTH;
    const s2 = (window.Module._mgba_demo_get_stride && window.Module._mgba_demo_get_stride(2)) || GBA_WIDTH;
    const s3 = (window.Module._mgba_demo_get_stride && window.Module._mgba_demo_get_stride(3)) || GBA_WIDTH;

    const v0 = p1Fb ? new Uint32Array(window.Module.HEAPU8.buffer, p1Fb, s0 * GBA_HEIGHT) : null;
    const v1 = p2Fb ? new Uint32Array(window.Module.HEAPU8.buffer, p2Fb, s1 * GBA_HEIGHT) : null;
    const v2 = p3Fb ? new Uint32Array(window.Module.HEAPU8.buffer, p3Fb, s2 * GBA_HEIGHT) : null;
    const v3 = p4Fb ? new Uint32Array(window.Module.HEAPU8.buffer, p4Fb, s3 * GBA_HEIGHT) : null;

    if (gridPixels) {
      // Top half: Core 0 (P1) and Core 1 (P2)
      for (let y = 0; y < GBA_HEIGHT; y++) {
        const dstRow = y * totalW;
        const src0 = y * s0;
        const src1 = y * s1;
        if (v0) {
          for (let x = 0; x < GBA_WIDTH; x++) gridPixels[dstRow + x] = v0[src0 + x] | 0xFF000000;
        } else {
          for (let x = 0; x < GBA_WIDTH; x++) gridPixels[dstRow + x] = 0xFF18181B;
        }
        if (v1) {
          for (let x = 0; x < GBA_WIDTH; x++) gridPixels[dstRow + GBA_WIDTH + x] = v1[src1 + x] | 0xFF000000;
        } else {
          for (let x = 0; x < GBA_WIDTH; x++) gridPixels[dstRow + GBA_WIDTH + x] = 0xFF18181B;
        }
      }
      // Bottom half: Core 2 (P3) and Core 3 (P4)
      for (let y = 0; y < GBA_HEIGHT; y++) {
        const dstRow = (y + GBA_HEIGHT) * totalW;
        const src2 = y * s2;
        const src3 = y * s3;
        if (v2) {
          for (let x = 0; x < GBA_WIDTH; x++) gridPixels[dstRow + x] = v2[src2 + x] | 0xFF000000;
        } else {
          for (let x = 0; x < GBA_WIDTH; x++) gridPixels[dstRow + x] = 0xFF18181B;
        }
        if (v3) {
          for (let x = 0; x < GBA_WIDTH; x++) gridPixels[dstRow + GBA_WIDTH + x] = v3[src3 + x] | 0xFF000000;
        } else {
          for (let x = 0; x < GBA_WIDTH; x++) gridPixels[dstRow + GBA_WIDTH + x] = 0xFF18181B;
        }
      }
      ctx.putImageData(gridImageData, 0, 0);
    }
  } else {
    // Solo view: render ONLY the local player's framebuffer (240x160)
    const activeScreenIdx = currentMode === "netplay" ? (myPlayerId - 1) : 0;
    const fbPtr = window.Module._mgba_demo_get_framebuffer(activeScreenIdx);
    const stride = (window.Module._mgba_demo_get_stride && window.Module._mgba_demo_get_stride(activeScreenIdx)) || GBA_WIDTH;
    if (fbPtr && soloPixels) {
      const fbView = new Uint32Array(window.Module.HEAPU8.buffer, fbPtr, stride * GBA_HEIGHT);
      for (let y = 0; y < GBA_HEIGHT; y++) {
        const srcRow = y * stride;
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
    const pumpT0 = performance.now();
    const steps = pumpEmulation(now);
    perf.raf(now, performance.now() - pumpT0);

    // Rendering deterministico legato ai frame video GBA:
    // Risoluzione bug 45 FPS su display 90Hz e timing stabile a 60 FPS su qualsiasi monitor (60Hz, 75Hz, 90Hz, 120Hz, 144Hz+)
    if (steps > 0) {
      // Quando steps > 0 un nuovo frame video GBA è stato prodotto dal core mGBA.
      // A velocità 1x (roomSpeed !== 2), disegna sempre il frame generato (~59.73 FPS).
      // A velocità 2x (roomSpeed === 2, 120 FPS emulati), disegna quando totalFramesSimulated % 2 === 0
      // per produrre esattamente 60 FPS disegnati su schermo senza sprechi né aliasing.
      const shouldDraw = (roomSpeed !== 2) || (totalFramesSimulated % 2 === 0);
      if (shouldDraw) {
        const r0 = performance.now();
        renderCanvasOnly();
        perf.render(performance.now() - r0);
        lastRenderAt = now;
        renderCount++;
      }
    }
    perf.tick(now);

    // FPS update every 500ms: FPS = frame DISEGNATI; fra parentesi i passi di emulazione se diversi (2x)
    if (now - lastFpsTime >= 500) {
      const dtF = now - lastFpsTime;
      const drawFps = Math.round((renderCount * 1000) / dtF);
      const simFps = Math.round((frameCount * 1000) / dtF);
      if (fpsBadge) {
        fpsBadge.innerHTML = `<span class="indicator"></span> ${drawFps} FPS` + (simFps > drawFps + 4 ? ` <small>(emul. ${simFps}/s)</small>` : "");
      }
      window.lastReportedFps = drawFps;
      window.lastReportedSps = simFps;
      frameCount = 0;
      renderCount = 0;
      lastFpsTime = now;
    }
  } else {
    lastPumpTime = now;
    pumpDebtMs = 0;
  }
}

function setSpeed(speed) {
  const oldSpeed = roomSpeed === 2 ? 2 : 1;
  roomSpeed = speed;
  if (timerWorker) {
    timerWorker.postMessage({ action: "interval", interval: 16 });
  }
  if (speed === 2) {
    speedBadge.innerText = "Velocita: 2x (emulazione doppia, schermo max 60 FPS)";
    speedBadge.className = "badge speed-2x";
    btnSpeedToggle.innerText = "[>>] Velocita: 2x";
  } else {
    roomSpeed = 1;
    speedBadge.innerText = "Velocita: 1x (60 FPS)";
    speedBadge.className = "badge";
    btnSpeedToggle.innerText = "[>>] Velocita: 1x";
  }
  netRescaleDelay(oldSpeed, roomSpeed === 2 ? 2 : 1);   // stesso ritardo in millisecondi
  audioApplyRatio();
}

// -------------------------------------------------------------
// -------------------------------------------------------------
// Online Link Cable Netplay Implementation (WebRTC P2P Star Topology)
// -------------------------------------------------------------
let peer = null;
let activeP2PConn = null; // Guest: direct connection to Host.
let connectedGuests = {}; // Host: slotId (2, 3, 4) -> { conn, name, sram, ready }
let connectedPlayerIds = new Set([1]); // active players in current netplay lockstep
let netplayPlayerCount = 2; // total players in current/upcoming session (2, 3, 4)
let remotePlayerInputs = { 1: {}, 2: {}, 3: {}, 4: {} };
let remotePlayerMaxFrame = { 1: -1, 2: -1, 3: -1, 4: -1 };
let netplayConnected = false;
window.netplayConnected = false;
let myPlayerId = 1;
let remotePlayerId = 2;
let netplayRoomSpeed = 1;
let netplayRtcEpoch = 0;
let currentRoomCode = "";
let hostSramForMulti = null;

function escapeHtml(str) {
  if (!str) return "";
  return String(str).replace(/[&<>"']/g, s => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  }[s]));
}

function getLobbyRoster() {
  const hostName = (document.getElementById("hostPlayerName")?.value || "").trim() || "Host";
  const roster = [
    { slot: 1, name: hostName, isHost: true }
  ];
  for (let s = 2; s <= 4; s++) {
    const g = connectedGuests[s];
    if (g && g.conn && g.conn.open && !g.isPending) {
      roster.push({
        slot: s,
        name: g.name || `Giocatore ${s}`,
        isHost: false
      });
    }
  }
  return roster;
}

function updateHostLobbyUI() {
  const hostName = (document.getElementById("hostPlayerName")?.value || "").trim() || "Host (Tu)";
  const slot1NameEl = document.getElementById("hostSlot1Name");
  if (slot1NameEl) slot1NameEl.innerText = `${hostName} (Tu)`;

  const readyGuests = Object.values(connectedGuests).filter(g => g.conn && g.conn.open && !g.isPending);
  const totalCount = 1 + readyGuests.length;

  const countBadge = document.getElementById("hostLobbyCountBadge");
  if (countBadge) countBadge.innerText = `${totalCount} / 4 Giocatori`;

  for (let s = 2; s <= 4; s++) {
    const row = document.getElementById(`hostSlot${s}`);
    const nameEl = document.getElementById(`hostSlot${s}Name`);
    const statusEl = document.getElementById(`hostSlot${s}Status`);
    const kickBtn = document.getElementById(`btnHostKickSlot${s}`);

    const guest = connectedGuests[s];
    if (guest && guest.conn && guest.conn.open && !guest.isPending) {
      if (row) row.className = "lobby-player-row connected";
      if (nameEl) {
        nameEl.innerText = guest.name || `Giocatore ${s}`;
        nameEl.style.color = "#f4f4f5";
      }
      if (statusEl) {
        statusEl.className = "lobby-status-badge lobby-status-ready";
        statusEl.innerText = "Pronto";
      }
      if (kickBtn) {
        kickBtn.style.display = "inline-flex";
        kickBtn.disabled = false;
      }
    } else if (guest) {
      if (row) row.className = "lobby-player-row connected";
      if (nameEl) {
        nameEl.innerText = guest.name || `Giocatore ${s}`;
        nameEl.style.color = "#a1a1aa";
      }
      if (statusEl) {
        statusEl.className = "lobby-status-badge lobby-status-connecting";
        statusEl.innerText = "In arrivo...";
      }
      if (kickBtn) {
        kickBtn.style.display = "inline-flex";
        kickBtn.disabled = false;
      }
    } else {
      if (row) row.className = "lobby-player-row empty";
      if (nameEl) {
        nameEl.innerText = s === 2 ? "In attesa compagno..." : "Disponibile (opzionale)";
        nameEl.style.color = "#71717a";
      }
      if (statusEl) {
        statusEl.className = "lobby-status-badge lobby-status-waiting";
        statusEl.innerText = s === 2 ? "In attesa" : "Disponibile";
      }
      if (kickBtn) {
        kickBtn.style.display = "none";
        kickBtn.disabled = true;
      }
    }
  }

  if (btnHostStartGame) {
    if (totalCount >= 2) {
      btnHostStartGame.disabled = false;
      btnHostStartGame.style.background = "#15803d";
      btnHostStartGame.style.borderColor = "#22c55e";
      btnHostStartGame.style.cursor = "pointer";
      btnHostStartGame.innerText = `[▶] Avvia Partita (${totalCount} Giocatori)`;
      if (hostStatusNotice) {
        hostStatusNotice.innerText = `${totalCount} giocatori in lobby! Clicca su '[▶] Avvia Partita' per iniziare o attendi altri compagni (fino a 4).`;
      }
    } else {
      btnHostStartGame.disabled = true;
      btnHostStartGame.style.background = "#374151";
      btnHostStartGame.style.borderColor = "#4b5563";
      btnHostStartGame.style.cursor = "not-allowed";
      btnHostStartGame.innerText = "[▶] In attesa dei compagni (minimo 2)...";
      if (hostStatusNotice) {
        hostStatusNotice.innerText = "In attesa che i compagni entrino nella stanza...";
      }
    }
  }
}

function kickPlayer(slot) {
  console.log(`[Host] Espulsione Giocatore ${slot}...`);
  const guest = connectedGuests[slot];
  if (!guest) return;
  if (guest.watchdogTimer) {
    clearTimeout(guest.watchdogTimer);
    guest.watchdogTimer = null;
  }
  if (guest.conn) {
    try {
      guest.conn.send({
        type: "lobby_kick",
        slot: slot,
        reason: "Espulso dall'Host"
      });
    } catch (e) {}
    setTimeout(() => {
      try { guest.conn.close(); } catch (e) {}
    }, 100);
  }
  handleGuestDisconnect(slot);
  updateHostLobbyUI();
  showInGameNotice(`[HOST] Giocatore ${slot} rimosso dalla stanza.`, 3000);
}
window.kickPlayer = kickPlayer;

function updateGuestLobbyUI(roster, mySlot) {
  const listEl = document.getElementById("joinLobbyPlayerList");
  const countBadge = document.getElementById("joinLobbyCountBadge");
  const noticeEl = document.getElementById("joinStatusNotice");

  if (countBadge && Array.isArray(roster)) {
    countBadge.innerText = `${roster.length} / 4 Giocatori`;
  }
  if (noticeEl && Array.isArray(roster)) {
    noticeEl.innerText = `Connesso all'Host! In attesa che l'Host avvii la partita (${roster.length} giocatori in lobby)...`;
  }

  if (!listEl || !Array.isArray(roster)) return;
  listEl.innerHTML = "";

  roster.forEach(p => {
    const row = document.createElement("div");
    row.className = "lobby-player-row connected";
    const isMe = (p.slot === mySlot);
    const tagClass = `lobby-tag-p${p.slot}`;
    row.innerHTML = `
      <span class="lobby-player-tag ${tagClass}">P${p.slot}</span>
      <span style="font-weight: 600; flex: 1; margin-left: 8px; color: ${isMe ? '#a5b4fc' : '#f4f4f5'};">
        ${escapeHtml(p.name)} ${isMe ? "(Tu)" : ""}
      </span>
      <span class="lobby-status-badge lobby-status-ready">${p.isHost ? "Host" : "Pronto"}</span>
    `;
    listEl.appendChild(row);
  });
}

function broadcastToGuests(msg, excludeSlotId) {
  for (const [idStr, guest] of Object.entries(connectedGuests)) {
    const sid = parseInt(idStr, 10);
    if (sid !== excludeSlotId && guest && guest.conn && guest.conn.open) {
      try { guest.conn.send(msg); } catch(e) {}
    }
  }
}

function packGbrbInput(origin, frame, recentInputs) {
  const sampleList = recentInputs && recentInputs.length > 0
    ? recentInputs
    : [{ frame: frame, keys: currentKeys }];
  const sampleCount = Math.min(sampleList.length, 64);
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


let p2pHandshakeTimer = null;
let guestJoinTimeoutTimer = null;
let guestFallbackFn = null, mqttFallbackTimer = null;   // riserva MQTT lato guest (vedi net/mqtt-link.js)
let hostStatusBase = "", hostMqttNote = "";
const MQTT_FALLBACK_AFTER_MS = window.REBIT_MQTT_FALLBACK_MS || 6000;   // se WebRTC non e' aperto entro 6 s si prova MQTT
const hasMqtt = () => typeof RebitMqtt !== "undefined" && RebitMqtt.available();

function stopP2PHandshakeTimer() {
  if (p2pHandshakeTimer) {
    clearInterval(p2pHandshakeTimer);
    p2pHandshakeTimer = null;
  }
}

function clearGuestJoinTimeout() {
  if (mqttFallbackTimer) { clearTimeout(mqttFallbackTimer); mqttFallbackTimer = null; }
  if (guestJoinTimeoutTimer) {
    clearTimeout(guestJoinTimeoutTimer);
    guestJoinTimeoutTimer = null;
  }
}

function setupHostGuestConnection(conn, slot, token) {
  if (connectedGuests[slot] && connectedGuests[slot].watchdogTimer) {
    clearTimeout(connectedGuests[slot].watchdogTimer);
    connectedGuests[slot].watchdogTimer = null;
  }

  const sessionToken = token || conn.clientSessionToken || (conn.metadata && conn.metadata.session_token) || null;
  if (sessionToken) conn.clientSessionToken = sessionToken;

  connectedGuests[slot] = {
    conn: conn,
    name: `Player ${slot}`,
    sram: null,
    ready: false,
    isPending: true,
    clientSessionToken: sessionToken,
    watchdogTimer: null
  };
  connectedPlayerIds.add(slot);

  // Watchdog Anti-Zombie (6 Secondi): se non raggiunge open e non riceve guest_hello entro 6s, prune automatico
  const watchdog = setTimeout(() => {
    const cur = connectedGuests[slot];
    if (cur && (cur.isPending || !cur.ready || !cur.conn || !cur.conn.open)) {
      console.warn(`[Host] Watchdog anti-zombie scaduto (6s) per slot ${slot}! Nessun guest_hello/open ricevuto. Pruning.`);
      handleGuestDisconnect(slot);
    }
  }, 6000);
  connectedGuests[slot].watchdogTimer = watchdog;

  conn.on("iceStateChanged", (s) => {
    console.log(`[WebRTC ICE Host <-> Guest ${slot}]:`, s);
    if (s === "failed" || s === "disconnected") {
      console.warn(`[Host] ICE ${s} per slot ${slot}: avvio disconnessione pulita.`);
      handleGuestDisconnect(slot);
    }
  });

  if (conn.peerConnection) {
    try {
      conn.peerConnection.addEventListener("iceconnectionstatechange", () => {
        const s = conn.peerConnection.iceConnectionState;
        console.log(`[WebRTC RTCPeerConnection ICE Host <-> Guest ${slot}]:`, s);
        if (s === "failed" || s === "disconnected") {
          console.warn(`[Host] RTCPeerConnection ICE ${s} per slot ${slot}: disconnessione pulita.`);
          handleGuestDisconnect(slot);
        }
      });
    } catch (_) {}
  }

  conn.on("open", () => {
    console.log(`[WebRTC Host] DataChannel aperto per Giocatore ${slot}`);
    netOpenFastChannel(conn, onData);
    // Invia welcome message con slot assegnato e roster
    try {
      conn.send({
        type: "lobby_welcome",
        assigned_slot: slot,
        players: getLobbyRoster()
      });
    } catch(e) {}
    updateHostLobbyUI();
    broadcastToGuests({
      type: "lobby_update",
      players: getLobbyRoster()
    }, slot);
  });

  const onData = (data) => {
    if (data instanceof ArrayBuffer) {
      if (typeof netPacketIsPing === "function" && netPacketIsPing(data)) {
        netHandlePing(data, conn);
        return;
      }
      try {
        const { origin, payload } = unpackRbal(data);
        if (payload && payload.byteLength >= 48) {
          const gbrb = unpackGbrb(payload);
          const pid = gbrb.origin;
          netPeerSeen[pid] = performance.now();
          if (gbrb && gbrb.samples && gbrb.samples.length > 0 && pid >= 1 && pid <= 4) {
            if (!remotePlayerInputs[pid]) remotePlayerInputs[pid] = {};
            for (const s of gbrb.samples) {
              remotePlayerInputs[pid][s.frame] = s.held;
              if (s.frame > remotePlayerMaxFrame[pid]) {
                remotePlayerMaxFrame[pid] = s.frame;
              }
            }
          }
          // Relay packet to all other guests (Star Topology)
          for (const [idStr, g] of Object.entries(connectedGuests)) {
            const gid = parseInt(idStr, 10);
            if (gid !== pid) netSend(g.conn, data);
          }
        }
      } catch (err) {
        console.warn("[WebRTC Host] Error unpacking input packet:", err);
      }
    } else if (typeof data === "object" || typeof data === "string") {
      const msg = typeof data === "string" ? JSON.parse(data) : data;
      handleHostControlMessage(msg, slot, conn);
    }
  };
  conn.on("data", onData);

  conn.on("close", () => {
    console.log(`[WebRTC Host] Connessione chiusa per Giocatore ${slot}`);
    handleGuestDisconnect(slot);
  });

  conn.on("error", (err) => {
    console.warn(`[WebRTC Host] Errore connessione Giocatore ${slot}:`, err);
    handleGuestDisconnect(slot);
  });
}

function handleGuestDisconnect(slot) {
  const guest = connectedGuests[slot];
  if (guest) {
    if (guest.watchdogTimer) {
      clearTimeout(guest.watchdogTimer);
      guest.watchdogTimer = null;
    }
    if (guest.conn) {
      try { guest.conn.close(); } catch (e) {}
    }
  }
  delete connectedGuests[slot];
  connectedPlayerIds.delete(slot);
  if (!netplayConnected) {
    updateHostLobbyUI();
    broadcastToGuests({
      type: "lobby_update",
      players: getLobbyRoster()
    });
  } else {
    // Isolamento errore in partita: i giocatori rimanenti continuano senza freeze!
    broadcastToGuests({
      type: "player_left",
      player_id: slot
    });
    showInGameNotice(`[ONLINE] Giocatore ${slot} disconnesso. La partita continua con i giocatori rimanenti.`, 5000);
    if (Object.keys(connectedGuests).length === 0) {
      handleP2PDisconnect();
    }
  }
}

function handleHostControlMessage(msg, slot, conn) {
  if (msg.type === "guest_hello") {
    console.log(`[WebRTC Host] Ricevuto guest_hello da Giocatore ${slot}:`, msg.name);
    const guest = connectedGuests[slot];
    const token = msg.session_token || (guest && guest.clientSessionToken) || (conn && (conn.clientSessionToken || (conn.metadata && conn.metadata.session_token)));
    if (token) {
      if (guest) guest.clientSessionToken = token;
      for (let s = 2; s <= 4; s++) {
        if (s !== slot && connectedGuests[s] && connectedGuests[s].clientSessionToken === token) {
          console.log(`[Host] Trovato vecchio slot duplicato ${s} con session_token ${token}: pulizia slot.`);
          handleGuestDisconnect(s);
        }
      }
    }
    if (guest) {
      if (guest.watchdogTimer) {
        clearTimeout(guest.watchdogTimer);
        guest.watchdogTimer = null;
      }
      guest.isPending = false;
      guest.ready = true;
      guest.name = msg.name || `Player ${slot}`;
    }
    updateHostLobbyUI();
    broadcastToGuests({
      type: "lobby_update",
      players: getLobbyRoster()
    });
  } else if (msg.type === "guest_bundle") {
    console.log(`[WebRTC Host] Ricevuto guest_bundle da Giocatore ${slot}`);
    if (connectedGuests[slot]) {
      connectedGuests[slot].sram = msg.sram ? sramUnpack(msg.sram) : base64ToUint8(msg.sramBase64);
    }
    try { conn.send({ type: "bundle_ack" }); } catch(e) {}
    checkAndLaunchHostGame();
  } else if (msg.type === "fast_off") {
    netFastFallback(true);
  } else if (msg.type === "core_ready") {
    if (connectedGuests[slot]) connectedGuests[slot].coreReady = true;
    netHostTryGo(false);
  } else if (msg.type === "change_speed") {
    setSpeed(msg.speed || 1);
    broadcastToGuests({ type: "change_speed", speed: msg.speed || 1 }, slot);
  }
}

function checkAndLaunchHostGame() {
  if (netplayConnected) return;
  const guestList = Object.values(connectedGuests);
  const allReady = guestList.length > 0 && guestList.every(g => g.sram && g.sram.length === SRAM_SIZE);
  if (!allReady) {
    console.log("[WebRTC Host] In attesa dei salvataggi da tutti i compagni...");
    return;
  }

  stopP2PHandshakeTimer();
  const totalPlayers = 1 + guestList.length;
  netplayPlayerCount = totalPlayers;

  const sramMap = {
    1: sramPack(hostSramForMulti)
  };
  for (const [slotStr, g] of Object.entries(connectedGuests)) {
    sramMap[slotStr] = sramPack(g.sram);
  }

  // Notifica a tutti i guest di iniziare con la mappa completa dei salvataggi
  broadcastToGuests({
    type: "start_game",
    total_players: totalPlayers,
    room_speed: netplayRoomSpeed,
    rtc_epoch: netplayRtcEpoch,
    sram_bundles: sramMap
  });

  const srams = [hostSramForMulti];
  for (let p = 2; p <= 4; p++) {
    if (connectedGuests[p] && connectedGuests[p].sram) {
      srams.push(connectedGuests[p].sram);
    } else {
      const blank = new Uint8Array(SRAM_SIZE); blank.fill(0xff);
      srams.push(blank);
    }
  }

  const chosenView = document.getElementById("hostScreenView").value;
  netGoSent = false; netHostLoaded = false;
  for (const g of Object.values(connectedGuests)) g.coreReady = false;
  netHoldStart = true;
  try { startNetplayMultiCore(srams, 1, totalPlayers, chosenView); } finally { netHoldStart = false; }
  netHostLoaded = true;
  clearTimeout(netGoTimer);
  netGoTimer = setTimeout(() => netHostTryGo(true), 30000);
  netHostTryGo(false);

  netplayConnected = true;
  window.netplayConnected = true;
  if (typeof netStartPings === "function") netStartPings();
  if (typeof netUpdateBadge === "function") netUpdateBadge();
  netplayModal.style.display = "none";
  activeNetplayBanner.style.display = "block";
  activeNetplayDetail.innerText = `Collegato come Giocatore 1/${totalPlayers} (${netplayRoomSpeed}x Speed - P2P Star).`;
}

function setupGuestConnection(conn, token) {
  activeP2PConn = conn;
  myPlayerId = 2; // Default, verra aggiornato da lobby_welcome
  const sessionToken = token || conn.clientSessionToken || (conn.metadata && conn.metadata.session_token) || window.clientSessionToken;
  if (sessionToken) conn.clientSessionToken = sessionToken;

  conn.on("iceStateChanged", (s) => {
    console.log("[WebRTC ICE Guest]:", s);
    if (!joinStatusNotice) return;
    if (s === "checking") {
      joinStatusNotice.innerText = "Negoziazione router in corso (STUN/TURN)...";
    } else if (s === "connected" || s === "completed") {
      joinStatusNotice.innerText = "Router connessi! In attesa assegnazione slot...";
    } else if (s === "failed" || s === "disconnected") {
      if (guestFallbackFn) guestFallbackFn("ice-" + s);   // NAT simmetrico / hotspot: relay MQTT
      else joinStatusNotice.innerHTML = "<span style='color:#f87171'>Connessione P2P fallita.</span>";
    }
  });

  conn.on("open", () => {
    console.log("[WebRTC Guest] Connesso all'Host! Invio guest_hello...");
    netOpenFastChannel(conn, onData);
    clearGuestJoinTimeout();
    const myName = (document.getElementById("joinPlayerName")?.value || "").trim() || "Player";
    try {
      conn.send({
        type: "guest_hello",
        name: myName,
        session_token: sessionToken
      });
    } catch(e) {}
  });

  const onData = (data) => {
    if (data instanceof ArrayBuffer) {
      if (typeof netPacketIsPing === "function" && netPacketIsPing(data)) {
        netHandlePing(data, conn);
        return;
      }
      try {
        const { origin, payload } = unpackRbal(data);
        if (payload && payload.byteLength >= 48) {
          const gbrb = unpackGbrb(payload);
          const pid = gbrb.origin;
          netPeerSeen[pid] = performance.now();
          if (gbrb && gbrb.samples && gbrb.samples.length > 0 && pid >= 1 && pid <= 4) {
            if (!remotePlayerInputs[pid]) remotePlayerInputs[pid] = {};
            for (const s of gbrb.samples) {
              remotePlayerInputs[pid][s.frame] = s.held;
              if (s.frame > remotePlayerMaxFrame[pid]) {
                remotePlayerMaxFrame[pid] = s.frame;
              }
            }
          }
        }
      } catch (err) {
        console.warn("[WebRTC Guest] Error unpacking input packet:", err);
      }
    } else if (typeof data === "object" || typeof data === "string") {
      const msg = typeof data === "string" ? JSON.parse(data) : data;
      handleGuestControlMessage(msg, conn);
    }
  };
  conn.on("data", onData);

  conn.on("close", () => {
    console.log("[WebRTC Guest] Connessione chiusa dall'Host.");
    handleGuestHostDisconnect();
  });

  conn.on("error", (err) => {
    console.warn("[WebRTC Guest] Errore connessione Host:", err);
    handleGuestHostDisconnect(err);
  });
}

function handleGuestControlMessage(msg, conn) {
  if (msg.type === "room_full") {
    joinStatusNotice.innerHTML = "<span style='color:#f87171'>Stanza piena! Raggiunto il limite massimo di 4 giocatori.</span>";
    btnJoinExistingRoom.style.display = "block";
    clearGuestJoinTimeout();
    stopP2PHandshakeTimer();
    document.body.classList.remove("in-netplay");
  } else if (msg.type === "lobby_kick") {
    console.warn("[Guest] Ricevuto lobby_kick dall'Host:", msg.reason || "");
    showInGameNotice("Sei stato rimosso dalla stanza dall'Host.", 6000);
    stopP2PHandshakeTimer();
    clearGuestJoinTimeout();
    if (typeof netStopPings === "function") netStopPings();
    if (typeof netUpdateBadge === "function") netUpdateBadge();
    closeP2PLink();
    netplayConnected = false;
    window.netplayConnected = false;
    consecutiveWaitTicks = 0;
    if (modeSelect) modeSelect.disabled = false;
    modeBadge.className = "badge";
    if (activeNetplayBanner) activeNetplayBanner.style.display = "none";
    resetNetplayUi();
    hideCanvasOverlay();
    document.body.classList.remove("in-netplay");
    startSinglePlayer(window.localSram);
  } else if (msg.type === "lobby_welcome") {
    myPlayerId = msg.assigned_slot;
    console.log(`[WebRTC Guest] Assegnato slot P${myPlayerId}`);
    updateGuestLobbyUI(msg.players, myPlayerId);
  } else if (msg.type === "lobby_update") {
    updateGuestLobbyUI(msg.players, myPlayerId);
  } else if (msg.type === "ready_and_bundle") {
    // Host ha premuto Avvia Partita!
    stopP2PHandshakeTimer();
    clearGuestJoinTimeout();

    myPlayerId = msg.assigned_player;
    netplayPlayerCount = msg.total_players;
    netplayRoomSpeed = msg.room_speed || 1;
    netplayRtcEpoch = msg.rtc_epoch || Math.floor(Date.now() / 1000);
    setSpeed(netplayRoomSpeed);

    joinStatusNotice.innerText = "Host pronto! Invio il mio salvataggio (.sav)...";

    let mySram = window.localSram;
    if (!mySram || mySram.length !== SRAM_SIZE) mySram = exportCurrentSram(0);
    if (!mySram || mySram.length !== SRAM_SIZE) {
      mySram = new Uint8Array(SRAM_SIZE);
      mySram.fill(0xff);
    }
    window.localSram = mySram;
    persistSram(mySram);

    // Invia salvataggio all'Host
    try {
      conn.send({
        type: "guest_bundle",
        player_id: myPlayerId,
        sram: sramPack(mySram)
      });
    } catch(e) {}
  } else if (msg.type === "start_game") {
    if (netplayConnected) return;
    stopP2PHandshakeTimer();
    clearGuestJoinTimeout();

    netplayPlayerCount = msg.total_players;
    netplayRoomSpeed = msg.room_speed || 1;
    netplayRtcEpoch = msg.rtc_epoch || Math.floor(Date.now() / 1000);
    setSpeed(netplayRoomSpeed);

    const srams = [];
    for (let p = 1; p <= 4; p++) {
      if (msg.sram_bundles && msg.sram_bundles[p]) {
        srams.push(sramFromWire(msg.sram_bundles[p]) || (() => { const b = new Uint8Array(SRAM_SIZE); b.fill(0xff); return b; })());
      } else {
        const blank = new Uint8Array(SRAM_SIZE); blank.fill(0xff);
        srams.push(blank);
      }
    }

    const chosenView = document.getElementById("joinScreenView").value;
    netHoldStart = true;
    try { startNetplayMultiCore(srams, myPlayerId, msg.total_players, chosenView); } finally { netHoldStart = false; }
    try { conn.send({ type: "core_ready" }); } catch (e) {}
    setTimeout(() => { if (!isRunning && netplayConnected) netGo(); }, 45000);   // rete di sicurezza se il "go" si perde

    netplayConnected = true;
    window.netplayConnected = true;
    if (typeof netStartPings === "function") netStartPings();
    if (typeof netUpdateBadge === "function") netUpdateBadge();
    netplayModal.style.display = "none";
    activeNetplayBanner.style.display = "block";
    activeNetplayDetail.innerText = `Collegato come Giocatore ${myPlayerId}/${msg.total_players} (${netplayRoomSpeed}x Speed - P2P Star).`;
  } else if (msg.type === "fast_off") {
    netFastFallback(false);
  } else if (msg.type === "go") {
    netGo();
  } else if (msg.type === "bundle_ack") {
    stopP2PHandshakeTimer();
  } else if (msg.type === "player_left") {
    connectedPlayerIds.delete(msg.player_id);
    showInGameNotice(`[ONLINE] Giocatore ${msg.player_id} si è disconnesso. La partita continua.`, 4000);
  } else if (msg.type === "change_speed") {
    setSpeed(msg.speed || 1);
  }
}

function handleGuestHostDisconnect(err) {
  stopP2PHandshakeTimer();
  clearGuestJoinTimeout();
  if (typeof netStopPings === "function") netStopPings();
  if (typeof netUpdateBadge === "function") netUpdateBadge();
  document.body.classList.remove("in-netplay");
  if (!netplayConnected) {
    joinStatusNotice.innerHTML = `<span style='color:#f87171'>Connessione chiusa dall'Host o fallita.</span>`;
    btnJoinExistingRoom.style.display = "block";
  } else {
    handleP2PDisconnect();
  }
}

// Backward-compatible alias for single connection setup
function setupDataConnection(conn, role) {
  if (role === 1) {
    let freeSlot = [2, 3, 4].find(s => !connectedGuests[s]);
    if (freeSlot) setupHostGuestConnection(conn, freeSlot);
  } else {
    setupGuestConnection(conn);
  }
}

function handleP2PDisconnect() {
  stopP2PHandshakeTimer();
  clearGuestJoinTimeout();
  if (typeof netStopPings === "function") netStopPings();
  if (typeof netUpdateBadge === "function") netUpdateBadge();
  document.body.classList.remove("in-netplay");
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
  btnLoadRom.addEventListener("click", () => {
    if (document.body.classList.contains("in-netplay") || netplayConnected) {
      showInGameNotice("[AVVISO] Non e possibile cambiare ROM durante una sessione Netplay attiva.", 4000);
      return;
    }
    inputRomFile.click();
  });
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
    const activeIdx = (currentMode === "netplay" ? myPlayerId - 1 : 0);
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
    const activeIdx = (currentMode === "netplay" ? myPlayerId - 1 : 0);
    const sram = exportCurrentSram(activeIdx);
    if (sram && sram.length > 0 && !isSramEmpty(sram)) {
      saveSramToBrowserStorage(loadedRomBaseName, sram);
    }
  }
});

window.addEventListener("pagehide", () => {
  if (isRunning && window.Module) {
    const activeIdx = (currentMode === "netplay" ? myPlayerId - 1 : 0);
    const sram = exportCurrentSram(activeIdx);
    if (sram && sram.length > 0 && !isSramEmpty(sram)) {
      saveSramToBrowserStorage(loadedRomBaseName, sram);
    }
  }
});

// Save Management Handlers
btnExportSave.addEventListener("click", () => {
  const activeIdx = (currentMode === "netplay" ? myPlayerId - 1 : 0);
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
  const activeIdx = (currentMode === "netplay" ? myPlayerId - 1 : 0);
  const stateBytes = exportCurrentState(activeIdx);
  if (!stateBytes || stateBytes.length === 0) {
    showSavestateNotice("Errore durante l'esportazione dello stato mGBA.", false);
    return;
  }

  window.lastEmergencyStateBytes = stateBytes;

  try {
    if (!isAuto) localStorage.setItem("last_emergency_savestate", uint8ToBase64(stateBytes));   // quello automatico resta in RAM (niente blocco da 100 ms)
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
  const activeIdx = (currentMode === "netplay" ? myPlayerId - 1 : 0);
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

  // 3. Reset canvas and screen view back to single player
  canvas.width = GBA_WIDTH;
  canvas.height = GBA_HEIGHT;
  updateCanvasAspectRatio("solo");
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
    const activeIdx = (currentMode === "netplay" ? myPlayerId - 1 : 0);
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
      const activeIdx = (currentMode === "netplay" ? myPlayerId - 1 : 0);
      importCurrentState(activeIdx, bytes);
      showSavestateNotice(`[OK] Snapshot (${(bytes.length / 1024).toFixed(1)} KB) caricato e applicato!`, true);
    };
    reader.readAsArrayBuffer(file);
  });
}

function convertSavestateToSav() {
  const activeIdx = (currentMode === "netplay" ? myPlayerId - 1 : 0);
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
  if (typeof RebitMqtt !== "undefined") RebitMqtt.closeAll();
  stopP2PHandshakeTimer();
  clearGuestJoinTimeout();
  if (activeP2PConn) {
    try { activeP2PConn.close(); } catch (e) {}
    activeP2PConn = null;
  }
  for (const guest of Object.values(connectedGuests)) {
    if (guest && guest.conn) {
      try { guest.conn.close(); } catch (e) {}
    }
  }
  connectedGuests = {};
  connectedPlayerIds = new Set([1]);
  if (peer) {
    try { peer.destroy(); } catch (e) {}
    peer = null;
  }
}

function resetNetplayUi() {
  for (const slot of [2, 3, 4]) {
    const g = connectedGuests[slot];
    if (g && g.watchdogTimer) {
      clearTimeout(g.watchdogTimer);
      g.watchdogTimer = null;
    }
  }
  btnStartHosting.style.display = "block";
  btnStartHosting.disabled = false;
  hostWaitingArea.style.display = "none";
  btnJoinExistingRoom.style.display = "block";
  btnJoinExistingRoom.disabled = false;
  joinStatusArea.style.display = "none";
  connectedGuests = {};
  connectedPlayerIds = new Set([1]);
  document.body.classList.remove("in-netplay");
  updateHostLobbyUI();
}

function cancelHosting() {
  console.log("[Host] Annullamento stanza in corso...");
  for (const s of [2, 3, 4]) {
    const g = connectedGuests[s];
    if (g) {
      if (g.watchdogTimer) {
        clearTimeout(g.watchdogTimer);
        g.watchdogTimer = null;
      }
      if (g.conn) {
        try { g.conn.close(); } catch (e) {}
      }
    }
  }
  connectedGuests = {};
  connectedPlayerIds = new Set([1]);

  if (peer) {
    try { peer.destroy(); } catch (e) {}
    peer = null;
  }
  if (typeof RebitMqtt !== "undefined" && typeof RebitMqtt.hostStop === "function") {
    try { RebitMqtt.hostStop(); } catch (e) {}
  }
  if (activeP2PConn) {
    try { activeP2PConn.close(); } catch (e) {}
    activeP2PConn = null;
  }

  stopP2PHandshakeTimer();
  clearTimeout(netGoTimer);
  currentRoomCode = null;
  hostMqttNote = "";
  hostStatusBase = "";

  if (hostWaitingArea) hostWaitingArea.style.display = "none";
  if (btnStartHosting) {
    btnStartHosting.style.display = "block";
    btnStartHosting.disabled = false;
  }
  if (btnHostStartGame) {
    btnHostStartGame.disabled = true;
    btnHostStartGame.innerText = "[▶] In attesa dei compagni (minimo 2)...";
    btnHostStartGame.style.background = "#374151";
    btnHostStartGame.style.borderColor = "#4b5563";
    btnHostStartGame.style.cursor = "not-allowed";
  }

  document.body.classList.remove("in-netplay");
  updateHostLobbyUI();
  showInGameNotice("[HOST] Stanza annullata con successo.", 3000);
}
window.cancelHosting = cancelHosting;

// Connessione in arrivo da un guest, da WebRTC (PeerJS) oppure dal relay MQTT: stessa interfaccia, stessa logica.
function onHostIncomingConn(conn) {
  console.log(`[Host] Compagno collegato via ${conn.type === "mqtt" ? "relay MQTT" : "WebRTC"}! Apertura canale di gioco...`);
  const incomingToken = conn.clientSessionToken || (conn.metadata && conn.metadata.session_token) || null;

  // 1. Deduplicazione: non occupare un nuovo slot se appartiene a un guest gia presente o pendente
  let targetSlot = null;
  if (incomingToken) {
    targetSlot = [2, 3, 4].find((s) => connectedGuests[s] && connectedGuests[s].clientSessionToken === incomingToken);
  }
  if (!targetSlot && conn.peer) {
    targetSlot = [2, 3, 4].find((s) => connectedGuests[s] && connectedGuests[s].conn && connectedGuests[s].conn.peer === conn.peer);
  }

  if (targetSlot) {
    console.log(`[Host] Riconnessione/Fallback rilevato per Giocatore ${targetSlot} (token: ${incomingToken || "peer"}). Riassegno lo slot ${targetSlot} senza incrementare i giocatori.`);
    const oldGuest = connectedGuests[targetSlot];
    if (oldGuest) {
      if (oldGuest.watchdogTimer) {
        clearTimeout(oldGuest.watchdogTimer);
        oldGuest.watchdogTimer = null;
      }
      if (oldGuest.conn && oldGuest.conn !== conn) {
        try { oldGuest.conn.close(); } catch (e) {}
      }
    }
    setupHostGuestConnection(conn, targetSlot, incomingToken);
    return;
  }

  // 2. Nuovo guest: trova uno slot libero
  const freeSlot = [2, 3, 4].find((s) => !connectedGuests[s]);
  if (!freeSlot) {
    console.warn("[Host] Stanza piena (4/4)! Rifiuto nuova connessione.");
    conn.on("open", () => {
      try { conn.send({ type: "room_full" }); } catch (e) {}
      setTimeout(() => { try { conn.close(); } catch (e) {} }, 500);
    });
    return;
  }
  setupHostGuestConnection(conn, freeSlot, incomingToken);
}
function renderHostStatus() {
  hostStatusNotice.innerText = hostStatusBase + (hostMqttNote ? "\n" + hostMqttNote : "");
}
function mqttHostStatus(st) {
  const host = (u) => { try { return new URL(u.replace(/^ws/, "http")).hostname; } catch (e) { return u; } };
  if (st.phase === "probe") hostMqttNote = "Riserva MQTT: ricerca del broker piu' veloce...";
  else if (st.phase === "ready") hostMqttNote = `Riserva MQTT pronta (${host(st.url)}, ${st.rtt} ms) - per chi ha NAT/hotspot`;
  else if (st.phase === "failover") hostMqttNote = "Riserva MQTT: broker caduto, passo al successivo...";
  else if (st.phase === "none") hostMqttNote = "Riserva MQTT non disponibile (nessun broker raggiungibile)";
  else return;
  if (hostWaitingArea.style.display !== "none") renderHostStatus();
}

btnStartHosting.addEventListener("click", () => {
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
  document.body.classList.add("in-netplay");
  if (generatedRoomCode) generatedRoomCode.innerText = currentRoomCode;
  hostStatusBase = "Registrazione stanza online in corso..."; hostMqttNote = "";
  if (typeof RebitMqtt !== "undefined") RebitMqtt.closeAll();
  renderHostStatus();

  connectedGuests = {};
  connectedPlayerIds = new Set([1]);
  updateHostLobbyUI();

  if (activeP2PConn) {
    try { activeP2PConn.close(); } catch (e) {}
    activeP2PConn = null;
  }
  if (peer) {
    try { peer.destroy(); } catch (e) {}
    peer = null;
  }

  try {
    peer = new Peer(peerId, {
      debug: 1,
      config: { iceServers: P2P_ICE_SERVERS }
    });

    peer.on("open", (id) => {
      console.log("[WebRTC Host] Stanza registrata con ID:", id);
      hostStatusBase = `Stanza [${currentRoomCode}] attiva! Invia il link o codice ai compagni per giocare (fino a 4 giocatori).`;
      renderHostStatus();
    });

    peer.on("connection", onHostIncomingConn);

    if (hasMqtt()) {   // riserva: stessa stanza raggiungibile via relay MQTT (WebRTC resta il percorso preferito)
      RebitMqtt.hostStart(currentRoomCode, onHostIncomingConn, mqttHostStatus)
        .catch((e) => { console.warn("[Host] MQTT non disponibile:", e && e.message); hostMqttNote = "Riserva MQTT non disponibile"; renderHostStatus(); });
    }

    peer.on("error", (err) => {
      console.error("[WebRTC Host] Errore broker:", err);
      btnStartHosting.style.display = "block";
      if (err.type === "unavailable-id") {
        showInGameNotice("[AVVISO] Codice stanza gia in uso. Ritento...", 2000);
        setTimeout(() => { if (!netplayConnected) btnStartHosting.click(); }, 500);
      } else {
        document.body.classList.remove("in-netplay");
        hostStatusNotice.innerHTML = `<span style='color:#f87171'>Errore broker: ${err.type || err}</span>`;
      }
    });
  } catch (err) {
    console.warn("PeerJS init error:", err);
    btnStartHosting.style.display = "block";
    document.body.classList.remove("in-netplay");
  }
});

btnCopyRoomCode.addEventListener("click", () => {
  const code = (generatedRoomCode ? generatedRoomCode.innerText.trim() : "") || currentRoomCode;
  copyText(code, btnCopyRoomCode, "[Copia] Solo Codice");
});

if (btnCopyRoomLink) {
  btnCopyRoomLink.addEventListener("click", () => {
    const code = (generatedRoomCode ? generatedRoomCode.innerText.trim() : "") || currentRoomCode;
    const link = `${window.location.origin}${window.location.pathname}#room=${code}`;
    copyText(link, btnCopyRoomLink, "[Copia] Link Diretto (Invia ai compagni)");
  });
}

if (btnHostStartGame) {
  btnHostStartGame.addEventListener("click", () => {
    if (!window.romBytes) {
      showInGameNotice("[ROM] Carica prima il file .gba con il tasto '[ROM] Carica .gba' prima di avviare!", 6000);
      return;
    }
    const guestCount = Object.keys(connectedGuests).length;
    if (guestCount === 0) {
      showInGameNotice("[AVVISO] Nessun compagno connesso. Attendi che almeno 1 giocatore entri nella stanza (minimo 2 giocatori).", 4000);
      return;
    }

    let mySram = window.localSram;
    if (!mySram || mySram.length !== SRAM_SIZE) mySram = exportCurrentSram(0);
    if (!mySram || mySram.length !== SRAM_SIZE) {
      mySram = new Uint8Array(SRAM_SIZE);
      mySram.fill(0xff);
    }
    window.localSram = mySram;
    persistSram(mySram);
    hostSramForMulti = mySram;

    netplayRtcEpoch = Math.floor(Date.now() / 1000);
    netplayRoomSpeed = parseInt(document.getElementById("hostRoomSpeed").value, 10) || 1;
    setSpeed(netplayRoomSpeed);

    const totalPlayers = 1 + guestCount;
    netplayPlayerCount = totalPlayers;

    // Reset guest srams before exchange
    for (const g of Object.values(connectedGuests)) {
      g.sram = null;
    }

    // Invia ready_and_bundle a ciascun guest
    for (const [slotStr, guest] of Object.entries(connectedGuests)) {
      const slot = parseInt(slotStr, 10);
      if (guest.conn && guest.conn.open) {
        try {
          guest.conn.send({
            type: "ready_and_bundle",
            assigned_player: slot,
            total_players: totalPlayers,
            room_speed: netplayRoomSpeed,
            rtc_epoch: netplayRtcEpoch
          });
        } catch(e) {}
      }
    }

    hostStatusNotice.innerText = `Avvio partita a ${totalPlayers} giocatori in corso... Scambio salvataggi (.sav)...`;
  });
}

btnJoinExistingRoom.addEventListener("click", () => {
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

  const normalizedNum = extractRoomCode(rawInput);
  if (!normalizedNum) {
    showInGameNotice("[AVVISO] Codice stanza non valido. Esempio: GBA-4821", 4000);
    return;
  }
  const targetPeerId = `rebit-gba-${normalizedNum}`;
  const displayCode = `GBA-${normalizedNum.toUpperCase()}`;

  const clientSessionToken = "gst_" + Date.now() + "_" + Math.random().toString(36).slice(2, 8);
  window.clientSessionToken = clientSessionToken;

  btnJoinExistingRoom.style.display = "none";
  joinStatusArea.style.display = "block";
  document.body.classList.add("in-netplay");
  joinStatusNotice.innerText = `Ricerca stanza [${displayCode}] sul broker P2P...`;

  closeP2PLink();

  // Riserva MQTT: parte se WebRTC da' errore, ICE fallisce o non si apre entro MQTT_FALLBACK_AFTER_MS.
  // Ritorna true se il relay e' in corso (o appena partito), false se non applicabile (es. WebRTC gia' aperto).
  let mqttRunning = false;
  guestFallbackFn = (reason) => {
    if (mqttRunning) return true;
    if (!hasMqtt() || netplayConnected || (activeP2PConn && activeP2PConn.open)) return false;
    mqttRunning = true;
    console.warn(`[Guest] WebRTC non riesce (${reason}): provo il relay MQTT`);
    joinStatusNotice.innerText = "Connessione diretta non riuscita (NAT/hotspot?): provo il relay MQTT...";
    RebitMqtt.guestJoin(displayCode, (st) => {
      if (st.phase === "connecting") joinStatusNotice.innerText = `Relay MQTT: collegamento a ${st.brokers} broker...`;
      else if (st.phase === "connected") joinStatusNotice.innerText = "Relay MQTT: broker raggiunto, cerco l'Host...";
    }, 22000, clientSessionToken).then((mconn) => {
      if (netplayConnected || (activeP2PConn && activeP2PConn.open && activeP2PConn.type !== "mqtt")) { try { mconn.close(); } catch (e) {} return; }
      try { if (activeP2PConn && activeP2PConn !== mconn) activeP2PConn.close(); } catch (e) {}
      if (peer) { try { peer.destroy(); } catch (e) {} peer = null; }
      joinStatusNotice.innerText = "Relay MQTT collegato! In attesa assegnazione slot...";
      mconn.clientSessionToken = clientSessionToken;
      setupGuestConnection(mconn, clientSessionToken);
    }).catch((e) => {
      if (!e || e.message === "annullato") return;
      clearGuestJoinTimeout(); stopP2PHandshakeTimer();
      btnJoinExistingRoom.style.display = "block";
      document.body.classList.remove("in-netplay");
      joinStatusNotice.innerHTML = `<span style='color:#f87171'>Ne' WebRTC ne' relay MQTT hanno raggiunto l'Host [${displayCode}]: ${(e && e.message) || e}.<br>Controlla il codice e che l'Host abbia creato la stanza.</span>`;
    });
    return true;
  };

  clearGuestJoinTimeout();
  guestJoinTimeoutTimer = setTimeout(() => {
    if (!netplayConnected) {
      console.warn("[WebRTC Guest] Timeout di 20s raggiunto.");
      joinStatusNotice.innerHTML = `<span style='color:#f87171'>Timeout: l'Host [${displayCode}] non risponde.<br>Assicurati che l'Host abbia premuto "Crea Stanza" e sia online.</span>`;
      btnJoinExistingRoom.style.display = "block";
      document.body.classList.remove("in-netplay");
      stopP2PHandshakeTimer();
    }
  }, 32000);
  mqttFallbackTimer = setTimeout(() => { if (guestFallbackFn) guestFallbackFn("timeout"); }, MQTT_FALLBACK_AFTER_MS);   // dopo clearGuestJoinTimeout(), che lo azzera

  try {
    peer = new Peer({
      debug: 1,
      config: { iceServers: P2P_ICE_SERVERS }
    });

    peer.on("open", (myGuestId) => {
      console.log("[WebRTC Guest] Connessione a Host:", targetPeerId);
      joinStatusNotice.innerText = `Host trovato! Negoziazione canale diretto P2P con [${displayCode}]...`;
      const conn = peer.connect(targetPeerId, {
        reliable: true,
        metadata: { session_token: clientSessionToken }
      });
      conn.clientSessionToken = clientSessionToken;
      setupGuestConnection(conn, clientSessionToken);
    });

    peer.on("error", (err) => {
      console.error("[WebRTC Guest] Errore PeerJS:", err);
      if (guestFallbackFn && guestFallbackFn("peerjs-" + (err.type || err))) return;   // passa al relay MQTT
      clearGuestJoinTimeout();
      stopP2PHandshakeTimer();
      btnJoinExistingRoom.style.display = "block";
      document.body.classList.remove("in-netplay");
      if (err.type === "peer-unavailable") {
        joinStatusNotice.innerHTML = `<span style='color:#f87171'>Stanza [${displayCode}] non trovata!<br>Assicurati che l'Host abbia premuto "Crea Stanza" e che il codice sia corretto.</span>`;
      } else {
        joinStatusNotice.innerHTML = `<span style='color:#f87171'>Errore connessione: ${err.type || err}</span>`;
      }
    });
  } catch (err) {
    console.error("PeerJS guest error:", err);
    btnJoinExistingRoom.style.display = "block";
    document.body.classList.remove("in-netplay");
    joinStatusNotice.innerHTML = `<span style='color:#f87171'>Inizializzazione fallita: ${err.message || err}</span>`;
  }
});

btnDisconnectNetplay.addEventListener("click", () => {
  stopP2PHandshakeTimer();
  clearGuestJoinTimeout();
  if (typeof netStopPings === "function") netStopPings();
  if (typeof netUpdateBadge === "function") netUpdateBadge();
  closeP2PLink();
  netplayConnected = false;
  window.netplayConnected = false;
  consecutiveWaitTicks = 0;
  if (modeSelect) modeSelect.disabled = false;
  modeBadge.className = "badge";
  activeNetplayBanner.style.display = "none";
  resetNetplayUi();
  hideCanvasOverlay();
  document.body.classList.remove("in-netplay");
  showInGameNotice("[INFO] Disconnesso dal Cavo Link P2P. Ritorno alla modalita singolo.", 4000);
  startSinglePlayer(window.localSram);
});

modeSelect.addEventListener("change", (e) => {
  if (document.body.classList.contains("in-netplay") || netplayConnected) {
    showInGameNotice("[AVVISO] Modalita bloccata durante una sessione Netplay.", 4000);
    return;
  }
  if (e.target.value === "dual") {
    startDualScreenCoop();
  } else {
    startSinglePlayer(window.localSram);
  }
});

const btnToggleScreenView = document.getElementById("btnToggleScreenView");

function setScreenView(view) {
  // In single player, enforce single screen
  if (currentMode === "solo") {
    view = "solo";
  }
  netplayViewMode = view;
  if (view === "split") {
    canvas.width = GBA_WIDTH * 2;
    canvas.height = GBA_HEIGHT;
    updateCanvasAspectRatio("split");
    if (btnToggleScreenView) {
      btnToggleScreenView.innerText = "[O] Vista: Split (2P)";
      btnToggleScreenView.style.display = currentMode === "solo" ? "none" : "inline-flex";
    }
  } else if (view === "grid") {
    canvas.width = GBA_WIDTH * 2;
    canvas.height = GBA_HEIGHT * 2;
    updateCanvasAspectRatio("grid");
    if (btnToggleScreenView) {
      btnToggleScreenView.innerText = "[O] Vista: Griglia (4P)";
      btnToggleScreenView.style.display = currentMode === "solo" ? "none" : "inline-flex";
    }
  } else {
    canvas.width = GBA_WIDTH;
    canvas.height = GBA_HEIGHT;
    updateCanvasAspectRatio("solo");
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
    let nextView = "solo";
    if (netplayViewMode === "solo") {
      nextView = netplayPlayerCount > 2 ? "grid" : "split";
    } else if (netplayViewMode === "split") {
      nextView = "grid";
    } else {
      nextView = "solo";
    }
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
}

// ROM caricata automaticamente all'avvio (se presente nella cartella roms/).
const DEFAULT_ROM_URL = "./roms/PokemonQuetzal.gba";

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
  getPlayerCount: () => netplayPlayerCount,
  getRoomCode: () => currentRoomCode,
  getPeer: () => peer,
  getActiveConn: () => activeP2PConn,
  getConnectedGuests: () => connectedGuests,
  getConnectedPlayerIds: () => Array.from(connectedPlayerIds),
  getCurrentKeys: () => currentKeys,
  kickPlayer: (slot) => kickPlayer(slot),
  cancelHosting: () => cancelHosting(),
  toggleFullscreen: () => toggleFullscreen(),
  exitFullscreen: () => exitFullscreen(),
  isFullscreen: () => isFullscreen(),
  toggleTheaterMode: (forceState) => toggleTheaterMode(forceState),
  isTheaterMode: () => isTheaterMode()
};

// -------------------------------------------------------------
// Theater Mode & Fullscreen Management (Ponytail Ultra)
// -------------------------------------------------------------
function isTheaterMode() {
  return document.body.classList.contains("is-theater");
}

function updateTheaterButtonUI() {
  const active = isTheaterMode();
  const btnTheater = document.getElementById("btnTheaterToggle");
  if (btnTheater) {
    btnTheater.innerText = active ? "[🗗 Riduci]" : "[🗖 Finestra]";
    btnTheater.classList.toggle("active", active);
    btnTheater.setAttribute("aria-pressed", active ? "true" : "false");
    btnTheater.title = active ? "Riduci dimensione finestra (disattiva modalità teatro)" : "Ingrandisci finestra browser (modalità teatro)";
  }
}

function toggleTheaterMode(forceState) {
  const newState = typeof forceState === "boolean" ? forceState : !isTheaterMode();
  document.body.classList.toggle("is-theater", newState);
  updateTheaterButtonUI();
  if (typeof updateCanvasAspectRatio === "function") {
    updateCanvasAspectRatio();
  }
  return newState;
}

function isFullscreen() {
  return !!(document.fullscreenElement || document.webkitFullscreenElement || document.mozFullScreenElement || document.msFullscreenElement);
}

function updateFullscreenButtonUI() {
  const isFs = isFullscreen() || document.body.classList.contains("is-fullscreen");
  const btnFs = document.getElementById("btnFullscreenToggle");
  if (btnFs) {
    btnFs.innerText = isFs ? "[✕ Esci]" : "[⛶ Tutto Schermo]";
    btnFs.classList.toggle("active", isFs);
    btnFs.setAttribute("aria-pressed", isFs ? "true" : "false");
    btnFs.title = isFs ? "Esci da Schermo Intero" : "Attiva Schermo Intero nativo";
  }
  const btnExitHud = document.getElementById("btnExitFullscreenHud");
  if (btnExitHud) {
    btnExitHud.innerText = "[✕ Esci]";
  }
  const btnHudFsExit = document.getElementById("btnHudFullscreenExit");
  if (btnHudFsExit) {
    btnHudFsExit.innerText = "[✕ Esci Fullscreen]";
  }
}

function toggleFullscreen() {
  if (!isFullscreen()) {
    const docEl = document.documentElement;
    const req = docEl.requestFullscreen || docEl.webkitRequestFullscreen || docEl.mozRequestFullScreen || docEl.msRequestFullscreen;
    if (req) {
      req.call(docEl).catch((err) => {
        console.warn("Fullscreen request failed, fallback to class:", err);
        document.body.classList.toggle("is-fullscreen");
        updateFullscreenButtonUI();
        if (typeof updateCanvasAspectRatio === "function") updateCanvasAspectRatio();
      });
    } else {
      document.body.classList.toggle("is-fullscreen");
      updateFullscreenButtonUI();
      if (typeof updateCanvasAspectRatio === "function") updateCanvasAspectRatio();
    }
  } else {
    exitFullscreen();
  }
}

function exitFullscreen() {
  if (isFullscreen()) {
    const exit = document.exitFullscreen || document.webkitExitFullscreen || document.mozCancelFullScreen || document.msExitFullscreen;
    if (exit) {
      exit.call(document).catch((err) => {
        console.warn("Fullscreen exit error:", err);
      });
    }
  }
  document.body.classList.remove("is-fullscreen");
  updateFullscreenButtonUI();
  if (typeof updateCanvasAspectRatio === "function") {
    updateCanvasAspectRatio();
  }
}

function handleFullscreenChange() {
  const isFs = isFullscreen();
  if (isFs) {
    document.body.classList.add("is-fullscreen");
  } else {
    document.body.classList.remove("is-fullscreen");
  }
  updateFullscreenButtonUI();
  if (typeof updateCanvasAspectRatio === "function") {
    updateCanvasAspectRatio();
  }
}
document.addEventListener("fullscreenchange", handleFullscreenChange);
document.addEventListener("webkitfullscreenchange", handleFullscreenChange);
document.addEventListener("mozfullscreenchange", handleFullscreenChange);
document.addEventListener("MSFullscreenChange", handleFullscreenChange);

window.toggleTheaterMode = toggleTheaterMode;
window.isTheaterMode = isTheaterMode;
window.toggleFullscreen = toggleFullscreen;
window.exitFullscreen = exitFullscreen;
window.isFullscreen = isFullscreen;

function openSettingsDrawer() {
  const drawer = document.getElementById("settingsDrawer");
  if (!drawer) return;
  drawer.style.display = "flex";
  drawer.classList.add("open");
  drawer.classList.add("is-open");
  drawer.setAttribute("aria-hidden", "false");
  const backdrop = document.getElementById("settingsDrawerBackdrop");
  if (backdrop) {
    backdrop.style.display = "block";
    backdrop.style.opacity = "1";
  }
}

function closeSettingsDrawer() {
  const drawer = document.getElementById("settingsDrawer");
  if (!drawer) return;
  drawer.classList.remove("open");
  drawer.classList.remove("is-open");
  drawer.setAttribute("aria-hidden", "true");
  drawer.style.display = "none";
  const backdrop = document.getElementById("settingsDrawerBackdrop");
  if (backdrop) {
    backdrop.style.display = "none";
    backdrop.style.opacity = "0";
  }
}

function toggleSettingsDrawer() {
  const drawer = document.getElementById("settingsDrawer");
  if (!drawer) return;
  if (drawer.classList.contains("open") || drawer.classList.contains("is-open")) {
    closeSettingsDrawer();
  } else {
    openSettingsDrawer();
  }
}

window.openSettingsDrawer = openSettingsDrawer;
window.closeSettingsDrawer = closeSettingsDrawer;
window.toggleSettingsDrawer = toggleSettingsDrawer;

// Touch Controls synchronization
function updateTouchEnabledClass() {
  const chk = document.getElementById("chkTouchControls");
  if (chk) {
    if (chk.checked) {
      document.body.classList.add("touch-enabled");
    } else {
      document.body.classList.remove("touch-enabled");
    }
  }
}
document.addEventListener("change", (e) => {
  if (e.target && e.target.id === "chkTouchControls") {
    updateTouchEnabledClass();
  }
});
window.addEventListener("DOMContentLoaded", updateTouchEnabledClass);
setTimeout(updateTouchEnabledClass, 100);
setTimeout(updateTouchEnabledClass, 500);

// Global delegation for UI actions (Theater, Fullscreen, Settings, Kick, Cancel)
document.addEventListener("click", (e) => {
  if (!e.target) return;
  // Theater mode toggle
  if (e.target.id === "btnTheaterToggle" || e.target.closest("#btnTheaterToggle")) {
    e.preventDefault();
    toggleTheaterMode();
    return;
  }
  // Fullscreen toggle
  if (e.target.id === "btnFullscreenToggle" || e.target.closest("#btnFullscreenToggle")) {
    e.preventDefault();
    toggleFullscreen();
    return;
  }
  // Exit fullscreen from HUD
  if (e.target.id === "btnExitFullscreenHud" || e.target.closest("#btnExitFullscreenHud") ||
      e.target.id === "btnHudFullscreenExit" || e.target.closest("#btnHudFullscreenExit")) {
    e.preventDefault();
    exitFullscreen();
    return;
  }
  // Settings drawer
  if (e.target.id === "btnOpenSettings" || e.target.closest("#btnOpenSettings")) {
    e.preventDefault();
    openSettingsDrawer();
    return;
  }
  if (e.target.id === "btnCloseSettings" || e.target.closest("#btnCloseSettings")) {
    e.preventDefault();
    closeSettingsDrawer();
    return;
  }
  if (e.target.id === "btnHudSettings" || e.target.closest("#btnHudSettings")) {
    e.preventDefault();
    toggleSettingsDrawer();
    return;
  }
  // Cancel hosting
  if (e.target.id === "btnCancelHosting" || e.target.closest("#btnCancelHosting")) {
    e.preventDefault();
    cancelHosting();
    return;
  }
  // Host kick slot buttons
  const kickBtn = e.target.closest("#btnHostKickSlot2, #btnHostKickSlot3, #btnHostKickSlot4, [id^='btnHostKickSlot']");
  if (kickBtn) {
    e.preventDefault();
    const match = kickBtn.id.match(/btnHostKickSlot(\d+)/);
    if (match) {
      const slot = parseInt(match[1], 10);
      kickPlayer(slot);
    }
    return;
  }
});

// Explicit element binding when available
for (const s of [2, 3, 4]) {
  const kickBtn = document.getElementById(`btnHostKickSlot${s}`);
  if (kickBtn) {
    kickBtn.addEventListener("click", () => kickPlayer(s));
  }
}
const btnCancelHostingEl = document.getElementById("btnCancelHosting");
if (btnCancelHostingEl) {
  btnCancelHostingEl.addEventListener("click", cancelHosting);
}
const btnTheaterEl = document.getElementById("btnTheaterToggle");
if (btnTheaterEl) {
  btnTheaterEl.addEventListener("click", toggleTheaterMode);
}
const btnFsToggleEl = document.getElementById("btnFullscreenToggle");
if (btnFsToggleEl) {
  btnFsToggleEl.addEventListener("click", toggleFullscreen);
}
const btnExitFs1 = document.getElementById("btnExitFullscreenHud");
if (btnExitFs1) {
  btnExitFs1.addEventListener("click", exitFullscreen);
}
const btnExitFs2 = document.getElementById("btnHudFullscreenExit");
if (btnExitFs2) {
  btnExitFs2.addEventListener("click", exitFullscreen);
}
const btnOpenSettingsEl = document.getElementById("btnOpenSettings");
if (btnOpenSettingsEl) {
  btnOpenSettingsEl.addEventListener("click", openSettingsDrawer);
}
const btnCloseSettingsEl = document.getElementById("btnCloseSettings");
if (btnCloseSettingsEl) {
  btnCloseSettingsEl.addEventListener("click", closeSettingsDrawer);
}
const btnHudSettingsEl = document.getElementById("btnHudSettings");
if (btnHudSettingsEl) {
  btnHudSettingsEl.addEventListener("click", toggleSettingsDrawer);
}

// Initial UI state synchronization
updateTheaterButtonUI();
updateFullscreenButtonUI();
window.addEventListener("DOMContentLoaded", () => {
  updateTheaterButtonUI();
  updateFullscreenButtonUI();
});

window.addEventListener("load", initCore);
