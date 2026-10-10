// Pure sheet maths (app/static/js/photo-sheet.js). Expected numbers are worked out by hand in the comments.
import './setup.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';

const { PhotoSheet: S } = await import('../../app/static/js/photo-sheet.js');
const { PASSPORT } = await import('../../app/static/js/config.js');

const close = (actual, expected, msg) => assert.ok(Math.abs(actual - expected) < 1e-9, `${msg || ''} ${actual} != ${expected}`);
const paper = { fmt: { w: 100, h: 150 }, orient: 'portrait' };   // 10×15 cm
const passport = id => PASSPORT.find(p => p.id === id);

test('sheetMM swaps for landscape and defaults to 10×15', () => {
  assert.deepEqual(S.sheetMM(paper), { w: 100, h: 150 });
  assert.deepEqual(S.sheetMM({ ...paper, orient: 'landscape' }), { w: 150, h: 100 });
  assert.deepEqual(S.sheetMM(null), { w: 100, h: 150 });
});

test('sizePack: 5×7.5 cm cells on 10×15 cm = 2 cols × 2 rows, from the corner', () => {
  // unturned 50×75: 2 × 2 = 4; turned 75×50: 1 × 3 = 3 -> unturned wins
  const p = S.sizePack({ ...paper, sizeCell: { w: 50, h: 75 } });
  assert.deepEqual([p.cols, p.rows, p.count, p.w, p.h, p.x, p.y], [2, 2, 4, 50, 75, 0, 0]);
});

test('sizePack: gap and margin centre the grid', () => {
  // margin 5, gap 2, cell 40×60: inner 90×140 -> cols floor(92/42)=2, rows floor(142/62)=2 (turned gives 1×3=3)
  // used 2*40+2=82 by 2*60+2=122 -> x = 5+(90-82)/2 = 9, y = 5+(140-122)/2 = 14
  const p = S.sizePack({ ...paper, margin: 5, gap: 2, sizeCell: { w: 40, h: 60 } });
  assert.deepEqual([p.cols, p.rows, p.count, p.usedW, p.usedH, p.x, p.y], [2, 2, 4, 82, 122, 9, 14]);
});

test('sizePack: turns the cell when that holds more', () => {
  // 30×20 on 100×150: unturned 3×7=21, turned 20×30 -> 5×5=25
  const p = S.sizePack({ ...paper, sizeCell: { w: 30, h: 20 } });
  assert.deepEqual([p.w, p.h, p.cols, p.rows, p.count], [20, 30, 5, 5, 25]);
});

test('sizePack: anchor pins the grid, never turns the cell, maxCells caps', () => {
  // 35×45 on 100×150 portrait: 2 cols × 3 rows = 6 (landscape would hold more but anchor keeps it unturned)
  const base = { ...paper, sizeCell: { w: 35, h: 45 }, anchor: { right: 5, down: 7 } };
  const p = S.sizePack({ ...base, maxCells: 8 });
  assert.deepEqual([p.w, p.h, p.cols, p.rows, p.count, p.x, p.y], [35, 45, 2, 3, 6, 5, 7]);
  assert.equal(S.sizePack({ ...base, maxCells: 4 }).count, 4);
});

test('sizePack: nothing fits or no size -> null', () => {
  assert.equal(S.sizePack({ ...paper, sizeCell: { w: 200, h: 300 } }), null);
  assert.equal(S.sizePack({ ...paper }), null);
  assert.equal(S.sizePack({ ...paper, margin: 60, sizeCell: { w: 10, h: 10 } }), null);
});

test('cellRects (layout size): 2×2 cells of 50×75', () => {
  const sheet = { ...paper, layout: 'size', sizeCell: { w: 50, h: 75 }, root: S.gridTree(2, 2) };
  const r = S.cellRects(sheet).map(({ x, y, w, h }) => [x, y, w, h]);
  assert.deepEqual(r, [[0, 0, 50, 75], [50, 0, 50, 75], [0, 75, 50, 75], [50, 75, 50, 75]]);
});

test('cellRects (layout size) with gap and margin: x = 9 + c*42, y = 14 + r*62', () => {
  const sheet = { ...paper, layout: 'size', margin: 5, gap: 2, sizeCell: { w: 40, h: 60 }, root: S.gridTree(2, 2) };
  const r = S.cellRects(sheet).map(({ x, y, w, h }) => [x, y, w, h]);
  assert.deepEqual(r, [[9, 14, 40, 60], [51, 14, 40, 60], [9, 76, 40, 60], [51, 76, 40, 60]]);
});

test('cellRects (tree): gap splits the inner box', () => {
  // 2×1 grid on 100 mm wide inner, gap 2 -> available 98, 49 each: x 0 and 51
  const sheet = { fmt: { w: 100, h: 150 }, orient: 'portrait', gap: 2, root: S.gridTree(2, 1) };
  const r = S.cellRects(sheet).map(({ x, y, w, h }) => [x, y, w, h]);
  assert.deepEqual(r, [[0, 0, 49, 150], [51, 0, 49, 150]]);
});

test('passportLayout: 35×45 prefers landscape (4×2 = 8 beats 2×3 = 6)', () => {
  assert.deepEqual(S.passportLayout({ w: 35, h: 45 }), { orient: 'landscape', W: 150, H: 100, cols: 4, rows: 2, count: 8 });
});

