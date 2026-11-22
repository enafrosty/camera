const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const {
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
} = require('../app.js');

const { createApp } = require('../server.js');

function makeHand({ palm = 0.2, pinchRatio = 0.8, middleOnly = false, thumbOut = false } = {}) {
  const hand = new Array(21).fill(null).map(() => ({ x: 0.5, y: 0.8 }));
  hand[0] = { x: 0.5, y: 0.8 };
  hand[9] = { x: 0.5, y: 0.8 - palm };
  hand[17] = { x: 0.5 + palm * 0.4, y: 0.8 - palm * 0.8 };

  if (middleOnly) {
    hand[3] = { x: 0.5 + palm * 0.2, y: 0.8 - palm * 0.6 };
    hand[4] = thumbOut
      ? { x: 0.5 - palm * 0.4, y: 0.8 - palm * 0.7 }
      : { x: 0.5 + palm * 0.35, y: 0.8 - palm * 0.75 };
    hand[6] = { x: 0.45, y: 0.8 - palm * 1.0 };
    hand[8] = { x: 0.45, y: 0.8 - palm * 0.6 };
    hand[10] = { x: 0.5, y: 0.8 - palm * 1.1 };
    hand[12] = { x: 0.5, y: 0.8 - palm * 1.7 };
    hand[14] = { x: 0.55, y: 0.8 - palm * 1.0 };
    hand[16] = { x: 0.55, y: 0.8 - palm * 0.6 };
    hand[18] = { x: 0.6, y: 0.8 - palm * 0.9 };
    hand[20] = { x: 0.6, y: 0.8 - palm * 0.5 };
    return hand;
  }

  hand[8] = { x: 0.5 - palm * 0.2, y: 0.8 - palm * 1.4 };
  hand[4] = { x: hand[8].x, y: hand[8].y + pinchRatio * palm };
  return hand;
}

function requestText(baseUrl, reqPath) {
  return new Promise((resolve, reject) => {
    http.get(`${baseUrl}${reqPath}`, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    }).on('error', reject);
  });
}

test('gesture state starts disarmed and never fires with 0, 1, or 2 pre-pinched hands', () => {
  const state = createGestureState(0);
  assert.equal(state.armed, false);

  // 0 hands
  for (let i = 0; i < 10; i++) {
    const res = updateSnapGesture(state, [], 2000 + i * 100);
    assert.equal(res.trigger, false);
    assert.equal(state.armed, false);
  }

  // 1 open hand
  const openHand = makeHand({ pinchRatio: 0.8 });
  for (let i = 0; i < 10; i++) {
    const res = updateSnapGesture(state, [openHand], 3000 + i * 100);
    assert.equal(res.trigger, false);
    assert.equal(state.armed, false);
  }

  // 2 already-pinched hands without arming open first
  const pinched = makeHand({ pinchRatio: 0.1 });
  for (let i = 0; i < 10; i++) {
    const res = updateSnapGesture(state, [pinched, pinched], 4000 + i * 100);
    assert.equal(res.trigger, false);
    assert.equal(state.armed, false);
  }
});

test('startup grace period blocks premature arming and snapping', () => {
  const state = createGestureState(1000);
  const openHand = makeHand({ pinchRatio: 0.8 });

  for (let t = 1100; t < 2150; t += 150) {
    const res = updateSnapGesture(state, [openHand, openHand], t);
    assert.equal(res.trigger, false);
    assert.equal(state.armed, false);
    assert.equal(res.status, 'CALIBRATING...');
  }
});

test('two open hands arm after hold, ignore 1-frame pinch noise, and trigger once on sustained pinch', () => {
  const state = createGestureState(0);
  const open = makeHand({ pinchRatio: 0.75 });
  const pinched = makeHand({ pinchRatio: 0.2 });

  // Hold open across 4 frames spanning >= ARM_HOLD_MS
  assert.equal(updateSnapGesture(state, [open, open], 1500).trigger, false);
  assert.equal(state.armed, false);
  assert.equal(updateSnapGesture(state, [open, open], 1620).trigger, false);
  assert.equal(updateSnapGesture(state, [open, open], 1740).trigger, false);
  const armRes = updateSnapGesture(state, [open, open], 1860);
  assert.equal(armRes.trigger, false);
  assert.equal(state.armed, true);
  assert.equal(armRes.status, 'FRAME ARMED — PINCH TO SNAP');

  // 1-frame pinch noise followed by open should NOT fire and stays armed
  assert.equal(updateSnapGesture(state, [open, pinched], 1900).trigger, false);
  assert.equal(state.armed, true);
  assert.equal(updateSnapGesture(state, [open, open], 1940).trigger, false);
  assert.equal(state.armed, true);

  // Sustained pinch across PINCH_HOLD_FRAMES (2) triggers once and disarms
  assert.equal(updateSnapGesture(state, [open, pinched], 1980).trigger, false);
  const snapRes = updateSnapGesture(state, [open, pinched], 2020);
  assert.equal(snapRes.trigger, true);
  assert.equal(state.armed, false);
  assert.equal(snapRes.status, 'SNAPSHOT CAPTURED');
});

