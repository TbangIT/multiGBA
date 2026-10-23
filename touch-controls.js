/**
 * touch-controls.js - Sistema di Controlli Touch Personalizzabili per GBA
 * 
 * Supporta:
 * - D-Pad fluido con rilevamento angolare e diagonali (Up, Down, Left, Right + Diagonali)
 * - Tasti A, B, combinazione rapida A+B
 * - Dorsali L e R
 * - SELECT, START e toggle rapido Velocita 2x
 * - Multitouch a bassa latenza senza ritardi o gesture parassite
 * - Feedback aptico (vibrazione) su dispositivi supportati
 * - Modalita "Edit Layout": sposta a piacimento ogni gruppo di controlli e regolane dimensione e trasparenza
 * - Salvataggio persistente in localStorage
 * - Rilevamento automatico smartphone/tablet + interruttore manuale On/Off
 */

(function () {
  "use strict";

  const STORAGE_KEY_LAYOUT = "gba_touch_layout_v2";
  const STORAGE_KEY_ENABLED = "gba_touch_enabled";

  // Mappatura bitmask GBA
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

  // Stato dei tasti premuti via touch
  let touchMask = 0;
  let isEditing = false;
  let activeDpadTouchId = null;

  // Layout predefinito
  const DEFAULT_LAYOUT = {
    scale: 1.0,
    opacity: 0.75,
    clusters: {
      dpad: { bottom: "30px", left: "20px", top: "auto", right: "auto" },
      actions: { bottom: "30px", right: "20px", top: "auto", left: "auto" },
      shoulders: { top: "60px", left: "16px", right: "16px", bottom: "auto" },
      menu: { bottom: "20px", left: "50%", transformX: "-50%", top: "auto", right: "auto" }
    }
  };

  let currentLayout = JSON.parse(JSON.stringify(DEFAULT_LAYOUT));

  function loadSavedLayout() {
    try {
      const saved = localStorage.getItem(STORAGE_KEY_LAYOUT);
      if (saved) {
        const parsed = JSON.parse(saved);
        if (parsed && parsed.clusters) {
          currentLayout = Object.assign({}, DEFAULT_LAYOUT, parsed);
        }
      }
    } catch (e) {
      console.warn("[Touch] Errore caricamento layout salvato:", e);
    }
  }

  function saveCurrentLayout() {
    try {
      localStorage.setItem(STORAGE_KEY_LAYOUT, JSON.stringify(currentLayout));
    } catch (e) {
      console.warn("[Touch] Errore salvataggio layout:", e);
    }
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

  // Inizializzazione posizioni e stili CSS variabili
  function applyLayoutToDom() {
    const overlay = document.getElementById("touchControlsOverlay");
    if (!overlay) return;

    overlay.style.setProperty("--touch-scale", currentLayout.scale || 1.0);
    overlay.style.setProperty("--touch-opacity", currentLayout.opacity || 0.75);

    const sizeSlider = document.getElementById("touchSizeSlider");
    const sizeLabel = document.getElementById("touchSizeLabel");
    if (sizeSlider) sizeSlider.value = currentLayout.scale || 1.0;
    if (sizeLabel) sizeLabel.innerText = Math.round((currentLayout.scale || 1.0) * 100) + "%";

    const opacitySlider = document.getElementById("touchOpacitySlider");
    const opacityLabel = document.getElementById("touchOpacityLabel");
    if (opacitySlider) opacitySlider.value = currentLayout.opacity || 0.75;
    if (opacityLabel) opacityLabel.innerText = Math.round((currentLayout.opacity || 0.75) * 100) + "%";

    const clusters = currentLayout.clusters || {};
    for (const [id, pos] of Object.entries(clusters)) {
      const el = document.getElementById("cluster" + id.charAt(0).toUpperCase() + id.slice(1));
      if (!el) continue;
      el.style.top = pos.top || "auto";
      el.style.bottom = pos.bottom || "auto";
      el.style.left = pos.left || "auto";
      el.style.right = pos.right || "auto";
      if (pos.transformX) {
        el.style.transform = `translateX(${pos.transformX})`;
      } else {
        el.style.transform = "none";
      }
    }
  }

  // Gestione D-Pad con scorrimento continuo e diagonali
  function setupDpad() {
    const dpadBase = document.getElementById("touchDpadBase");
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

      // Deadzone al centro: 12px
      const deadzone = 12 * (currentLayout.scale || 1.0);
      let up = false, down = false, left = false, right = false;

      if (dist > deadzone) {
        const threshold = 14 * (currentLayout.scale || 1.0);
        if (dy < -threshold) up = true;
        if (dy > threshold) down = true;
        if (dx < -threshold) left = true;
        if (dx > threshold) right = true;
      }

      applyButtonState(GBA.UP, up);
      applyButtonState(GBA.DOWN, down);
      applyButtonState(GBA.LEFT, left);
      applyButtonState(GBA.RIGHT, right);

      if (btnUp) btnUp.classList.toggle("active", up);
      if (btnDown) btnDown.classList.toggle("active", down);
      if (btnLeft) btnLeft.classList.toggle("active", left);
      if (btnRight) btnRight.classList.toggle("active", right);
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
    }

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

    // Supporto per test con mouse sul D-Pad
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

  // Gestione pulsanti singoli e combinati (A, B, A+B, L, R, Start, Select, Speed)
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

    // Tasto rapido Velocita 2x
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

  // Modalita "Edit Layout": trascinamento posizioni e ridimensionamento
  function setupDragAndDrop() {
    const clusterIds = ["clusterDpad", "clusterActions", "clusterShoulders", "clusterMenu"];

    clusterIds.forEach((clusterId) => {
      const el = document.getElementById(clusterId);
      if (!el) return;

      const clusterKey = el.getAttribute("data-cluster");
      let startX = 0, startY = 0;
      let initialLeft = 0, initialTop = 0;
      let dragging = false;

      const onStart = (clientX, clientY) => {
        if (!isEditing) return;
        dragging = true;
        startX = clientX;
        startY = clientY;
        const rect = el.getBoundingClientRect();
        initialLeft = rect.left;
        initialTop = rect.top;
        el.style.transform = "none";
        el.style.bottom = "auto";
        el.style.right = "auto";
        el.style.left = initialLeft + "px";
        el.style.top = initialTop + "px";
        el.classList.add("dragging");
      };

      const onMove = (clientX, clientY) => {
        if (!dragging || !isEditing) return;
        const dx = clientX - startX;
        const dy = clientY - startY;

        let newLeft = initialLeft + dx;
        let newTop = initialTop + dy;

        // Limiti schermo
        const rect = el.getBoundingClientRect();
        const maxLeft = window.innerWidth - rect.width;
        const maxTop = window.innerHeight - rect.height;

        newLeft = Math.max(0, Math.min(newLeft, maxLeft));
        newTop = Math.max(0, Math.min(newTop, maxTop));

        el.style.left = newLeft + "px";
        el.style.top = newTop + "px";
      };

      const onEnd = () => {
        if (!dragging) return;
        dragging = false;
        el.classList.remove("dragging");
        // Salva le coordinate del cluster
        currentLayout.clusters[clusterKey] = {
          left: el.style.left,
          top: el.style.top,
          bottom: "auto",
          right: "auto",
          transformX: null
        };
        saveCurrentLayout();
      };

      // Mouse
      el.addEventListener("mousedown", (e) => {
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
      el.addEventListener("touchstart", (e) => {
        if (!isEditing) return;
        e.preventDefault();
        e.stopPropagation();
        const t = e.touches[0];
        onStart(t.clientX, t.clientY);
      }, { passive: false });

      el.addEventListener("touchmove", (e) => {
        if (!isEditing || !dragging) return;
        e.preventDefault();
        e.stopPropagation();
        const t = e.touches[0];
        onMove(t.clientX, t.clientY);
      }, { passive: false });

      el.addEventListener("touchend", (e) => {
        if (!isEditing) return;
        onEnd();
      });
      el.addEventListener("touchcancel", (e) => {
        if (!isEditing) return;
        onEnd();
      });
    });

    // Toolbar controlli dimensione / opacita
    const sizeSlider = document.getElementById("touchSizeSlider");
    const sizeLabel = document.getElementById("touchSizeLabel");
    if (sizeSlider) {
      sizeSlider.addEventListener("input", (e) => {
        const val = parseFloat(e.target.value);
        currentLayout.scale = val;
        if (sizeLabel) sizeLabel.innerText = Math.round(val * 100) + "%";
        const overlay = document.getElementById("touchControlsOverlay");
        if (overlay) overlay.style.setProperty("--touch-scale", val);
        saveCurrentLayout();
      });
    }

    const opacitySlider = document.getElementById("touchOpacitySlider");
    const opacityLabel = document.getElementById("touchOpacityLabel");
    if (opacitySlider) {
      opacitySlider.addEventListener("input", (e) => {
        const val = parseFloat(e.target.value);
        currentLayout.opacity = val;
        if (opacityLabel) opacityLabel.innerText = Math.round(val * 100) + "%";
        const overlay = document.getElementById("touchControlsOverlay");
        if (overlay) overlay.style.setProperty("--touch-opacity", val);
        saveCurrentLayout();
      });
    }

    // Reset layout
    const btnReset = document.getElementById("btnResetTouchLayout");
    if (btnReset) {
      btnReset.addEventListener("click", () => {
        currentLayout = JSON.parse(JSON.stringify(DEFAULT_LAYOUT));
        saveCurrentLayout();
        applyLayoutToDom();
      });
    }

    // Salva e chiudi edit mode
    const btnClose = document.getElementById("btnCloseTouchEdit");
    if (btnClose) {
      btnClose.addEventListener("click", () => {
        toggleEditMode(false);
      });
    }
  }

  function toggleEditMode(enable) {
    isEditing = enable !== undefined ? enable : !isEditing;
    const overlay = document.getElementById("touchControlsOverlay");
    const toolbar = document.getElementById("touchEditToolbar");
    const btnEdit = document.getElementById("btnEditTouchLayout");

    if (overlay) overlay.classList.toggle("editing-mode", isEditing);
    if (toolbar) toolbar.style.display = isEditing ? "flex" : "none";
    if (btnEdit) {
      btnEdit.innerText = isEditing ? "[OK] Salva Posizioni" : "[Edit] Sposta Controlli";
      btnEdit.classList.toggle("active", isEditing);
    }
  }

  // Interruttore on/off e rilevamento browser
  function setupToggleAndDetection() {
    const chk = document.getElementById("chkTouchControls");
    const btnEdit = document.getElementById("btnEditTouchLayout");
    const overlay = document.getElementById("touchControlsOverlay");

    // Rileva se il dispositivo supporta il touch
    const isTouchDevice =
      "ontouchstart" in window ||
      navigator.maxTouchPoints > 0 ||
      (window.matchMedia && window.matchMedia("(pointer: coarse)").matches) ||
      window.innerWidth <= 850;

    let isEnabled = false;
    const saved = localStorage.getItem(STORAGE_KEY_ENABLED);
    if (saved !== null) {
      isEnabled = saved === "true";
    } else {
      isEnabled = isTouchDevice;
    }

    function setOverlayVisibility(show) {
      if (overlay) overlay.style.display = show ? "block" : "none";
      if (btnEdit) btnEdit.style.display = show ? "inline-flex" : "none";
      if (chk) chk.checked = show;
      if (!show && isEditing) toggleEditMode(false);
      try { localStorage.setItem(STORAGE_KEY_ENABLED, show ? "true" : "false"); } catch (e) {}
    }

    if (chk) {
      chk.addEventListener("change", (e) => {
        setOverlayVisibility(e.target.checked);
      });
    }

    if (btnEdit) {
      btnEdit.addEventListener("click", () => {
        toggleEditMode();
      });
    }

    setOverlayVisibility(isEnabled);
  }

  // Avvio al caricamento del DOM
  function init() {
    loadSavedLayout();
    applyLayoutToDom();
    setupDpad();
    setupActionButtons();
    setupDragAndDrop();
    setupToggleAndDetection();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }

  window.touchControls = {
    toggle: (val) => {
      const chk = document.getElementById("chkTouchControls");
      if (chk) {
        chk.checked = val !== undefined ? val : !chk.checked;
        chk.dispatchEvent(new Event("change"));
      }
    },
    edit: toggleEditMode,
    reset: () => {
      currentLayout = JSON.parse(JSON.stringify(DEFAULT_LAYOUT));
      saveCurrentLayout();
      applyLayoutToDom();
    }
  };

})();
