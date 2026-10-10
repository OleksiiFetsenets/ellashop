// Pure editor maths (app/static/js/photo-editor.js). Expected numbers are worked out by hand in the comments.
import './setup.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';

const { PhotoEditor: E } = await import('../../app/static/js/photo-editor.js');

const close = (actual, expected, msg) => assert.ok(Math.abs(actual - expected) < 1e-9, `${msg || ''} ${actual} != ${expected}`);
const item = (w, h, extra = {}) => ({ img: { naturalWidth: w, naturalHeight: h }, rot: 0, tilt: 0, zoom: 1, cx: .5, cy: .5,
  orient: 'auto', mode: 'fill', fmt: { w: 100, h: 150 }, ...extra });

test('srcDims swaps width and height on 90/270', () => {
  assert.deepEqual(E.srcDims(item(3000, 2000)), { w: 3000, h: 2000 });
  assert.deepEqual(E.srcDims(item(3000, 2000, { rot: 90 })), { w: 2000, h: 3000 });
  assert.deepEqual(E.srcDims(item(3000, 2000, { rot: 180 })), { w: 3000, h: 2000 });
  assert.deepEqual(E.srcDims(item(3000, 2000, { rot: 270 })), { w: 2000, h: 3000 });
});

test('outMM: auto follows the photo, landscape swaps, portrait does not, squares never swap', () => {
  assert.deepEqual(E.outMM(item(3000, 2000)), { w: 150, h: 100 });                    // landscape photo
  assert.deepEqual(E.outMM(item(2000, 3000)), { w: 100, h: 150 });                    // portrait photo
  assert.deepEqual(E.outMM(item(3000, 2000, { rot: 90 })), { w: 100, h: 150 });       // turned -> portrait
  assert.deepEqual(E.outMM(item(2000, 3000, { orient: 'landscape' })), { w: 150, h: 100 });
  assert.deepEqual(E.outMM(item(3000, 2000, { orient: 'portrait' })), { w: 100, h: 150 });
  assert.deepEqual(E.outMM(item(3000, 2000, { fmt: { w: 100, h: 100 }, orient: 'landscape' })), { w: 100, h: 100 });
});

test('placement fill: scale covers the frame, centre is clamped to the visible window', () => {
  // 3000×2000 into 100×150: s = max(100/3000, 150/2000) = .075; visible width = 100/.075/3000 = 4/9, height = 1
  const it = item(3000, 2000, { cx: .1, cy: .9 });
  const { s, d } = E.placement(it, 100, 150);
  close(s, .075); assert.deepEqual(d, { w: 3000, h: 2000 });
  close(it.cx, 2 / 9, 'cx clamped to v/2');
  close(it.cy, .5, 'full-height window is centred');
  // zoom 2: s = .15, visible 2/9 × 1/2 -> cx .95 -> 1 - 1/9 = 8/9, cy .9 -> 1 - .25 = .75
  const z = item(3000, 2000, { zoom: 2, cx: .95, cy: .9 });
  close(E.placement(z, 100, 150).s, .15);
  close(z.cx, 8 / 9); close(z.cy, .75);
  // low side: cy .1 -> .25
  const low = item(3000, 2000, { zoom: 2, cx: .5, cy: .1 });
  E.placement(low, 100, 150); close(low.cy, .25);
});

test('placement fit/blur: whole photo, scale is the smaller ratio, centre forced to .5', () => {
  for (const mode of ['fit', 'blur']) {
    const it = item(3000, 2000, { mode, zoom: 3, cx: .1, cy: .9 });
    close(E.placement(it, 100, 150).s, 100 / 3000);       // min(100/3000, 150/2000)
    assert.deepEqual([it.cx, it.cy], [.5, .5]);
  }
});

test('placement free (passport): no clamp', () => {
  const it = item(3000, 2000, { free: true, cx: .1, cy: .9 });
  E.placement(it, 100, 150);
  assert.deepEqual([it.cx, it.cy], [.1, .9]);
});

test('clampZoom: 1–6 normally, 0.3–15 for free (passport) items', () => {
  const n = item(10, 10), f = item(10, 10, { free: true });
  assert.deepEqual([.5, 1, 3, 6, 9].map(z => E.clampZoom(n, z)), [1, 1, 3, 6, 6]);
  assert.deepEqual([.1, .3, 7, 15, 20].map(z => E.clampZoom(f, z)), [.3, .3, 7, 15, 15]);
});