test('cooldown and dropping a hand prevent double-firing and require re-arming', () => {
  const state = createGestureState(0);
  const open = makeHand({ pinchRatio: 0.8 });
  const pinched = makeHand({ pinchRatio: 0.15 });

  // Arm
  [1500, 1650, 1800, 1950].forEach((t) => updateSnapGesture(state, [open, open], t));
  assert.equal(state.armed, true);

  // Hand drops out while armed -> disarms immediately
  updateSnapGesture(state, [open], 2000);
  assert.equal(state.armed, false);

  // Re-arm and snap at t=2600
  [2100, 2250, 2400, 2550].forEach((t) => updateSnapGesture(state, [open, open], t));
  assert.equal(state.armed, true);
  updateSnapGesture(state, [pinched, open], 2580);
  assert.equal(updateSnapGesture(state, [pinched, open], 2600).trigger, true);

  // During cooldown (< 2600 + 2000), cannot arm or trigger even with open hands
  [2800, 3100, 3400, 3700, 4200].forEach((t) => {
    const res = updateSnapGesture(state, [open, open], t);
    assert.equal(res.trigger, false);
    assert.equal(state.armed, false);
  });

  // After cooldown, still-pinched hands do not arm
  assert.equal(updateSnapGesture(state, [pinched, open], 4700).trigger, false);
  assert.equal(state.armed, false);
});

test('hand-size normalization works at close/far distances and filters tiny noise', () => {
  const farHand = makeHand({ palm: 0.08, pinchRatio: 0.7 });
  const closeHand = makeHand({ palm: 0.35, pinchRatio: 0.7 });
  const noisyHand = makeHand({ palm: 0.02, pinchRatio: 0.8 });

  assert.ok(Math.abs(handPinchRatio(farHand) - 0.7) < 1e-6);
  assert.ok(Math.abs(handPinchRatio(closeHand) - 0.7) < 1e-6);
  assert.equal(handPinchRatio(noisyHand), null);

  const state = createGestureState(0);
  [1500, 1650, 1800, 1950].forEach((t) => updateSnapGesture(state, [farHand, closeHand], t));
  assert.equal(state.armed, true);

  const farPinch = makeHand({ palm: 0.08, pinchRatio: 0.2 });
  updateSnapGesture(state, [farPinch, closeHand], 2000);
  assert.equal(updateSnapGesture(state, [farPinch, closeHand], 2040).trigger, true);
});

test('fingerStates thumb geometry and sustained middle-finger command gesture', () => {
  const middleTucked = makeHand({ middleOnly: true, thumbOut: false });
  const middleThumbOut = makeHand({ middleOnly: true, thumbOut: true });
  assert.deepEqual(fingerStates(middleTucked), {
    thumb: false,
    index: false,
    middle: true,
    ring: false,
    pinky: false
  });
  assert.equal(fingerStates(middleThumbOut).thumb, true);

  const state = createGestureState(0);
  // Grace period ignores gesture
  assert.equal(updateMiddleFingerGesture(state, [middleTucked], 500), false);
  // Single frame / short hold ignored
  assert.equal(updateMiddleFingerGesture(state, [middleTucked], 1500), false);
  assert.equal(updateMiddleFingerGesture(state, [middleTucked], 1700), false);
  // Reset when pose disappears
  assert.equal(updateMiddleFingerGesture(state, [makeHand()], 1800), false);

  // Sustained hold >= 6 frames and >= 600ms fires once
  let firedCount = 0;
  for (let i = 0; i < 8; i++) {
    if (updateMiddleFingerGesture(state, [middleTucked], 2000 + i * 120)) {
      firedCount += 1;
    }
  }
  assert.equal(firedCount, 1);
  assert.ok(palmScale(middleTucked) >= GESTURE_CONFIG.MIN_PALM_SCALE);
});

test('bounding box clamping, positiveMod negative shift wrap, and mosaic block clamping', () => {
  const edgeBox = computeTargetBox([{ x: 2, y: 2 }], 0, 1280, 720);
  assert.deepEqual(edgeBox, { x: 0, y: 0, w: 40, h: 40 });

  const farEdgeBox = computeTargetBox([{ x: 1278, y: 718 }], 0, 1280, 720);
  assert.deepEqual(farEdgeBox, { x: 1240, y: 680, w: 40, h: 40 });

  assert.equal(computeTargetBox([], 20, 1280, 720), null);

  // Negative modulo wrap when shift > bw (x=2, shift=27, bw=10 => (2-27) mod 10 = 5)
  assert.equal(positiveMod(2 - 27, 10), 5);
  assert.equal(positiveMod(-1, 10), 9);
  assert.equal(positiveMod(13, 10), 3);

  // Mosaic block clamping at boundary
  assert.equal(clampedBlockSize(0, 16, 40), 16);
  assert.equal(clampedBlockSize(32, 16, 40), 8);
  assert.equal(clampedBlockSize(40, 16, 40), 0);
});

test('server.js serves public static assets with 200 and blocks internal files with 404', async () => {
  const app = createApp();
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });

  try {
    const { port } = server.address();
    const baseUrl = `http://127.0.0.1:${port}`;

    const rootRes = await requestText(baseUrl, '/');
    assert.equal(rootRes.status, 200);
    assert.match(rootRes.body, /CAMERA/);

    const appJsRes = await requestText(baseUrl, '/app.js');
    assert.equal(appJsRes.status, 200);
    assert.match(appJsRes.body, /updateSnapGesture/);

    const cssRes = await requestText(baseUrl, '/style.css');
    assert.equal(cssRes.status, 200);
    assert.match(cssRes.body, /\.hud-overlay/);

    const serverJsRes = await requestText(baseUrl, '/server.js');
    assert.equal(serverJsRes.status, 404);

    const pkgRes = await requestText(baseUrl, '/package.json');
    assert.equal(pkgRes.status, 404);

    const testFileRes = await requestText(baseUrl, '/tests/app.test.js');
    assert.equal(testFileRes.status, 404);
  } finally {
    await new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  }
});