test('passportLayout: caps at 8 and on a tie takes the orientation with fewer cells', () => {
  // 20×40: portrait 5×3=15, landscape 7×2=14, both capped to 8 -> landscape (14 < 15)
  assert.deepEqual(S.passportLayout({ w: 20, h: 40 }), { orient: 'landscape', W: 150, H: 100, cols: 7, rows: 2, count: 8 });
  // 50×50: 2×3 = 6 both ways, equal cells -> first (portrait) stays
  assert.equal(S.passportLayout({ w: 50, h: 50 }).orient, 'portrait');
  // 50×70: portrait 2×2=4 beats landscape 3×1=3
  assert.deepEqual(S.passportLayout({ w: 50, h: 70 }), { orient: 'portrait', W: 100, H: 150, cols: 2, rows: 2, count: 4 });
});

test('passportOffsets: standards print from the edge, others 5/5 clamped to the spare paper', () => {
  assert.deepEqual(S.passportOffsets(passport('visa')), { right: 0, down: 0 });            // 50×50 fills 100×150 exactly
  assert.deepEqual(S.passportOffsets(passport('ca-passport')), { right: 0, down: 5 });     // 50×70: spare 0 wide, 10 high
  assert.deepEqual(S.passportOffsets(passport('cn-visa')), { right: 9, down: 4 });         // 33×48 landscape 4×2: spare 18 / 4
  assert.deepEqual(S.passportOffsets(passport('35x45')), { right: 5, down: 5 });           // spare 10 / 10
  assert.deepEqual(S.passportOffsets({ id: 'x', w: 48, h: 48 }), { right: 4, down: 5 });   // portrait 2×3: spare 4 / 6 -> 5 clamped to 4
});

test('fromPassport + cellRects: 8 cells of 35×45 from (5, 5) on landscape paper', () => {
  const sheet = S.fromPassport(passport('35x45'), { right: 5, down: 5 });
  assert.equal(sheet.orient, 'landscape');
  assert.equal(S.treeLeaves(sheet.root).length, 8);
  const r = S.cellRects(sheet).map(({ x, y, w, h }) => [x, y, w, h]);
  assert.equal(r.length, 8);
  assert.deepEqual(r[0], [5, 5, 35, 45]);
  assert.deepEqual(r[3], [110, 5, 35, 45]);     // 5 + 3*35
  assert.deepEqual(r[4], [5, 50, 35, 45]);      // second row: 5 + 45
  assert.deepEqual(r[7], [110, 50, 35, 45]);
});

test('sharedSegments: a 2×2 grid has two vertical and two horizontal half-lines', () => {
  const rects = [{ x: 0, y: 0, w: 50, h: 50 }, { x: 50, y: 0, w: 50, h: 50 }, { x: 0, y: 50, w: 50, h: 50 }, { x: 50, y: 50, w: 50, h: 50 }];
  assert.deepEqual(S.sharedSegments(rects), [
    { dir: 'row', x: 50, y: 0, w: 0, h: 50 },
    { dir: 'col', x: 0, y: 50, w: 50, h: 0 },
    { dir: 'col', x: 50, y: 50, w: 50, h: 0 },
    { dir: 'row', x: 50, y: 50, w: 0, h: 50 },
  ]);
  assert.deepEqual(S.sharedSegments(rects.slice(0, 1)), []);
});

test('gridTree / treeLeaves / emptyTree', () => {
  const g = S.gridTree(2, 3);
  assert.equal(g.dir, 'col');
  assert.equal(g.children.length, 3);
  assert.ok(g.children.every(row => row.dir === 'row' && row.children.length === 2 && row.children.every(c => c.leaf)));
  g.sizes.forEach(v => close(v, 1 / 3));
  assert.equal(S.treeLeaves(g).length, 6);
  const one = S.gridTree(3, 1);
  assert.equal(one.dir, 'row');
  assert.equal(S.treeLeaves(one).length, 3);
  const full = S.gridTree(1, 1); full.children[0].item = { name: 'a' };
  assert.equal(S.treeLeaves(S.emptyTree(S.gridTree(2, 2))).filter(l => l.item).length, 0);
  assert.deepEqual(S.treeLeaves(null), []);
});

test('normalizeTree: repairs sizes, collapses single children, bad input -> leaf', () => {
  const n = S.normalizeTree({ dir: 'row', sizes: [1, 3], children: [{ leaf: true }, { leaf: true }] });
  assert.deepEqual([n.dir, ...n.sizes], ['row', .25, .75]);
  const bad = S.normalizeTree({ dir: 'weird', sizes: [1, -2], children: [{ leaf: true }, { leaf: true }] });
  assert.deepEqual([bad.dir, ...bad.sizes], ['col', .5, .5]);
  assert.equal(S.normalizeTree({ dir: 'row', sizes: [1], children: [{ leaf: true, item: 'x' }] }).leaf, true);
  assert.equal(S.normalizeTree(null).leaf, true);
  assert.equal(S.normalizeTree({ dir: 'row', children: [] }).leaf, true);
});

test('treeFits: every leaf must keep a positive size after the gaps', () => {
  assert.equal(S.treeFits(S.gridTree(2, 2), 100, 100, 0), true);
  assert.equal(S.treeFits(S.gridTree(2, 1), 10, 10, 10), false);    // gap eats the whole width
  assert.equal(S.treeFits(S.gridTree(2, 1), 10, 10, 2), true);      // 8 mm left
  assert.equal(S.treeFits(S.leaf(), 0, 10, 0), false);
  assert.equal(S.treeFits(S.leaf(), 5, 5, 0), true);
});

test('countGrid picks the divisor pair closest to the paper ratio', () => {
  // 6 = 2×3 (ratio .667 = 100/150) beats 1×6 and 3×2 and 6×1
  const g = S.countGrid(6, paper);
  assert.deepEqual([g.cols, g.rows], [2, 3]);
  const landscape = S.countGrid(6, { ...paper, orient: 'landscape' });
  assert.deepEqual([landscape.cols, landscape.rows], [3, 2]);
});