test('clampTilt / setTilt: ±20 degrees', () => {
  assert.deepEqual([25, -30, 5, 20, -20, 0].map(E.clampTilt), [20, -20, 5, 20, -20, 0]);
  const it = item(10, 10); E.setTilt(it, 99); assert.equal(it.tilt, 20);
});

test('rotate: 90° steps wrap into 0..270', () => {
  const it = item(10, 10);
  E.rotate(it, 90); assert.equal(it.rot, 90);
  E.rotate(it, 90); E.rotate(it, 90); assert.equal(it.rot, 270);
  E.rotate(it, 90); assert.equal(it.rot, 0);
  E.rotate(it, -90); assert.equal(it.rot, 270);
  E.rotate(it, -360); assert.equal(it.rot, 270);
});

test('rotatedFace maps a box of the original photo into the turned photo', () => {
  const it = rot => item(3000, 2000, { rot }), face = { x: 100, y: 200, w: 300, h: 400 };
  assert.deepEqual(E.rotatedFace(face, it(0)), face);
  assert.deepEqual(E.rotatedFace(face, it(90)), { x: 1400, y: 100, w: 400, h: 300 });    // x = 2000-200-400, y = 100
  assert.deepEqual(E.rotatedFace(face, it(180)), { x: 2600, y: 1400, w: 300, h: 400 });  // 3000-100-300, 2000-200-400
  assert.deepEqual(E.rotatedFace(face, it(270)), { x: 200, y: 2600, w: 400, h: 300 });   // x = 200, y = 3000-100-300
});

test('canZoom: only fill mode zooms', () => {
  assert.equal(E.canZoom(item(1, 1, { mode: 'fill' })), true);
  assert.equal(E.canZoom(item(1, 1, { mode: 'fit' })), false);
  assert.equal(E.canZoom(item(1, 1, { mode: 'blur' })), false);
});

// 2000×2000 photo into a 150×100 frame: s = max(.075, .05) = .075 -> visible window 2000 × 1333.33 source px.
const frame = () => ({ w: 150, h: 100 });
test('smartPlace with one face: head box + headroom', () => {
  // face {x:500, y:600, w:200, h:260}: top = 600 - .6*260 = 444, bottom = 600 + 1.4*260 = 964
  // headroom = min(.08*1333.33, 1333.33 - 520) = 106.667 -> cy = (444 - 106.667 + 666.667)/2000 = .502
  // cx: window is the full width -> centred by the clamp (.5)
  const it = item(2000, 2000, { faces: [{ x: 500, y: 600, w: 200, h: 260 }] });
  E.smartPlace(it, frame);
  assert.equal(it.auto, 'faces'); assert.equal(it.mode, 'fill'); assert.equal(it.zoom, 1);
  close(it.cy, .502); close(it.cx, .5);
});

test('smartPlace: faces too big for the frame -> blur mode, centred', () => {
  // face h 800: head box = 2*800 = 1600 > window 1333.33
  const it = item(2000, 2000, { faces: [{ x: 500, y: 600, w: 300, h: 800 }] });
  E.smartPlace(it, frame);
  assert.equal(it.mode, 'blur'); assert.match(it.auto, /^blur/);
  assert.deepEqual([it.cx, it.cy], [.5, .5]);
});

test('smartPlace without faces: centred, slightly above the middle (.45)', () => {
  const it = item(2000, 2000);
  E.smartPlace(it, frame);
  assert.equal(it.auto, 'centre'); close(it.cy, .45); close(it.cx, .5);
});

test('smartPlace resets an earlier manual zoom and uses the turned photo\'s faces', () => {
  // 2000×3000 photo turned 90° = 3000×2000 source; face {x:100,y:200,w:300,h:400} -> {x:1400,y:100,w:400,h:300}
  // frame 150×100: s = .05, window 3000×2000 (the whole photo): left 1280, right 1400+520=1920... centred by clamp
  const it = item(2000, 3000, { rot: 90, zoom: 4, faces: [{ x: 100, y: 200, w: 300, h: 400 }] });
  E.smartPlace(it, frame);
  assert.equal(it.zoom, 1); assert.equal(it.auto, 'faces');
  close(it.cx, .5); close(it.cy, .5);
});

test('newItem defaults', () => {
  const it = E.newItem({ naturalWidth: 1, naturalHeight: 1 }, 'a.jpg', { fmt: { id: '10x15', w: 100, h: 150 } });
  assert.deepEqual([it.rot, it.tilt, it.zoom, it.cx, it.cy, it.orient, it.mode], [0, 0, 1, .5, .5, 'auto', 'fill']);
  assert.deepEqual(it.overlays, []);
});
