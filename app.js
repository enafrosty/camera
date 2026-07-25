/**
  * ; Copyright (C) 2025-2026 frosty (@enafrosty).
  * `CAMERA / WITH EFFECTS` is a high-performance web application that leverages Google MediaPipe Hands 
  * to track fingertip positions in real-time, dynamically mapping a local processing zone (bounding box) 
  * around your index finger and thumb. Within this bounding box, customizable real-time pixel filters are 
  * rendered on-the-fly.
 */

(function () {
  'use strict';

  // --- DOM ---
  const videoEl = document.getElementById('webcam-video');
  const canvas = document.getElementById('output-canvas');
  const ctx = canvas.getContext('2d', { willReadFrequently: true });

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
  let mediaStream = null;
  let handsTracker = null;
  let trackingReady = false;
  let sending = false;

  let currentEffect = 'passthrough';
  let intensity = 1.0;
  let gridSize = 16;
  let paddingPx = 20;
  let isMirroring = true;

  let lastFrameTime = performance.now();
  let fpsHistory = [];
  let animTime = 0;

  let targetBox = null;
  let smoothedBox = null;
  const lerpFactor = 0.25;

  let detectedLandmarks = [];
  let detectedHandCount = 0;
  let totalFingertips = 0;

  // Pinch-to-snap: fire once when thumb + index tips touch, re-arm when they separate.
  let pinchArmed = true;      // true = fingers currently open, ready to fire
  let pendingSnapshot = false;
  let lastActionGesture = null; // 'thumb' | 'middle' | null — for edge-triggered gestures
  const PINCH_CLOSE = 0.05;   // normalized thumb-index distance below this = pinched
  const PINCH_OPEN = 0.09;    // must separate past this to re-arm (hysteresis)
  const SNAP_DELAY_MS = 400;  // wait after pinch so fingers reopen before the shot fires

  // Mouse fallback
  let isMouseDown = false;
  let mouseStartPos = { x: 100, y: 100 };
  let mouseCurrentPos = { x: 300, y: 250 };

  // Separate buffer to feed MediaPipe — never the visible canvas or raw video.
  const trackCanvas = document.createElement('canvas');
  trackCanvas.width = 320;
  trackCanvas.height = 180;
  const trackCtx = trackCanvas.getContext('2d');

  function init() {
    canvas.width = 1280;
    canvas.height = 720;
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

  // Per-finger extension, orientation-independent: a finger is extended when its tip sits
  // farther from the wrist than its middle joint. Returns {thumb,index,middle,ring,pinky}.
  function fingerStates(hand) {
    const wrist = hand[0];
    const d = (p) => Math.hypot(p.x - wrist.x, p.y - wrist.y);
    const ext = (tip, base) => hand[tip] && hand[base] && d(hand[tip]) > d(hand[base]) * 1.1;
    return {
      thumb: ext(4, 2), index: ext(8, 6), middle: ext(12, 10),
      ring: ext(16, 14), pinky: ext(20, 18)
    };
  }

  function onHandResults(results) {
    detectedLandmarks = results.multiHandLandmarks || [];
    detectedHandCount = detectedLandmarks.length;

    // Pinch detection: closest thumb-index distance across all hands (normalized coords).
    let minPinch = Infinity;
    detectedLandmarks.forEach((hand) => {
      if (hand[4] && hand[8]) {
        minPinch = Math.min(minPinch, Math.hypot(hand[4].x - hand[8].x, hand[4].y - hand[8].y));
      }
    });
    if (minPinch > PINCH_OPEN) pinchArmed = true;
    else if (minPinch < PINCH_CLOSE && pinchArmed) {
      pinchArmed = false;
      setTimeout(() => { pendingSnapshot = true; }, SNAP_DELAY_MS); // let fingers reopen first
    }

    // Command gestures (edge-triggered: fire once when the pose first appears).
    let gesture = null;
    for (const hand of detectedLandmarks) {
      const f = fingerStates(hand);
      if (f.middle && !f.index && !f.ring && !f.pinky) { gesture = 'middle'; break; }
    }
    if (gesture && gesture !== lastActionGesture && gesture === 'middle') {
      window.location.href = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';
    }
    lastActionGesture = gesture;

    const cw = canvas.width, ch = canvas.height;
    const tips = [];
    detectedLandmarks.forEach((hand) => {
      [4, 8].forEach((idx) => {            // 4 = thumb tip, 8 = index tip
        if (!hand[idx]) return;
        let x = hand[idx].x * cw;
        const y = hand[idx].y * ch;
        if (isMirroring) x = cw - x;
        tips.push({ x, y });
      });
    });
    totalFingertips = tips.length;

    if (tips.length === 0) {
      if (!chkMouseFallback.checked) targetBox = null;
      return;
    }

    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    tips.forEach(p => {
      minX = Math.min(minX, p.x); minY = Math.min(minY, p.y);
      maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y);
    });
    minX = Math.max(0, minX - paddingPx);
    minY = Math.max(0, minY - paddingPx);
    maxX = Math.min(cw, maxX + paddingPx);
    maxY = Math.min(ch, maxY + paddingPx);
    let w = maxX - minX, h = maxY - minY;
    if (w < 40) { minX -= 20; w = 40; }
    if (h < 40) { minY -= 20; h = 40; }
    targetBox = { x: minX, y: minY, w, h };
  }

  // --- Camera ---
  async function startCamera() {
    if (isCameraActive) return;
    try {
      mediaStream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: 'user' },
        audio: false
      });
      videoEl.srcObject = mediaStream;
      await videoEl.play();
      isCameraActive = true;
      camPrompt.style.display = 'none';
      btnToggleCam.textContent = 'STOP CAMERA';
    } catch (err) {
      alert('Unable to access webcam: ' + err.message);
      console.error(err);
    }
  }

  function stopCamera() {
    if (mediaStream) {
      mediaStream.getTracks().forEach(t => t.stop());
      mediaStream = null;
    }
    videoEl.srcObject = null;
    isCameraActive = false;
    detectedLandmarks = [];
    detectedHandCount = 0;
    totalFingertips = 0;
    targetBox = null;
    camPrompt.style.display = 'flex';
    btnToggleCam.textContent = 'INITIALIZE CAM';
  }

  const videoHasFrame = () =>
    isCameraActive && videoEl.readyState >= 2 &&
    videoEl.videoWidth > 0 && videoEl.videoHeight > 0;

  // --- Render loop ---
  function renderLoop(timestamp) {
    animTime += 0.03;

    const delta = timestamp - lastFrameTime;
    lastFrameTime = timestamp;
    if (delta > 0) {
      fpsHistory.push(1000 / delta);
      if (fpsHistory.length > 20) fpsHistory.shift();
      const avg = Math.round(fpsHistory.reduce((a, b) => a + b, 0) / fpsHistory.length);
      statFps.textContent = avg < 10 ? '0' + avg : avg;
    }

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

    // 2. Mouse fallback
    if (chkMouseFallback.checked) {
      const mx = Math.min(mouseStartPos.x, mouseCurrentPos.x);
      const my = Math.min(mouseStartPos.y, mouseCurrentPos.y);
      let mw = Math.abs(mouseCurrentPos.x - mouseStartPos.x);
      let mh = Math.abs(mouseCurrentPos.y - mouseStartPos.y);
      if (mw < 40) mw = 120;
      if (mh < 40) mh = 120;
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

    // 4b. Pinch snapshot — capture here so the image has the effect but NOT the overlays below.
    if (pendingSnapshot) { pendingSnapshot = false; captureSnapshot(); }

    // 5. Overlays
    if (chkLandmarks.checked && detectedLandmarks.length > 0) drawHandLandmarks(w, h);
    if (chkBrackets.checked && smoothedBox) drawSharpBrackets(smoothedBox);

    // 6. HUD
    statHands.textContent = detectedHandCount;
    statFingers.textContent = totalFingertips;
    if (smoothedBox) {
      const rx = Math.round(smoothedBox.x), ry = Math.round(smoothedBox.y);
      const rw = Math.round(smoothedBox.w), rh = Math.round(smoothedBox.h);
      statRectSize.textContent = `${rw}x${rh}`;
      hudCoords.textContent = `[${rx}, ${ry}] -> [${rx + rw}, ${ry + rh}]`;
    } else {
      statRectSize.textContent = `0x0`;
      hudCoords.textContent = `[NO TARGET]`;
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
      .catch(err => console.error('tracking send failed:', err))
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
          for (let px = 0; px < bw; px += size) {
            const sx = Math.min(px + (size >> 1), bw - 1);
            const sy = Math.min(py + (size >> 1), bh - 1);
            const i = (sy * bw + sx) * 4;
            ctx.fillStyle = `rgb(${data[i]}, ${data[i + 1]}, ${data[i + 2]})`;
            ctx.fillRect(bx + px, by + py, size, size);
          }
        }
        break;
      }
      case 'distortion': {
        const tmp = document.createElement('canvas');
        tmp.width = bw; tmp.height = bh;
        tmp.getContext('2d').putImageData(imgData, 0, 0);
        ctx.save();
        ctx.beginPath(); ctx.rect(bx, by, bw, bh); ctx.clip();
        const freq = 0.05 * intensity, amp = 12 * intensity;
        for (let y = 0; y < bh; y += 4) {
          const dx = Math.sin(y * freq + animTime * 4) * amp;
          ctx.drawImage(tmp, 0, y, bw, 4, bx + dx, by + y, bw, 4);
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
            o[d] = data[r]; o[d + 1] = data[d + 1]; o[d + 2] = data[b + 2]; o[d + 3] = 255;
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
        const out = ctx.createImageData(bw, bh);
        const o = out.data;
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
        const out = ctx.createImageData(bw, bh);
        out.data.set(data);
        const o = out.data;
        const slices = Math.floor(6 * intensity);
        for (let s = 0; s < slices; s++) {
          if (Math.random() >= 0.6) continue;
          const sy = Math.floor(Math.random() * (bh - 10));
          const sh = Math.floor(Math.random() * 15) + 4;
          const shift = Math.floor((Math.random() - 0.5) * 30 * intensity);
          for (let y = sy; y < Math.min(bh, sy + sh); y++) {
            for (let x = 0; x < bw; x++) {
              const sxi = (x - shift + bw) % bw;
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
            const ci = Math.floor((1 - lum / 255) * (chars.length - 1));
            ctx.fillText(chars[ci], bx + px, by + py + fs);
          }
        }
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
        let x1 = hand[i].x * w, y1 = hand[i].y * h;
        let x2 = hand[j].x * w, y2 = hand[j].y * h;
        if (isMirroring) { x1 = w - x1; x2 = w - x2; }
        ctx.strokeStyle = 'rgba(255, 246, 234, 0.4)';
        ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
      });
      [4, 8].forEach((idx) => {
        let px = hand[idx].x * w; const py = hand[idx].y * h;
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
    // Stamp the tag onto the current (clean) frame before encoding. Matches the .section-label
    // style: mono, uppercase, wide tracking. Cleared by the next frame's clearRect.
    ctx.save();
    ctx.font = '12px ui-monospace, "Cascadia Mono", Consolas, monospace';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'bottom';
    const tag = 'M A D E   W I T H   L O V E   A N D   C O F F E E';
    ctx.fillStyle = 'rgba(13, 11, 12, 0.6)';
    ctx.fillText(tag, 26, canvas.height - 21);
    ctx.fillStyle = '#00FF88';
    ctx.fillText(tag, 24, canvas.height - 23);
    ctx.restore();

    // Blob + object URL: far faster and won't hang the tab like a multi-MB base64 data URL.
    canvas.toBlob((blob) => {
      if (!blob) return;
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `cam_fx_${Date.now()}.png`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000); // revoke after the download starts
    }, 'image/png');
  }

  function bindEvents() {
    btnStartCamMain.addEventListener('click', startCamera);
    btnToggleCam.addEventListener('click', () => isCameraActive ? stopCamera() : startCamera());
    btnSnapshot.addEventListener('click', captureSnapshot);

    effectBtns.forEach(btn => btn.addEventListener('click', () => {
      effectBtns.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      currentEffect = btn.dataset.effect;
      hudMode.textContent = btn.textContent.trim();
    }));

    sliderIntensity.addEventListener('input', e => {
      intensity = parseFloat(e.target.value); valIntensity.textContent = intensity.toFixed(1);
    });
    sliderGrid.addEventListener('input', e => {
      gridSize = parseInt(e.target.value, 10); valGrid.textContent = `${gridSize}px`;
    });
    sliderPadding.addEventListener('input', e => {
      paddingPx = parseInt(e.target.value, 10); valPadding.textContent = `${paddingPx}px`;
    });
    chkMirror.addEventListener('change', e => { isMirroring = e.target.checked; });

    const toLocal = e => {
      const rect = canvas.getBoundingClientRect();
      return {
        x: (e.clientX - rect.left) * (canvas.width / rect.width),
        y: (e.clientY - rect.top) * (canvas.height / rect.height)
      };
    };
    canvas.addEventListener('mousedown', e => {
      if (!chkMouseFallback.checked) return;
      isMouseDown = true;
      mouseStartPos = toLocal(e);
      mouseCurrentPos = { ...mouseStartPos };
    });
    canvas.addEventListener('mousemove', e => {
      if (chkMouseFallback.checked && isMouseDown) mouseCurrentPos = toLocal(e);
    });
    window.addEventListener('mouseup', () => { isMouseDown = false; });
  }

  window.addEventListener('DOMContentLoaded', init);
})();
