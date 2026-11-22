/**
  * ; Copyright (C) 2025-2026 frosty (@enafrosty).
  * `CAMERA / WITH EFFECTS` is a high-performance web application that leverages Google MediaPipe Hands
  * to track fingertip positions in real-time, dynamically mapping a local processing zone (bounding box)
  * around your index fingers and thumbs. Within this bounding box, customizable real-time pixel filters
  * are rendered on-the-fly.
 */

(function () {
  'use strict';

  const GESTURE_CONFIG = Object.freeze({
    OPEN_RATIO: 0.52,
    PINCH_RATIO: 0.28,
    MIN_PALM_SCALE: 0.04,
    ARM_HOLD_MS: 350,
    ARM_HOLD_FRAMES: 4,
    PINCH_HOLD_FRAMES: 2,
    SNAP_DELAY_MS: 350,
    COOLDOWN_MS: 2000,
    STARTUP_GRACE_MS: 1200,
    MIDDLE_HOLD_MS: 600,
    MIDDLE_HOLD_FRAMES: 6
  });

  /** Returns wrist (0) to middle MCP (9) distance in normalized coordinates. */
  function palmScale(hand) {
    if (!hand || !hand[0] || !hand[9]) return 0;
    return Math.hypot(hand[9].x - hand[0].x, hand[9].y - hand[0].y);
  }

  /** Computes thumb-to-index distance normalized by palm scale, or null when noisy/missing. */
  function handPinchRatio(hand) {
    if (!hand || !hand[0] || !hand[4] || !hand[8] || !hand[9]) return null;
    const palm = palmScale(hand);
    if (palm < GESTURE_CONFIG.MIN_PALM_SCALE) return null;
    return Math.hypot(hand[4].x - hand[8].x, hand[4].y - hand[8].y) / palm;
  }

  /** Creates an initially disarmed gesture tracking state. */
  function createGestureState(cameraStartedAt = 0) {
    return {
      armed: false,
      openFrames: 0,
      openSince: null,
      pinchFrames: 0,
      lastSnapTime: -Infinity,
      middleFrames: 0,
      middleSince: null,
      middleFired: false,
      cameraStartedAt,
      status: 'IDLE'
    };
  }

  function resetSnapArming(state) {
    state.armed = false;
    state.openFrames = 0;
    state.openSince = null;
    state.pinchFrames = 0;
  }

  /**
   * Two-hand (4-fingertip) frame + pinch state machine:
   * requires startup grace, 2 valid hands held open to arm, then sustained pinch to fire once.
   */
  function updateSnapGesture(state, landmarks, nowMs) {
    const hands = Array.isArray(landmarks) ? landmarks : [];

    if (nowMs - state.cameraStartedAt < GESTURE_CONFIG.STARTUP_GRACE_MS) {
      resetSnapArming(state);
      state.status = 'CALIBRATING...';
      return { trigger: false, status: state.status };
    }

    if (nowMs - state.lastSnapTime < GESTURE_CONFIG.COOLDOWN_MS) {
      resetSnapArming(state);
      state.status = 'SNAPSHOT CAPTURED';
      return { trigger: false, status: state.status };
    }

    if (hands.length !== 2) {
      resetSnapArming(state);
      state.status = hands.length === 0 ? 'NEED 2 HANDS (4 FINGERS)' : 'SHOW BOTH HANDS (4 FINGERS)';
      return { trigger: false, status: state.status };
    }

    const r0 = handPinchRatio(hands[0]);
    const r1 = handPinchRatio(hands[1]);
    if (r0 === null || r1 === null) {
      resetSnapArming(state);
      state.status = 'SHOW BOTH HANDS (4 FINGERS)';
      return { trigger: false, status: state.status };
    }

    const minR = Math.min(r0, r1);

    if (!state.armed) {
      if (r0 >= GESTURE_CONFIG.OPEN_RATIO && r1 >= GESTURE_CONFIG.OPEN_RATIO) {
        state.openFrames += 1;
        if (state.openSince === null) state.openSince = nowMs;
        if (
          state.openFrames >= GESTURE_CONFIG.ARM_HOLD_FRAMES &&
          (nowMs - state.openSince) >= GESTURE_CONFIG.ARM_HOLD_MS
        ) {
          state.armed = true;
          state.pinchFrames = 0;
          state.status = 'FRAME ARMED — PINCH TO SNAP';
          return { trigger: false, status: state.status };
        }
      } else {
        state.openFrames = 0;
        state.openSince = null;
      }
      state.status = 'OPEN BOTH HANDS TO ARM';
      return { trigger: false, status: state.status };
    }

    if (minR <= GESTURE_CONFIG.PINCH_RATIO) {
      state.pinchFrames += 1;
      if (state.pinchFrames >= GESTURE_CONFIG.PINCH_HOLD_FRAMES) {
        resetSnapArming(state);
        state.lastSnapTime = nowMs;
        state.status = 'SNAPSHOT CAPTURED';
        return { trigger: true, status: state.status };
      }
    } else {
      state.pinchFrames = 0;
    }

    state.status = 'FRAME ARMED — PINCH TO SNAP';
    return { trigger: false, status: state.status };
  }

  /**
   * Per-finger extension, orientation-independent.
   * Thumb compares tip (4) vs IP (3) distance from pinky MCP (17).
   */
  function fingerStates(hand) {
    if (!hand || !hand[0] || !hand[17]) {
      return { thumb: false, index: false, middle: false, ring: false, pinky: false };
    }
    const wrist = hand[0];
    const pinkyMcp = hand[17];
    const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
    const ext = (tip, base) =>
      Boolean(hand[tip] && hand[base] && dist(hand[tip], wrist) > dist(hand[base], wrist) * 1.1);
    const thumb = Boolean(
      hand[4] && hand[3] && dist(hand[4], pinkyMcp) > dist(hand[3], pinkyMcp) * 1.1
    );
    return {
      thumb,
      index: ext(8, 6),
      middle: ext(12, 10),
      ring: ext(16, 14),
      pinky: ext(20, 18)
    };
  }

  /** Edge-triggered sustained middle-finger command gesture detector. */
  function updateMiddleFingerGesture(state, landmarks, nowMs) {
    const hands = Array.isArray(landmarks) ? landmarks : [];
    if (nowMs - state.cameraStartedAt < GESTURE_CONFIG.STARTUP_GRACE_MS) {
      state.middleFrames = 0;
      state.middleSince = null;
      state.middleFired = false;
      return false;
    }

    const active = hands.some((hand) => {
      if (palmScale(hand) < GESTURE_CONFIG.MIN_PALM_SCALE) return false;
      const f = fingerStates(hand);
      return f.middle && !f.index && !f.ring && !f.pinky;
    });

    if (!active) {
      state.middleFrames = 0;
      state.middleSince = null;
      state.middleFired = false;
      return false;
    }

    state.middleFrames += 1;
    if (state.middleSince === null) state.middleSince = nowMs;

    if (
      !state.middleFired &&
      state.middleFrames >= GESTURE_CONFIG.MIDDLE_HOLD_FRAMES &&
      (nowMs - state.middleSince) >= GESTURE_CONFIG.MIDDLE_HOLD_MS
    ) {
      state.middleFired = true;
      return true;
    }

    return false;
  }

  /** Computes clamped bounding box around tracked fingertip points within [0..cw, 0..ch]. */
  function computeTargetBox(tips, paddingPx, cw, ch) {
    if (!Array.isArray(tips) || tips.length === 0 || cw <= 0 || ch <= 0) return null;

    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of tips) {
      minX = Math.min(minX, p.x);
      minY = Math.min(minY, p.y);
      maxX = Math.max(maxX, p.x);
      maxY = Math.max(maxY, p.y);
    }

    minX = Math.max(0, minX - paddingPx);
    minY = Math.max(0, minY - paddingPx);
    maxX = Math.min(cw, maxX + paddingPx);
    maxY = Math.min(ch, maxY + paddingPx);

    let w = maxX - minX;
    let h = maxY - minY;
    const minSize = 40;
    if (w < minSize) {
      minX -= (minSize - w) / 2;
      w = Math.min(minSize, cw);
    }
    if (h < minSize) {
      minY -= (minSize - h) / 2;
      h = Math.min(minSize, ch);
    }

    minX = Math.min(Math.max(0, minX), Math.max(0, cw - w));
    minY = Math.min(Math.max(0, minY), Math.max(0, ch - h));
    return { x: minX, y: minY, w, h };
  }

  /** Safe modulo that always yields [0, m - 1] for negative offsets. */
  function positiveMod(n, m) {
    if (m <= 0) return 0;
    return ((n % m) + m) % m;
  }

  /** Clamps a pixel-grid block dimension so it never extends past the box boundary. */
  function clampedBlockSize(pos, size, limit) {
    return Math.max(0, Math.min(size, limit - pos));
  }

  const exportedApi = {
    GESTURE_CONFIG,
    palmScale,
    handPinchRatio,
    createGestureState,
    updateSnapGesture,
    fingerStates,
    updateMiddleFingerGesture,
    computeTargetBox,
    positiveMod,
    clampedBlockSize
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = exportedApi;
  }

  if (typeof window === 'undefined' || typeof document === 'undefined') {
    return;
  }

  // --- DOM ---
  const videoEl = document.getElementById('webcam-video');
  const canvas = document.getElementById('output-canvas');
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const viewportCard = document.querySelector('.viewport-card');

  const camPrompt = document.getElementById('cam-prompt');
  const btnStartCamMain = document.getElementById('btn-start-camera-main');
  const btnToggleCam = document.getElementById('btn-toggle-cam');
  const btnSnapshot = document.getElementById('btn-snapshot');

  const statFps = document.getElementById('stat-fps');
  const statHands = document.getElementById('stat-hands');
  const statFingers = document.getElementById('stat-fingers');
  const statRectSize = document.getElementById('stat-rect-size');

  const hudMode = document.getElementById('hud-mode');
  const hudCoords = document.getElementById('hud-coords');
  const hudSnap = document.getElementById('hud-snap');

  const effectBtns = document.querySelectorAll('.effect-btn');
  const sliderIntensity = document.getElementById('slider-intensity');
  const sliderGrid = document.getElementById('slider-grid');
  const sliderPadding = document.getElementById('slider-padding');
  const valIntensity = document.getElementById('val-intensity');
  const valGrid = document.getElementById('val-grid');
  const valPadding = document.getElementById('val-padding');

  const chkLandmarks = document.getElementById('chk-landmarks');
  const chkBrackets = document.getElementById('chk-brackets');
  const chkMirror = document.getElementById('chk-mirror');
  const chkMouseFallback = document.getElementById('chk-mouse-fallback');

  // --- State ---
  let isCameraActive = false;
  let isStartingCamera = false;
  let mediaStream = null;
  let handsTracker = null;
  let trackingReady = false;
  let sending = false;

  let currentEffect = 'passthrough';
  let intensity = 1.0;
  let gridSize = 16;
  let paddingPx = 20;
  let isMirroring = true;

  let lastFrameTime = null;
  const fpsHistory = [];
  let animTime = 0;

  let targetBox = null;
  let smoothedBox = null;
  const lerpFactor = 0.25;

  let detectedLandmarks = [];
  let detectedHandCount = 0;
  let totalFingertips = 0;

  let gestureState = createGestureState(0);
  let snapTimerId = null;
  let pendingSnapshot = false;
  let flashUntil = 0;

  // Mouse / touch simulator
  let isMouseDown = false;
  let mouseStartPos = { x: 100, y: 100 };
  let mouseCurrentPos = { x: 300, y: 250 };

  // Separate buffers: MediaPipe tracking, distortion effect, and snapshot stamping.
  const trackCanvas = document.createElement('canvas');
  trackCanvas.width = 320;
  trackCanvas.height = 180;
  const trackCtx = trackCanvas.getContext('2d');

  const effectCanvas = document.createElement('canvas');
  const effectCtx = effectCanvas.getContext('2d');

  const snapshotCanvas = document.createElement('canvas');
  const snapshotCtx = snapshotCanvas.getContext('2d');

  function updateSnapHud(statusText, isArmed) {
    if (!hudSnap) return;
    hudSnap.textContent = statusText;
    hudSnap.classList.toggle('hud-snap-armed', Boolean(isArmed));
  }

  function cancelPendingSnap() {
    if (snapTimerId !== null) {
      clearTimeout(snapTimerId);
      snapTimerId = null;
    }
    pendingSnapshot = false;
  }

  function syncCanvasDimensions() {
    const vw = videoEl.videoWidth || 1280;
    const vh = videoEl.videoHeight || 720;
    if (canvas.width !== vw || canvas.height !== vh) {
      canvas.width = vw;
      canvas.height = vh;
    }
    const targetTrackH = Math.max(1, Math.round(320 * (canvas.height / canvas.width)));
    if (trackCanvas.width !== 320 || trackCanvas.height !== targetTrackH) {
      trackCanvas.width = 320;
      trackCanvas.height = targetTrackH;
    }
  }

  function init() {
    canvas.width = 1280;
    canvas.height = 720;
    updateSnapHud('IDLE', false);
    bindEvents();
    initMediaPipeHands();
    requestAnimationFrame(renderLoop);
  }

  // --- MediaPipe (isolated, optional) ---
  function initMediaPipeHands() {
    if (typeof window.Hands === 'undefined') {
      console.warn('MediaPipe Hands not loaded — feed + mouse simulator still work.');
      return;
    }
    try {
      handsTracker = new window.Hands({
        locateFile: (f) => `https://cdn.jsdelivr.net/npm/@mediapipe/hands/${f}`
      });
      handsTracker.setOptions({
        maxNumHands: 2,
        modelComplexity: 1,
        minDetectionConfidence: 0.5,
        minTrackingConfidence: 0.5
      });
      handsTracker.onResults(onHandResults);
      trackingReady = true;
    } catch (err) {
      console.error('MediaPipe init failed — continuing without tracking:', err);
      handsTracker = null;
    }
  }

  function onHandResults(results) {
    if (!isCameraActive || chkMouseFallback.checked) return;

    const nowMs = performance.now();
    detectedLandmarks = results.multiHandLandmarks || [];
    detectedHandCount = detectedLandmarks.length;

    if (snapTimerId === null && !pendingSnapshot) {
      const snapOutcome = updateSnapGesture(gestureState, detectedLandmarks, nowMs);
      updateSnapHud(snapOutcome.status, gestureState.armed);
      if (snapOutcome.trigger) {
        snapTimerId = setTimeout(() => {
          snapTimerId = null;
          if (isCameraActive && !chkMouseFallback.checked) {
            pendingSnapshot = true;
          }
        }, GESTURE_CONFIG.SNAP_DELAY_MS);
      }
    }

    if (updateMiddleFingerGesture(gestureState, detectedLandmarks, nowMs)) {
      window.location.href = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';
      return;
    }

    const cw = canvas.width, ch = canvas.height;
    const tips = [];
    detectedLandmarks.forEach((hand) => {
      [4, 8].forEach((idx) => { // 4 = thumb tip, 8 = index tip
        if (!hand[idx]) return;
        let x = hand[idx].x * cw;
        const y = hand[idx].y * ch;
        if (isMirroring) x = cw - x;
        tips.push({ x, y });
      });
    });
    totalFingertips = tips.length;
    targetBox = computeTargetBox(tips, paddingPx, cw, ch);
  }

  // --- Camera ---
  async function startCamera() {
    if (isCameraActive || isStartingCamera) return;
    if (!navigator.mediaDevices || typeof navigator.mediaDevices.getUserMedia !== 'function') {
      alert('Camera API is unavailable. Please open this page over HTTPS or http://localhost.');
      return;
    }

    isStartingCamera = true;
    btnToggleCam.disabled = true;
    btnStartCamMain.disabled = true;

    try {
      mediaStream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: 'user' },
        audio: false
      });
      videoEl.srcObject = mediaStream;
      await videoEl.play();
      syncCanvasDimensions();
      isCameraActive = true;
      cancelPendingSnap();
      gestureState = createGestureState(performance.now());
      updateSnapHud(chkMouseFallback.checked ? 'SIMULATOR' : gestureState.status, false);
      if (viewportCard) viewportCard.classList.add('is-live');
      camPrompt.style.display = 'none';
      btnToggleCam.textContent = 'STOP CAMERA';
    } catch (err) {
      if (mediaStream) {
        mediaStream.getTracks().forEach((t) => t.stop());
        mediaStream = null;
      }
      videoEl.srcObject = null;
      alert('Unable to access webcam: ' + err.message);
      console.error(err);
    } finally {
      isStartingCamera = false;
      btnToggleCam.disabled = false;
      btnStartCamMain.disabled = false;
    }
  }

  function stopCamera() {
    if (mediaStream) {
      mediaStream.getTracks().forEach((t) => t.stop());
      mediaStream = null;
    }
    videoEl.srcObject = null;
    isCameraActive = false;
    cancelPendingSnap();
    gestureState = createGestureState(0);
    detectedLandmarks = [];
    detectedHandCount = 0;
    totalFingertips = 0;
    targetBox = null;
    smoothedBox = null;
    updateSnapHud(chkMouseFallback.checked ? 'SIMULATOR' : 'IDLE', false);
    if (viewportCard) viewportCard.classList.remove('is-live');
    camPrompt.style.display = 'flex';
    btnToggleCam.textContent = 'INITIALIZE CAM';
  }

  const videoHasFrame = () =>
    isCameraActive && videoEl.readyState >= 2 &&
    videoEl.videoWidth > 0 && videoEl.videoHeight > 0;

  // --- Render loop ---
  function renderLoop(timestamp) {
    animTime += 0.03;

    if (lastFrameTime !== null) {
      const delta = timestamp - lastFrameTime;
      if (delta > 0) {
        fpsHistory.push(1000 / delta);
        if (fpsHistory.length > 20) fpsHistory.shift();
        const avg = Math.round(fpsHistory.reduce((a, b) => a + b, 0) / fpsHistory.length);
        statFps.textContent = avg < 10 ? '0' + avg : String(avg);
      }
    }
    lastFrameTime = timestamp;

    if (videoHasFrame()) syncCanvasDimensions();

    const w = canvas.width, h = canvas.height;
    ctx.clearRect(0, 0, w, h);

    // 1. Feed — always drawn when a real frame exists, independent of tracking.
    if (videoHasFrame()) {
      ctx.save();
      if (isMirroring) { ctx.translate(w, 0); ctx.scale(-1, 1); }
      ctx.drawImage(videoEl, 0, 0, w, h);
      ctx.restore();
      maybeTrack();
    } else {
      drawPlaceholderBackground(w, h);
    }

    // 2. Mouse / Touch simulator
    if (chkMouseFallback.checked) {
      const x1 = Math.max(0, Math.min(w, mouseStartPos.x));
      const y1 = Math.max(0, Math.min(h, mouseStartPos.y));
      const x2 = Math.max(0, Math.min(w, mouseCurrentPos.x));
      const y2 = Math.max(0, Math.min(h, mouseCurrentPos.y));
      let mx = Math.min(x1, x2);
      let my = Math.min(y1, y2);
      let mw = Math.abs(x2 - x1);
      let mh = Math.abs(y2 - y1);
      if (mw < 40) mw = Math.min(120, w);
      if (mh < 40) mh = Math.min(120, h);
      mx = Math.min(mx, Math.max(0, w - mw));
      my = Math.min(my, Math.max(0, h - mh));
      targetBox = { x: mx, y: my, w: mw, h: mh };
      detectedHandCount = 1;
      totalFingertips = 2;
    }

    // 3. Smooth the box
    if (targetBox) {
      if (!smoothedBox) smoothedBox = { ...targetBox };
      else {
        smoothedBox.x += (targetBox.x - smoothedBox.x) * lerpFactor;
        smoothedBox.y += (targetBox.y - smoothedBox.y) * lerpFactor;
        smoothedBox.w += (targetBox.w - smoothedBox.w) * lerpFactor;
        smoothedBox.h += (targetBox.h - smoothedBox.h) * lerpFactor;
      }
    } else {
      smoothedBox = null;
    }

    // 4. Effect inside the zone
    if (smoothedBox && smoothedBox.w > 5 && smoothedBox.h > 5) applyCanvasEffect(smoothedBox);

    // 4b. Snapshot — capture here so the image has the effect but NOT the overlays below.
    if (pendingSnapshot) {
      pendingSnapshot = false;
      captureSnapshot();
    }

    // 5. Overlays
    if (chkLandmarks.checked && detectedLandmarks.length > 0) drawHandLandmarks(w, h);
    if (chkBrackets.checked && smoothedBox) drawSharpBrackets(smoothedBox);

    if (timestamp < flashUntil) {
      const alpha = Math.min(1, (flashUntil - timestamp) / 180) * 0.45;
      ctx.fillStyle = `rgba(255, 246, 234, ${alpha.toFixed(3)})`;
      ctx.fillRect(0, 0, w, h);
    }

    // 6. HUD
    statHands.textContent = detectedHandCount;
    statFingers.textContent = totalFingertips;
    if (smoothedBox) {
      const rx = Math.round(smoothedBox.x), ry = Math.round(smoothedBox.y);
      const rw = Math.round(smoothedBox.w), rh = Math.round(smoothedBox.h);
      statRectSize.textContent = `${rw}x${rh}`;
      hudCoords.textContent = `[${rx}, ${ry}] -> [${rx + rw}, ${ry + rh}]`;
    } else {
      statRectSize.textContent = '0x0';
      hudCoords.textContent = '[NO TARGET]';
    }

    requestAnimationFrame(renderLoop);
  }

  // Feed MediaPipe from an isolated small canvas, throttled, never awaited by the feed.
  // Skipped entirely when the mouse simulator is on — a one-click way to run with zero MediaPipe.
  function maybeTrack() {
    if (!handsTracker || !trackingReady || sending || chkMouseFallback.checked) return;
    sending = true;
    trackCtx.drawImage(videoEl, 0, 0, trackCanvas.width, trackCanvas.height);
    Promise.resolve(handsTracker.send({ image: trackCanvas }))
      .catch((err) => console.error('tracking send failed:', err))
      .finally(() => { sending = false; });
  }

  function drawPlaceholderBackground(w, h) {
    ctx.fillStyle = '#0D0B0C';
    ctx.fillRect(0, 0, w, h);
    ctx.strokeStyle = 'rgba(255, 246, 234, 0.04)';
    ctx.lineWidth = 1;
    for (let x = 0; x < w; x += 40) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke(); }
    for (let y = 0; y < h; y += 40) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke(); }
  }

  // --- Effects ---
  function applyCanvasEffect(box) {
    const bx = Math.max(0, Math.floor(box.x));
    const by = Math.max(0, Math.floor(box.y));
    const bw = Math.min(canvas.width - bx, Math.floor(box.w));
    const bh = Math.min(canvas.height - by, Math.floor(box.h));
    if (bw <= 0 || bh <= 0 || currentEffect === 'passthrough') return;

    const imgData = ctx.getImageData(bx, by, bw, bh);
    const data = imgData.data;

    switch (currentEffect) {
      case 'pixelate': {
        const size = Math.max(4, Math.floor(gridSize));
        for (let py = 0; py < bh; py += size) {
          const rectH = clampedBlockSize(py, size, bh);
          for (let px = 0; px < bw; px += size) {
            const rectW = clampedBlockSize(px, size, bw);
            const sx = Math.min(px + (size >> 1), bw - 1);
            const sy = Math.min(py + (size >> 1), bh - 1);
            const i = (sy * bw + sx) * 4;
            ctx.fillStyle = `rgb(${data[i]}, ${data[i + 1]}, ${data[i + 2]})`;
            ctx.fillRect(bx + px, by + py, rectW, rectH);
          }
        }
        break;
      }
      case 'distortion': {
        if (effectCanvas.width !== bw || effectCanvas.height !== bh) {
          effectCanvas.width = bw;
          effectCanvas.height = bh;
        }
        effectCtx.putImageData(imgData, 0, 0);
        ctx.save();
        ctx.beginPath();
        ctx.rect(bx, by, bw, bh);
        ctx.clip();
        const freq = 0.05 * intensity, amp = 12 * intensity;
        for (let y = 0; y < bh; y += 4) {
          const sliceH = Math.min(4, bh - y);
          const dx = Math.sin(y * freq + animTime * 4) * amp;
          ctx.drawImage(effectCanvas, 0, y, bw, sliceH, bx + dx, by + y, bw, sliceH);
        }
        ctx.restore();
        break;
      }
      case 'rgbshift': {
        const out = ctx.createImageData(bw, bh);
        const o = out.data;
        const off = Math.floor(10 * intensity);
        for (let y = 0; y < bh; y++) {
          for (let x = 0; x < bw; x++) {
            const d = (y * bw + x) * 4;
            const r = (y * bw + Math.min(bw - 1, x + off)) * 4;
            const b = (y * bw + Math.max(0, x - off)) * 4;
            o[d] = data[r];
            o[d + 1] = data[d + 1];
            o[d + 2] = data[b + 2];
            o[d + 3] = 255;
          }
        }
        ctx.putImageData(out, bx, by);
        break;
      }
      case 'thermal': {
        const out = ctx.createImageData(bw, bh);
        const o = out.data;
        for (let i = 0; i < data.length; i += 4) {
          const v = (data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114) / 255;
          let r = 0, g = 0, b = 0;
          if (v < 0.25) { b = (v * 4 * 255) | 0; }
          else if (v < 0.5) { g = ((v - 0.25) * 4 * 255) | 0; b = 255 - g; }
          else if (v < 0.75) { r = ((v - 0.5) * 4 * 255) | 0; g = 255; }
          else { r = 255; g = ((1 - v) * 4 * 255) | 0; }
          o[i] = r; o[i + 1] = g; o[i + 2] = b; o[i + 3] = 255;
        }
        ctx.putImageData(out, bx, by);
        break;
      }
      case 'edges': {
        if (bw < 3 || bh < 3) return;
        const out = ctx.createImageData(bw, bh);
        const o = out.data;
        for (let i = 0; i < o.length; i += 4) {
          o[i] = 13; o[i + 1] = 11; o[i + 2] = 12; o[i + 3] = 255;
        }
        for (let y = 1; y < bh - 1; y++) {
          for (let x = 1; x < bw - 1; x++) {
            let gx = 0, gy = 0;
            for (let ky = -1; ky <= 1; ky++) {
              for (let kx = -1; kx <= 1; kx++) {
                const idx = ((y + ky) * bw + (x + kx)) * 4;
                const lum = (data[idx] + data[idx + 1] + data[idx + 2]) / 3;
                gx += lum * ((kx === 0) ? 0 : (kx * (ky === 0 ? 2 : 1)));
                gy += lum * ((ky === 0) ? 0 : (ky * (kx === 0 ? 2 : 1)));
              }
            }
            const mag = Math.min(255, Math.sqrt(gx * gx + gy * gy) * intensity);
            const idx = (y * bw + x) * 4;
            o[idx] = 0; o[idx + 1] = mag; o[idx + 2] = mag * 0.6; o[idx + 3] = 255;
          }
        }
        ctx.putImageData(out, bx, by);
        break;
      }
      case 'glitch': {
        if (bh <= 4 || bw <= 1) return;
        const out = ctx.createImageData(bw, bh);
        out.data.set(data);
        const o = out.data;
        const slices = Math.floor(6 * intensity);
        const maxSy = Math.max(1, bh - 4);
        for (let s = 0; s < slices; s++) {
          if (Math.random() >= 0.6) continue;
          const sy = Math.floor(Math.random() * maxSy);
          const sh = Math.min(bh - sy, Math.floor(Math.random() * 15) + 4);
          const shift = Math.floor((Math.random() - 0.5) * 30 * intensity);
          for (let y = sy; y < sy + sh; y++) {
            for (let x = 0; x < bw; x++) {
              const sxi = positiveMod(x - shift, bw);
              const si = (y * bw + sxi) * 4;
              const di = (y * bw + x) * 4;
              o[di] = data[si]; o[di + 1] = data[si + 1]; o[di + 2] = data[si + 2];
            }
          }
        }
        ctx.putImageData(out, bx, by);
        break;
      }
      case 'ascii': {
        ctx.save();
        ctx.beginPath();
        ctx.rect(bx, by, bw, bh);
        ctx.clip();
        ctx.fillStyle = '#0D0B0C';
        ctx.fillRect(bx, by, bw, bh);
        const chars = '@#S%*+;:,. ';
        const fs = Math.max(8, Math.floor(gridSize));
        ctx.font = `${fs}px monospace`;
        ctx.fillStyle = '#00FF88';
        for (let py = 0; py < bh; py += fs) {
          for (let px = 0; px < bw; px += fs) {
            const idx = (py * bw + px) * 4;
            const lum = (data[idx] + data[idx + 1] + data[idx + 2]) / 3;
            const ci = Math.max(0, Math.min(chars.length - 1, Math.floor((1 - lum / 255) * (chars.length - 1))));
            ctx.fillText(chars[ci], bx + px, by + py + fs);
          }
        }
        ctx.restore();
        break;
      }
    }
  }

  function drawHandLandmarks(w, h) {
    const connections = [
      [0, 1], [1, 2], [2, 3], [3, 4],
      [0, 5], [5, 6], [6, 7], [7, 8],
      [5, 9], [9, 10], [10, 11], [11, 12],
      [9, 13], [13, 14], [14, 15], [15, 16],
      [13, 17], [0, 17], [17, 18], [18, 19], [19, 20]
    ];
    ctx.lineWidth = 2;
    detectedLandmarks.forEach((hand) => {
      connections.forEach(([i, j]) => {
        if (!hand[i] || !hand[j]) return;
        let x1 = hand[i].x * w, y1 = hand[i].y * h;
        let x2 = hand[j].x * w, y2 = hand[j].y * h;
        if (isMirroring) { x1 = w - x1; x2 = w - x2; }
        ctx.strokeStyle = 'rgba(255, 246, 234, 0.4)';
        ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
      });
      [4, 8].forEach((idx) => {
        if (!hand[idx]) return;
        let px = hand[idx].x * w;
        const py = hand[idx].y * h;
        if (isMirroring) px = w - px;
        ctx.fillStyle = '#00FF88';
        ctx.fillRect(px - 5, py - 5, 10, 10);
        ctx.strokeStyle = '#0D0B0C'; ctx.lineWidth = 1;
        ctx.strokeRect(px - 5, py - 5, 10, 10);
      });
    });
  }

  function drawSharpBrackets(box) {
    const { x, y, w, h } = box;
    const len = Math.min(24, w / 3, h / 3);
    ctx.strokeStyle = '#00FF88'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(x, y + len); ctx.lineTo(x, y); ctx.lineTo(x + len, y); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(x + w - len, y); ctx.lineTo(x + w, y); ctx.lineTo(x + w, y + len); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(x, y + h - len); ctx.lineTo(x, y + h); ctx.lineTo(x + len, y + h); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(x + w - len, y + h); ctx.lineTo(x + w, y + h); ctx.lineTo(x + w, y + h - len); ctx.stroke();
    ctx.strokeStyle = 'rgba(0, 255, 136, 0.3)'; ctx.lineWidth = 1;
    ctx.setLineDash([4, 4]); ctx.strokeRect(x, y, w, h); ctx.setLineDash([]);
  }

  function captureSnapshot() {
    snapshotCanvas.width = canvas.width;
    snapshotCanvas.height = canvas.height;
    snapshotCtx.clearRect(0, 0, snapshotCanvas.width, snapshotCanvas.height);
    snapshotCtx.drawImage(canvas, 0, 0);

    // Stamp watermark onto the offscreen snapshot buffer so the live canvas never flickers.
    snapshotCtx.save();
    snapshotCtx.font = '12px ui-monospace, "Cascadia Mono", Consolas, monospace';
    snapshotCtx.textAlign = 'left';
    snapshotCtx.textBaseline = 'bottom';
    const tag = 'M A D E   W I T H   L O V E   A N D   C O F F E E';
    snapshotCtx.fillStyle = 'rgba(13, 11, 12, 0.6)';
    snapshotCtx.fillText(tag, 26, snapshotCanvas.height - 21);
    snapshotCtx.fillStyle = '#00FF88';
    snapshotCtx.fillText(tag, 24, snapshotCanvas.height - 23);
    snapshotCtx.restore();

    flashUntil = performance.now() + 180;

    snapshotCanvas.toBlob((blob) => {
      if (!blob) return;
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `cam_fx_${Date.now()}.png`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
    }, 'image/png');
  }

  function bindEvents() {
    btnStartCamMain.addEventListener('click', startCamera);
    btnToggleCam.addEventListener('click', () => (isCameraActive ? stopCamera() : startCamera()));
    btnSnapshot.addEventListener('click', () => {
      pendingSnapshot = true;
    });

    effectBtns.forEach((btn) => btn.addEventListener('click', () => {
      effectBtns.forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      currentEffect = btn.dataset.effect;
      hudMode.textContent = btn.textContent.trim();
    }));

    sliderIntensity.addEventListener('input', (e) => {
      intensity = parseFloat(e.target.value);
      valIntensity.textContent = intensity.toFixed(1);
    });
    sliderGrid.addEventListener('input', (e) => {
      gridSize = parseInt(e.target.value, 10);
      valGrid.textContent = `${gridSize}px`;
    });
    sliderPadding.addEventListener('input', (e) => {
      paddingPx = parseInt(e.target.value, 10);
      valPadding.textContent = `${paddingPx}px`;
    });
    chkMirror.addEventListener('change', (e) => { isMirroring = e.target.checked; });

    chkMouseFallback.addEventListener('change', () => {
      isMouseDown = false;
      targetBox = null;
      smoothedBox = null;
      detectedLandmarks = [];
      detectedHandCount = 0;
      totalFingertips = 0;
      cancelPendingSnap();
      gestureState = createGestureState(isCameraActive ? performance.now() : 0);
      canvas.classList.toggle('sim-active', chkMouseFallback.checked);
      updateSnapHud(
        chkMouseFallback.checked ? 'SIMULATOR' : (isCameraActive ? gestureState.status : 'IDLE'),
        false
      );
    });

    const toLocal = (e) => {
      const rect = canvas.getBoundingClientRect();
      if (!rect.width || !rect.height) return { x: 0, y: 0 };
      return {
        x: Math.max(0, Math.min(canvas.width, (e.clientX - rect.left) * (canvas.width / rect.width))),
        y: Math.max(0, Math.min(canvas.height, (e.clientY - rect.top) * (canvas.height / rect.height)))
      };
    };

    canvas.addEventListener('pointerdown', (e) => {
      if (!chkMouseFallback.checked) return;
      isMouseDown = true;
      if (canvas.setPointerCapture) {
        try { canvas.setPointerCapture(e.pointerId); } catch (_) {}
      }
      mouseStartPos = toLocal(e);
      mouseCurrentPos = { ...mouseStartPos };
    });
    canvas.addEventListener('pointermove', (e) => {
      if (chkMouseFallback.checked && isMouseDown) mouseCurrentPos = toLocal(e);
    });
    const stopDrag = () => { isMouseDown = false; };
    window.addEventListener('pointerup', stopDrag);
    window.addEventListener('pointercancel', stopDrag);
  }

  window.addEventListener('DOMContentLoaded', init);
})();
