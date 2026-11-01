/**
 * touch-controls.js - Sistema di Controlli Touch Personalizzabili per GBA (Edizione Tasti Singoli & Croce D-Pad 3D)
 * 
 * Supporta:
 * - Croce Direzionale GBA monolitica unificata con piatto incassato, rilevamento angolare e 3D rocker tilt
 * - Tasti individuali A, B, A+B, L, R, SELECT, START, 2X TURBO completamente separati e liberamente riposizionabili
 * - Modalità Edit Layout: trascina qualsiasi tasto singolarmente sullo schermo
 * - Ridimensionamento individuale per tasto selezionato o globale
 * - Trasparenza regolabile in tempo reale
 * - Salvataggio persistente in localStorage
 * - Auto-rilevamento smartphone/tablet + interruttore manuale ON/OFF
 */

(function () {
  "use strict";

  const STORAGE_KEY_PORTRAIT = "multigba_touch_layout_portrait_v2";
  const STORAGE_KEY_LANDSCAPE = "multigba_touch_layout_landscape_v2";
  const STORAGE_KEY_LEGACY = "multigba_touch_layout_v1";
  const STORAGE_KEY_ENABLED = "multigba_touch_enabled";
  const STORAGE_KEY_DPAD_4WAY = "multigba_touch_dpad_4way";

  let dpad4WayOnly = false;
  try {
    dpad4WayOnly = localStorage.getItem(STORAGE_KEY_DPAD_4WAY) === "true";
  } catch (e) {}
  const GBA = {
    A: 1 << 0,
    B: 1 << 1,
    SELECT: 1 << 2,
    START: 1 << 3,
    RIGHT: 1 << 4,
    LEFT: 1 << 5,
    UP: 1 << 6,
    DOWN: 1 << 7,
    R: 1 << 8,
    L: 1 << 9,
  };

  // Nomi leggibili per i badge della barra di modifica
  const WIDGET_NAMES = {
    dpad: "D-PAD (Croce)",
    btnL: "Tasto Dorsale [L]",
    btnR: "Tasto Dorsale [R]",
    btnB: "Tasto Azione [B]",
    btnA: "Tasto Azione [A]",
    btnAB: "Combinato [A+B]",
    btnSelect: "Menu [SELECT]",
    btnStart: "Menu [START]",
    btnSpeed: "Turbo [2X]"
  };

  // Stato interno
  let touchMask = 0;
  let isEditing = false;
  let selectedWidgetId = null;
  let activeDpadTouchId = null;
  let activeOrientation = "portrait";

  // 1. Layout predefinito VERTICALE (mobile portrait: schermo in alto, gamepad sotto)
  const DEFAULT_LAYOUT_PORTRAIT = {
    scale: 1.0,
    opacity: 0.8,
    widgets: {
      dpad:      { bottom: "20px", left: "20px",  scale: 1.0 },
      btnL:      { top: "12px",    left: "16px",  scale: 1.0 },
      btnR:      { top: "12px",    right: "16px", scale: 1.0 },
      btnB:      { bottom: "30px", right: "88px", scale: 1.0 },
      btnA:      { bottom: "78px", right: "20px", scale: 1.0 },
      btnAB:     { bottom: "20px", right: "20px", scale: 0.88 },
      btnSelect: { bottom: "16px", left: "calc(50% - 90px)", scale: 1.0 },
      btnStart:  { bottom: "16px", left: "calc(50% - 22px)", scale: 1.0 },
      btnSpeed:  { bottom: "16px", left: "calc(50% + 46px)", scale: 1.0 }
    }
  };

  // 2. Layout predefinito ORIZZONTALE (fullscreen landscape: schermo al centro, comandi ai lati/ali)
  const DEFAULT_LAYOUT_LANDSCAPE = {
    scale: 1.0,
    opacity: 0.8,
    widgets: {
      dpad:      { bottom: "24px", left: "24px",  scale: 1.0 },
      btnL:      { top: "16px",    left: "20px",  scale: 1.0 },
      btnR:      { top: "16px",    right: "20px", scale: 1.0 },
      btnB:      { bottom: "30px", right: "92px", scale: 1.0 },
      btnA:      { bottom: "78px", right: "20px", scale: 1.0 },
      btnAB:     { bottom: "20px", right: "20px", scale: 0.88 },
      btnSelect: { bottom: "14px", left: "calc(50% - 90px)", scale: 0.9 },
      btnStart:  { bottom: "14px", left: "calc(50% - 20px)", scale: 0.9 },
      btnSpeed:  { bottom: "14px", left: "calc(50% + 50px)", scale: 0.9 }
    }
  };

  let portraitLayout = JSON.parse(JSON.stringify(DEFAULT_LAYOUT_PORTRAIT));
  let landscapeLayout = JSON.parse(JSON.stringify(DEFAULT_LAYOUT_LANDSCAPE));
  let currentLayout = portraitLayout;

  function detectOrientation() {
    const isLandscape = (window.matchMedia && window.matchMedia("(orientation: landscape)").matches) || (window.innerWidth > window.innerHeight);
    return isLandscape ? "landscape" : "portrait";
  }

  // Valida che una coordinata non sia corrotta o impostata a 0,0 in alto a sinistra o fuori dai limiti
  function isValidPosition(pos, orient) {
    if (!pos || typeof pos !== "object") return false;
    const l = String(pos.left || "").trim();
    const t = String(pos.top || "").trim();
    if ((l === "0px" || l === "0") && (t === "0px" || t === "0")) {
      return false;
    }
    // Protezione contro vecchie coordinate 'top' in px a schermo intero che spingerebbero i tasti fuori dalla finestra
    if (orient === "portrait" && t.endsWith("px")) {
      const topNum = parseFloat(t);
      if (topNum > 360) return false;
    }
    const hasH = (pos.left && pos.left !== "auto") || (pos.right && pos.right !== "auto");
    const hasV = (pos.top && pos.top !== "auto") || (pos.bottom && pos.bottom !== "auto");
    return Boolean(hasH && hasV);
  }

  function loadSingleLayout(orient) {
    const key = orient === "landscape" ? STORAGE_KEY_LANDSCAPE : STORAGE_KEY_PORTRAIT;
    const def = orient === "landscape" ? DEFAULT_LAYOUT_LANDSCAPE : DEFAULT_LAYOUT_PORTRAIT;
    const result = JSON.parse(JSON.stringify(def));
    try {
      let saved = localStorage.getItem(key);
      if (!saved && orient === "portrait") {
        saved = localStorage.getItem(STORAGE_KEY_LEGACY);
      }
      if (saved) {
        const parsed = JSON.parse(saved);
        if (parsed && typeof parsed === "object") {
          result.scale = parsed.scale || def.scale;
          result.opacity = parsed.opacity || def.opacity;
          if (parsed.widgets && typeof parsed.widgets === "object") {
            for (const [id, pos] of Object.entries(parsed.widgets)) {
              if (isValidPosition(pos, orient)) {
                result.widgets[id] = pos;
              }
            }
          }
        }
      }
    } catch (e) {
      console.warn(`[Touch] Errore caricamento layout ${orient}:`, e);
    }
    return result;
  }

  function loadSavedLayouts() {
    portraitLayout = loadSingleLayout("portrait");
    landscapeLayout = loadSingleLayout("landscape");
    activeOrientation = detectOrientation();
    currentLayout = activeOrientation === "landscape" ? landscapeLayout : portraitLayout;
  }

  function saveCurrentLayout() {
    try {
      const orient = activeOrientation || detectOrientation();
      const key = orient === "landscape" ? STORAGE_KEY_LANDSCAPE : STORAGE_KEY_PORTRAIT;
      const data = JSON.stringify(currentLayout);
      localStorage.setItem(key, data);
      if (orient === "landscape") {
        landscapeLayout = JSON.parse(data);
      } else {
        portraitLayout = JSON.parse(data);
      }
    } catch (e) {
      console.warn("[Touch] Errore salvataggio layout:", e);
    }
  }

  function resetCurrentLayout() {
    const orient = activeOrientation || detectOrientation();
    const def = orient === "landscape" ? DEFAULT_LAYOUT_LANDSCAPE : DEFAULT_LAYOUT_PORTRAIT;
    currentLayout = JSON.parse(JSON.stringify(def));
    if (orient === "landscape") {
      landscapeLayout = currentLayout;
    } else {
      portraitLayout = currentLayout;
    }
    saveCurrentLayout();
    applyLayoutToDom();
  }

  function triggerHaptic() {
    if (typeof navigator !== "undefined" && navigator.vibrate) {
      try { navigator.vibrate(10); } catch (e) {}
    }
  }

  function applyButtonState(mask, isDown) {
    if (isDown) {
      touchMask |= mask;
    } else {
      touchMask &= ~mask;
    }
    if (typeof window.setTouchButton === "function") {
      window.setTouchButton(mask, isDown);
    }
  }

  // Applica le posizioni e scale di ogni singolo widget al DOM
  function applyLayoutToDom() {
    const overlay = document.getElementById("touchControlsOverlay");
    if (!overlay) return;

    overlay.style.setProperty("--touch-scale", currentLayout.scale || 1.0);
    overlay.style.setProperty("--touch-opacity", currentLayout.opacity || 0.8);

    const sizeSlider = document.getElementById("touchSizeSlider");
    const sizeLabel = document.getElementById("touchSizeLabel");
    const opacitySlider = document.getElementById("touchOpacitySlider");
    const opacityLabel = document.getElementById("touchOpacityLabel");

    if (opacitySlider) opacitySlider.value = currentLayout.opacity || 0.8;
    if (opacityLabel) opacityLabel.innerText = Math.round((currentLayout.opacity || 0.8) * 100) + "%";

    updateToolbarSelection();

    const activeDefaults = (activeOrientation === "landscape" ? DEFAULT_LAYOUT_LANDSCAPE : DEFAULT_LAYOUT_PORTRAIT).widgets;
    const widgets = currentLayout.widgets || {};
    for (const [id, defaultPos] of Object.entries(activeDefaults)) {
      const el = document.querySelector(`.touch-widget[data-touch-id="${id}"]`);
      if (!el) continue;

      const userPos = widgets[id];
      const pos = (userPos && isValidPosition(userPos, activeOrientation)) ? userPos : defaultPos;

      el.style.top = pos.top || "auto";
      el.style.bottom = pos.bottom || "auto";
      el.style.left = pos.left || "auto";
      el.style.right = pos.right || "auto";

      if (pos.scale) {
        el.style.setProperty("--widget-scale", pos.scale);
      } else {
        el.style.removeProperty("--widget-scale");
      }
    }
  }

  function updateToolbarSelection() {
    const badge = document.getElementById("touchSelectedBadge");
    const sizeSlider = document.getElementById("touchSizeSlider");
    const sizeLabel = document.getElementById("touchSizeLabel");

    if (selectedWidgetId && currentLayout.widgets[selectedWidgetId]) {
      const wName = WIDGET_NAMES[selectedWidgetId] || selectedWidgetId;
      if (badge) badge.innerText = "Modifica: " + wName;
      const wScale = currentLayout.widgets[selectedWidgetId].scale || 1.0;
      if (sizeSlider) sizeSlider.value = wScale;
      if (sizeLabel) sizeLabel.innerText = Math.round(wScale * 100) + "%";
    } else {
      if (badge) badge.innerText = "Tutti i Tasti (Globale)";
      const gScale = currentLayout.scale || 1.0;
      if (sizeSlider) sizeSlider.value = gScale;
      if (sizeLabel) sizeLabel.innerText = Math.round(gScale * 100) + "%";
    }
  }

  function selectWidget(id) {
    selectedWidgetId = id;
    document.querySelectorAll(".touch-widget").forEach((w) => {
      if (w.getAttribute("data-touch-id") === id) {
        w.classList.add("selected-widget");
      } else {
        w.classList.remove("selected-widget");
      }
    });
    updateToolbarSelection();
  }

  function unselectAllWidgets() {
    selectedWidgetId = null;
    document.querySelectorAll(".touch-widget").forEach((w) => {
      w.classList.remove("selected-widget");
    });
    updateToolbarSelection();
  }

  // ========================================================
  // D-PAD: Croce Direzionale Unificata con Rocker Tilt 3D
  // ========================================================
  function setupDpad() {
    const dpadBase = document.getElementById("touchDpadBase");
    const dpadCross = document.getElementById("touchDpadCross");
    if (!dpadBase) return;

    const btnUp = document.getElementById("btnTouchUp");
    const btnDown = document.getElementById("btnTouchDown");
    const btnLeft = document.getElementById("btnTouchLeft");
    const btnRight = document.getElementById("btnTouchRight");

    function updateDpadFromPoint(clientX, clientY) {
      const rect = dpadBase.getBoundingClientRect();
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      const dx = clientX - cx;
      const dy = clientY - cy;
      const dist = Math.sqrt(dx * dx + dy * dy);

      const widgetScale = (currentLayout.widgets.dpad && currentLayout.widgets.dpad.scale) || 1.0;
      const effectiveScale = (currentLayout.scale || 1.0) * widgetScale;
      const deadzone = 14 * effectiveScale;

      let up = false, down = false, left = false, right = false;

      if (dist > deadzone) {
        // Angolo in gradi (-180 a +180)
        const angle = Math.atan2(dy, dx) * (180 / Math.PI);

        if (dpad4WayOnly) {
          // Modalità 4 direzioni ortogonali pure (90° per asse cardinale, zero diagonali)
          if (angle >= -45 && angle < 45) {
            right = true;
          } else if (angle >= 45 && angle < 135) {
            down = true;
          } else if (angle >= -135 && angle < -45) {
            up = true;
          } else {
            left = true;
          }
        } else {
          // Modalità 8 direzioni standard (con diagonali a 45°)
          if (angle >= -157.5 && angle < -112.5) {
            up = true; left = true;
          } else if (angle >= -112.5 && angle < -67.5) {
            up = true;
          } else if (angle >= -67.5 && angle < -22.5) {
            up = true; right = true;
          } else if (angle >= -22.5 && angle < 22.5) {
            right = true;
          } else if (angle >= 22.5 && angle < 67.5) {
            down = true; right = true;
          } else if (angle >= 67.5 && angle < 112.5) {
            down = true;
          } else if (angle >= 112.5 && angle < 157.5) {
            down = true; left = true;
          } else {
            left = true;
          }
        }
      }

      applyButtonState(GBA.UP, up);
      applyButtonState(GBA.DOWN, down);
      applyButtonState(GBA.LEFT, left);
      applyButtonState(GBA.RIGHT, right);

      if (btnUp) btnUp.classList.toggle("active", up);
      if (btnDown) btnDown.classList.toggle("active", down);
      if (btnLeft) btnLeft.classList.toggle("active", left);
      if (btnRight) btnRight.classList.toggle("active", right);

      // Feedback 3D Tilt del bilanciere
      if (dpadCross) {
        dpadCross.classList.remove(
          "tilt-up", "tilt-down", "tilt-left", "tilt-right",
          "tilt-up-left", "tilt-up-right", "tilt-down-left", "tilt-down-right"
        );
        if (up && right) dpadCross.classList.add("tilt-up-right");
        else if (up && left) dpadCross.classList.add("tilt-up-left");
        else if (down && right) dpadCross.classList.add("tilt-down-right");
        else if (down && left) dpadCross.classList.add("tilt-down-left");
        else if (up) dpadCross.classList.add("tilt-up");
        else if (down) dpadCross.classList.add("tilt-down");
        else if (left) dpadCross.classList.add("tilt-left");
        else if (right) dpadCross.classList.add("tilt-right");
      }
    }

    function clearDpad() {
      activeDpadTouchId = null;
      applyButtonState(GBA.UP, false);
      applyButtonState(GBA.DOWN, false);
      applyButtonState(GBA.LEFT, false);
      applyButtonState(GBA.RIGHT, false);
      if (btnUp) btnUp.classList.remove("active");
      if (btnDown) btnDown.classList.remove("active");
      if (btnLeft) btnLeft.classList.remove("active");
      if (btnRight) btnRight.classList.remove("active");
      if (dpadCross) {
        dpadCross.classList.remove(
          "tilt-up", "tilt-down", "tilt-left", "tilt-right",
          "tilt-up-left", "tilt-up-right", "tilt-down-left", "tilt-down-right"
        );
      }
    }

    // Touch
    dpadBase.addEventListener("touchstart", (e) => {
      if (isEditing) return;
      e.preventDefault();
      const touch = e.changedTouches[0];
      activeDpadTouchId = touch.identifier;
      triggerHaptic();
      updateDpadFromPoint(touch.clientX, touch.clientY);
    }, { passive: false });

    dpadBase.addEventListener("touchmove", (e) => {
      if (isEditing || activeDpadTouchId === null) return;
      e.preventDefault();
      for (let i = 0; i < e.changedTouches.length; i++) {
        const t = e.changedTouches[i];
        if (t.identifier === activeDpadTouchId) {
          updateDpadFromPoint(t.clientX, t.clientY);
          break;
        }
      }
    }, { passive: false });

    const handleDpadEnd = (e) => {
      if (isEditing) return;
      if (activeDpadTouchId === null) return;
      for (let i = 0; i < e.changedTouches.length; i++) {
        if (e.changedTouches[i].identifier === activeDpadTouchId) {
          clearDpad();
          break;
        }
      }
    };

    dpadBase.addEventListener("touchend", handleDpadEnd, { passive: false });
    dpadBase.addEventListener("touchcancel", handleDpadEnd, { passive: false });

    // Mouse support per desktop/test
    let isMouseDown = false;
    dpadBase.addEventListener("mousedown", (e) => {
      if (isEditing) return;
      isMouseDown = true;
      updateDpadFromPoint(e.clientX, e.clientY);
    });
    window.addEventListener("mousemove", (e) => {
      if (isEditing || !isMouseDown) return;
      updateDpadFromPoint(e.clientX, e.clientY);
    });
    window.addEventListener("mouseup", () => {
      if (isMouseDown) {
        isMouseDown = false;
        clearDpad();
      }
    });
  }

  // ========================================================
  // TASTI SINGOLI AZIONE (A, B, A+B, L, R, Start, Select, 2X)
  // ========================================================
  function setupActionButtons() {
    const bindBtn = (id, mask, isCombo = false) => {
      const btn = document.getElementById(id);
      if (!btn) return;

      const press = (e) => {
        if (isEditing) return;
        e.preventDefault();
        btn.classList.add("active");
        triggerHaptic();
        if (isCombo) {
          applyButtonState(GBA.A, true);
          applyButtonState(GBA.B, true);
        } else {
          applyButtonState(mask, true);
        }
      };

      const release = (e) => {
        if (isEditing) return;
        btn.classList.remove("active");
        if (isCombo) {
          applyButtonState(GBA.A, false);
          applyButtonState(GBA.B, false);
        } else {
          applyButtonState(mask, false);
        }
      };

      btn.addEventListener("touchstart", press, { passive: false });
      btn.addEventListener("touchend", release, { passive: false });
      btn.addEventListener("touchcancel", release, { passive: false });

      btn.addEventListener("mousedown", press);
      btn.addEventListener("mouseup", release);
      btn.addEventListener("mouseleave", release);
    };

    bindBtn("btnTouchA", GBA.A);
    bindBtn("btnTouchB", GBA.B);
    bindBtn("btnTouchAB", 0, true);
    bindBtn("btnTouchL", GBA.L);
    bindBtn("btnTouchR", GBA.R);
    bindBtn("btnTouchStart", GBA.START);
    bindBtn("btnTouchSelect", GBA.SELECT);

    // Tasto rapido Turbo 2x
    const btnSpeed = document.getElementById("btnTouchSpeed");
    if (btnSpeed) {
      btnSpeed.addEventListener("click", (e) => {
        if (isEditing) return;
        e.preventDefault();
        triggerHaptic();
        if (typeof window.toggleTouchSpeed === "function") {
          window.toggleTouchSpeed();
        }
      });
      btnSpeed.addEventListener("touchstart", (e) => {
        if (isEditing) return;
        e.preventDefault();
        btnSpeed.classList.add("active");
      }, { passive: false });
      btnSpeed.addEventListener("touchend", (e) => {
        if (isEditing) return;
        btnSpeed.classList.remove("active");
        triggerHaptic();
        if (typeof window.toggleTouchSpeed === "function") {
          window.toggleTouchSpeed();
        }
      }, { passive: false });
    }
  }

  // ========================================================
  // EDIT LAYOUT: TRASCINAMENTO E RIDIMENSIONAMENTO SINGOLI TASTI
  // ========================================================
  function setupDragAndDrop() {
    const widgets = document.querySelectorAll(".touch-widget");

    widgets.forEach((widget) => {
      const widgetId = widget.getAttribute("data-touch-id");
      if (!widgetId) return;

      let startX = 0, startY = 0;
      let initialLeft = 0, initialTop = 0;
      let dragging = false;

      const onStart = (clientX, clientY) => {
        if (!isEditing) return;
        const overlay = document.getElementById("touchControlsOverlay");
        const overlayRect = overlay ? overlay.getBoundingClientRect() : { left: 0, top: 0, width: window.innerWidth, height: window.innerHeight };
        const rect = widget.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) return;
        dragging = true;
        selectWidget(widgetId);
        startX = clientX;
        startY = clientY;
        initialLeft = rect.left - overlayRect.left;
        initialTop = rect.top - overlayRect.top;
        widget.style.bottom = "auto";
        widget.style.right = "auto";
        widget.style.left = initialLeft + "px";
        widget.style.top = initialTop + "px";
        widget.classList.add("dragging");
      };

      const onMove = (clientX, clientY) => {
        if (!dragging || !isEditing) return;
        const overlay = document.getElementById("touchControlsOverlay");
        const dx = clientX - startX;
        const dy = clientY - startY;

        let newLeft = initialLeft + dx;
        let newTop = initialTop + dy;

        const rect = widget.getBoundingClientRect();
        const maxLeft = (overlay ? overlay.clientWidth : window.innerWidth) - rect.width;
        const maxTop = (overlay ? overlay.clientHeight : window.innerHeight) - rect.height;

        newLeft = Math.max(0, Math.min(newLeft, maxLeft));
        newTop = Math.max(0, Math.min(newTop, maxTop));

        widget.style.left = newLeft + "px";
        widget.style.top = newTop + "px";
      };

      const onEnd = () => {
        if (!dragging) return;
        dragging = false;
        widget.classList.remove("dragging");

        const lVal = parseFloat(widget.style.left);
        const tVal = parseFloat(widget.style.top);
        if (!isNaN(lVal) && !isNaN(tVal) && (lVal > 0 || tVal > 0)) {
          if (!currentLayout.widgets[widgetId]) {
            currentLayout.widgets[widgetId] = {};
          }
          currentLayout.widgets[widgetId].left = widget.style.left;
          currentLayout.widgets[widgetId].top = widget.style.top;
          currentLayout.widgets[widgetId].bottom = "auto";
          currentLayout.widgets[widgetId].right = "auto";

          saveCurrentLayout();
        }
      };

      // Mouse
      widget.addEventListener("mousedown", (e) => {
        if (!isEditing) return;
        e.preventDefault();
        e.stopPropagation();
        onStart(e.clientX, e.clientY);

        const moveHandler = (ev) => onMove(ev.clientX, ev.clientY);
        const upHandler = () => {
          onEnd();
          window.removeEventListener("mousemove", moveHandler);
          window.removeEventListener("mouseup", upHandler);
        };
        window.addEventListener("mousemove", moveHandler);
        window.addEventListener("mouseup", upHandler);
      });

      // Touch
      widget.addEventListener("touchstart", (e) => {
        if (!isEditing) return;
        e.preventDefault();
        e.stopPropagation();
        const t = e.touches[0];
        onStart(t.clientX, t.clientY);
      }, { passive: false });

      widget.addEventListener("touchmove", (e) => {
        if (!isEditing || !dragging) return;
        e.preventDefault();
        e.stopPropagation();
        const t = e.touches[0];
        onMove(t.clientX, t.clientY);
      }, { passive: false });

      widget.addEventListener("touchend", (e) => {
        if (!isEditing) return;
        onEnd();
      });
      widget.addEventListener("touchcancel", (e) => {
        if (!isEditing) return;
        onEnd();
      });
    });

    // Clic sullo sfondo per deselezionare il tasto singolo e tornare a scala globale
    const overlay = document.getElementById("touchControlsOverlay");
    if (overlay) {
      overlay.addEventListener("click", (e) => {
        if (!isEditing) return;
        if (e.target === overlay) {
          unselectAllWidgets();
        }
      });
    }

    // Toolbar: Slider Dimensione (individuale o globale)
    const sizeSlider = document.getElementById("touchSizeSlider");
    const sizeLabel = document.getElementById("touchSizeLabel");
    if (sizeSlider) {
      sizeSlider.addEventListener("input", (e) => {
        const val = parseFloat(e.target.value);
        if (sizeLabel) sizeLabel.innerText = Math.round(val * 100) + "%";

        if (selectedWidgetId && currentLayout.widgets[selectedWidgetId]) {
          // Modifica dimensione solo per il tasto selezionato
          currentLayout.widgets[selectedWidgetId].scale = val;
          const el = document.querySelector(`.touch-widget[data-touch-id="${selectedWidgetId}"]`);
          if (el) el.style.setProperty("--widget-scale", val);
        } else {
          // Modifica dimensione globale
          currentLayout.scale = val;
          if (overlay) overlay.style.setProperty("--touch-scale", val);
        }
        saveCurrentLayout();
      });
    }

    // Toolbar: Slider Trasparenza
    const opacitySlider = document.getElementById("touchOpacitySlider");
    const opacityLabel = document.getElementById("touchOpacityLabel");
    if (opacitySlider) {
      opacitySlider.addEventListener("input", (e) => {
        const val = parseFloat(e.target.value);
        currentLayout.opacity = val;
        if (opacityLabel) opacityLabel.innerText = Math.round(val * 100) + "%";
        if (overlay) overlay.style.setProperty("--touch-opacity", val);
        saveCurrentLayout();
      });
    }

    // Toolbar: Reset Layout Default
    const btnReset = document.getElementById("btnResetTouchLayout");
    if (btnReset) {
      btnReset.addEventListener("click", () => {
        resetCurrentLayout();
      });
    }

    // Toolbar: Salva e Chiudi
    const btnClose = document.getElementById("btnCloseTouchEdit");
    if (btnClose) {
      btnClose.addEventListener("click", () => {
        isEditing = false;
        unselectAllWidgets();
        if (overlay) overlay.classList.remove("editing-mode");
        const toolbar = document.getElementById("touchEditToolbar");
        if (toolbar) toolbar.style.display = "none";
        saveCurrentLayout();
      });
    }
  }

  // ========================================================
  // INIZIALIZZAZIONE & ATTIVAZIONE AUTOMATICA SMART
  // ========================================================
  function init() {
    loadSavedLayouts();
    applyLayoutToDom();

    setupDpad();
    setupActionButtons();
    setupDragAndDrop();

    const overlay = document.getElementById("touchControlsOverlay");
    const chkTouch = document.getElementById("chkTouchControls");
    const btnEdit = document.getElementById("btnEditTouchLayout");
    const toolbar = document.getElementById("touchEditToolbar");
    const chkHudDpad4Way = document.getElementById("chkHudDpad4Way");
    const chkDrawerDpad4Way = document.getElementById("chkDrawerDpad4Way");

    function setDpad4Way(enabled) {
      dpad4WayOnly = Boolean(enabled);
      try {
        localStorage.setItem(STORAGE_KEY_DPAD_4WAY, dpad4WayOnly ? "true" : "false");
      } catch (e) {}
      if (chkHudDpad4Way) chkHudDpad4Way.checked = dpad4WayOnly;
      if (chkDrawerDpad4Way) chkDrawerDpad4Way.checked = dpad4WayOnly;
    }

    if (chkHudDpad4Way) {
      chkHudDpad4Way.checked = dpad4WayOnly;
      chkHudDpad4Way.addEventListener("change", (e) => {
        setDpad4Way(e.target.checked);
      });
    }

    if (chkDrawerDpad4Way) {
      chkDrawerDpad4Way.checked = dpad4WayOnly;
      chkDrawerDpad4Way.addEventListener("change", (e) => {
        setDpad4Way(e.target.checked);
      });
    }

    setDpad4Way(dpad4WayOnly);

    // Auto-rilevamento dispositivo mobile/touchscreen
    const isTouchDevice = (
      ("ontouchstart" in window) ||
      (navigator.maxTouchPoints > 0) ||
      (window.matchMedia && window.matchMedia("(pointer: coarse)").matches) ||
      (window.innerWidth <= 850)
    );

    let touchEnabled = isTouchDevice;
    const savedEnabled = localStorage.getItem(STORAGE_KEY_ENABLED);
    if (savedEnabled !== null) {
      touchEnabled = savedEnabled === "true";
    }

    function updateTouchVisibility() {
      const isFs = document.body.classList.contains("is-fullscreen") || Boolean(document.fullscreenElement);
      const isLandscape = detectOrientation() === "landscape";
      // In orizzontale (landscape) i controlli compaiono SOLO a schermo intero (fullscreen)
      if (isLandscape && !isFs) {
        if (overlay) overlay.style.display = "none";
        return;
      }
      if (overlay) {
        overlay.style.display = touchEnabled ? "block" : "none";
      }
    }

    function setTouchEnabled(enabled) {
      touchEnabled = enabled;
      localStorage.setItem(STORAGE_KEY_ENABLED, enabled ? "true" : "false");
      if (chkTouch) chkTouch.checked = enabled;
      if (btnEdit) {
        btnEdit.style.display = enabled ? "inline-flex" : "none";
      }
      updateTouchVisibility();
      if (enabled) {
        applyLayoutToDom();
      } else if (isEditing) {
        isEditing = false;
        unselectAllWidgets();
        if (overlay) overlay.classList.remove("editing-mode");
        if (toolbar) toolbar.style.display = "none";
      }
    }

    const toggleEditMode = () => {
      if (!touchEnabled) {
        setTouchEnabled(true);
      }
      isEditing = !isEditing;
      if (overlay) overlay.classList.toggle("editing-mode", isEditing);
      if (toolbar) toolbar.style.display = isEditing ? "flex" : "none";
      if (isEditing) {
        unselectAllWidgets();
      }
    };

    if (chkTouch) {
      chkTouch.checked = touchEnabled;
      chkTouch.addEventListener("change", (e) => {
        setTouchEnabled(e.target.checked);
      });
    }

    if (btnEdit) {
      btnEdit.addEventListener("click", toggleEditMode);
    }

    function handleScreenStateChange() {
      const newOrient = detectOrientation();
      if (newOrient !== activeOrientation) {
        activeOrientation = newOrient;
        currentLayout = activeOrientation === "landscape" ? landscapeLayout : portraitLayout;
        applyLayoutToDom();
      }
      updateTouchVisibility();
    }

    window.addEventListener("resize", handleScreenStateChange);
    window.addEventListener("orientationchange", handleScreenStateChange);
    document.addEventListener("fullscreenchange", handleScreenStateChange);
    document.addEventListener("webkitfullscreenchange", handleScreenStateChange);

    setTouchEnabled(touchEnabled);

    // Esportazioni API globali per integrazione con menu fullscreen e drawer impostazioni
    window.startTouchEdit = () => {
      if (!touchEnabled) setTouchEnabled(true);
      isEditing = true;
      if (overlay) overlay.classList.add("editing-mode");
      if (toolbar) toolbar.style.display = "flex";
      unselectAllWidgets();
      updateToolbarSelection();
    };
    window.stopTouchEdit = () => {
      isEditing = false;
      unselectAllWidgets();
      if (overlay) overlay.classList.remove("editing-mode");
      if (toolbar) toolbar.style.display = "none";
      saveCurrentLayout();
    };
    window.resetTouchLayout = () => {
      resetCurrentLayout();
      if (typeof showInGameNotice === "function") {
        showInGameNotice("[🎮 Touch] Layout ripristinato ai valori predefiniti!", 3000);
      }
    };
    window.isTouchEditing = () => isEditing;
    window.setTouchControlsEnabled = setTouchEnabled;
    window.getTouchOrientation = () => activeOrientation;
    window.updateTouchControlsVisibility = updateTouchVisibility;
    window.setDpad4Way = setDpad4Way;
    window.isDpad4Way = () => dpad4WayOnly;
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
