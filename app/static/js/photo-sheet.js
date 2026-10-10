// Shared sheet layout maths: paper size, cell trees, cell rectangles, templates, dividers and snapping.
// Pure functions: no DOM, no page state. The sheet (or tree) is always passed in.
// Loaded by index.html after photo-ui.js and before collage.js.
//
// Derived from (originals are unchanged in meaning, renamed only):
//   PhotoSheet.sheetMM / leaf / equal / gridTree / emptyTree / treeLeaves / normalizeTree
//   PhotoSheet.nodeRects / sizePack / cellRects / setCellFormats / countGrid
//   PhotoSheet.rowsTemplate / bigTemplate / templateRects / sharedSegments / treeDividers
//   PhotoSheet.applyDivider / snapDivider / findParent / equalizeTree / treeFits
//                                  ← collage.js collageSheetMM, collageLeaf, ... (same names with the collage prefix)
//   PhotoSheet.passportLayout / passportOffsets / fromPassport
//                                  ← passport.js sheetLayout / passportOffsets (the grid the old passport renderSheet drew)

import { FORMATS, SHEET } from './config.js';

export const PhotoSheet = (() => {
  const sheetMM = sheet => {
    const w = sheet?.fmt?.w || FORMATS[0].w, h = sheet?.fmt?.h || FORMATS[0].h;
    return sheet?.orient === 'landscape' ? { w: h, h: w } : { w, h };
  };
  const leaf = item => ({ leaf: true, item: item || null });
  const equal = n => Array(n).fill(1 / n);

  function gridTree(cols, rows) {
    const row = () => ({ dir: 'row', sizes: equal(cols), children: Array.from({ length: cols }, () => leaf()) });
    if (rows === 1) return row();
    return { dir: 'col', sizes: equal(rows), children: Array.from({ length: rows }, row) };
  }

  function emptyTree(node) {
    if (!node || node.leaf) return leaf();
    return { dir: node.dir, sizes: [...node.sizes], children: node.children.map(emptyTree) };
  }

  function treeLeaves(node, out = []) {
    if (!node) return out;
    if (node.leaf) out.push(node);
    else node.children.forEach(child => treeLeaves(child, out));
    return out;
  }

  function normalizeTree(node) {
    if (!node || node.leaf) return leaf();
    const dir = node.dir === 'row' ? 'row' : 'col';
    const children = Array.isArray(node.children) ? node.children.map(normalizeTree) : [];
    if (!children.length) return leaf();
    if (children.length === 1) return children[0];
    const raw = Array.isArray(node.sizes) ? children.map((_, i) => Number(node.sizes[i])) : [];
    const valid = raw.length === children.length && raw.every(n => Number.isFinite(n) && n > 0);
    const sizes = valid ? raw : equal(children.length), sum = sizes.reduce((a, b) => a + b, 0);
    return { dir, sizes: sizes.map(n => n / sum), children };
  }

  function nodeRects(root, x, y, w, h, gap, out = [], dividers = []) {
    if (!root) return out;
    if (root.leaf) { out.push({ leaf: root, x, y, w, h }); return out; }
    const count = root.children.length, horizontal = root.dir === 'row';
    const span = horizontal ? w : h, available = Math.max(0, span - gap * (count - 1));
    let cursor = horizontal ? x : y;
    for (let i = 0; i < count; i++) {
      const length = available * root.sizes[i];
      if (i < count - 1) dividers.push({ node: root, index: i, dir: root.dir,
        x: horizontal ? cursor + length + gap / 2 : x,
        y: horizontal ? y : cursor + length + gap / 2,
        spanStart: horizontal ? y : x,
        spanLength: horizontal ? h : w,
        parentLength: available,
      });
      nodeRects(root.children[i], horizontal ? cursor : x, horizontal ? y : cursor,
        horizontal ? length : w, horizontal ? h : length, gap, out, dividers);
      cursor += length + gap;
    }
    return out;
  }

  // How many cells of `size` fit, best of the cell and its turned copy, centred on the paper.
  // Passport sheets add two options: `sheet.anchor` {right, down} (mm from the top-left) pins the grid
  // there instead of centring it and keeps the cell unturned; `sheet.maxCells` caps the count.
  function sizePack(sheet, size = sheet.sizeCell) {
    if (!sheet || !size?.w || !size?.h) return null;
    const paper = sheetMM(sheet), m = Math.max(0, Number(sheet.margin) || 0), g = Math.max(0, Number(sheet.gap) || 0);
    const innerW = paper.w - 2 * m, innerH = paper.h - 2 * m;
    if (innerW <= 0 || innerH <= 0) return null;
    const cap = sheet.maxCells || Infinity, anchor = sheet.anchor;
    const candidates = (anchor ? [[size.w, size.h]] : [[size.w, size.h], [size.h, size.w]]).map(([w, h]) => {
      const cols = Math.max(0, Math.floor((innerW + g + 1e-9) / (w + g)));
      const rows = Math.max(0, Math.floor((innerH + g + 1e-9) / (h + g)));
      return { w, h, cols, rows, count: Math.min(cols * rows, cap) };
    });
    candidates.sort((a, b) => b.count - a.count || (a.cols * a.w - b.cols * b.w));
    const best = candidates[0];
    if (!best.count) return null;
    if (anchor) return { ...best, x: anchor.right, y: anchor.down };
    const usedW = best.cols * best.w + (best.cols - 1) * g;
    const usedH = best.rows * best.h + (best.rows - 1) * g;
    return { ...best, x: m + (innerW - usedW) / 2, y: m + (innerH - usedH) / 2, usedW, usedH };
  }

  function cellRects(sheet) {
    if (!sheet?.root) return [];
    const paper = sheetMM(sheet), gap = Math.max(0, Number(sheet.gap) || 0), m = Math.max(0, Number(sheet.margin) || 0);
    if (sheet.layout === 'size') {
      const pack = sizePack(sheet);
      if (!pack) return [];
      const leaves = treeLeaves(sheet.root), rects = [];
      for (let r = 0; r < pack.rows; r++) for (let c = 0; c < pack.cols; c++) {
        const leaf = leaves[r * pack.cols + c];
        if (leaf) rects.push({ leaf, x: pack.x + c * (pack.w + gap), y: pack.y + r * (pack.h + gap), w: pack.w, h: pack.h });
      }
      return rects;
    }
    return nodeRects(sheet.root, m, m, Math.max(0, paper.w - 2 * m), Math.max(0, paper.h - 2 * m), gap);
  }

  // ------------------------------------------------------------ passport sheets

  const PASSPORT_MAX = 8;

  // Paper for a passport size: the size packed unturned on SHEET paper in whichever orientation holds
  // more photos (at most 8; on a tie the one with fewer cells in total). Returns the paper W×H in mm,
  // its orientation, cols, rows and the number of photos that fill the grid.
  function passportLayout(size) {
    let best = null;
    for (const orient of ['portrait', 'landscape']) {
      const paper = sheetMM({ fmt: SHEET, orient });
      const cols = Math.floor(paper.w / size.w + 1e-9), rows = Math.floor(paper.h / size.h + 1e-9);
      const cells = cols * rows, count = Math.min(cells, PASSPORT_MAX);
      if (!best || count > best.count || (count === best.count && cells < best.cols * best.rows)) best = { orient, W: paper.w, H: paper.h, cols, rows, count };
    }
    return best;
  }

  // Where the photos start by default: standards that print from the sheet edge, else 5 mm each way,
  // never more than the paper has spare.
  function passportOffsets(size) {
    const standard = { visa: [0, 0], 'ca-passport': [0, 5], 'cn-visa': [9, 4] }[size.id] || [5, 5];
    const L = passportLayout(size);
    return { right: Math.min(standard[0], Math.max(0, L.W - L.cols * size.w)),
      down: Math.min(standard[1], Math.max(0, L.H - L.rows * size.h)) };
  }

  // A sheet for cellRects / PhotoRender.renderSheet: one linked photo repeated in the grid, full-length
  // cut lines at every cell edge, white paper. `item` (optional) goes in every cell.
  function fromPassport(size, { right, down }, item = null) {
    const L = passportLayout(size);
    return {
      fmt: SHEET, orient: L.orient, layout: 'size', sizeCell: size, gap: 0, margin: 0,
      anchor: { right, down }, maxCells: PASSPORT_MAX, cutLines: 'full', link: true, gapColor: '#ffffff',
      root: { dir: 'row', sizes: equal(L.count), children: Array.from({ length: L.count }, () => leaf(item)) },
    };
  }

  function setCellFormats(sheet) {
    for (const rect of cellRects(sheet)) if (rect.leaf.item) {
      rect.leaf.item.fmt = { id: 'cell', w: rect.w, h: rect.h };
      rect.leaf.item.orient = 'portrait';
    }
  }

  function countGrid(count, sheet) {
    const paper = sheetMM(sheet), pairs = [];
    for (let cols = 1; cols <= count; cols++) if (count % cols === 0) {
      const rows = count / cols;
      pairs.push({ cols, rows, score: Math.abs((cols / rows) - (paper.w / paper.h)) });
    }
    pairs.sort((a, b) => a.score - b.score);
    return pairs[0] || { cols: 1, rows: count };
  }

  function rowsTemplate(count) {
    const rows = Math.max(1, Math.round(count / Math.ceil(Math.sqrt(count))));
    const base = Math.floor(count / rows), extra = count % rows;
    const children = Array.from({ length: rows }, (_, i) => {
      const cols = base + (i >= rows - extra ? 1 : 0);
      return { dir: 'row', sizes: equal(cols), children: Array.from({ length: cols }, () => leaf()) };
    });
    return rows === 1 ? children[0] : { dir: 'col', sizes: equal(rows), children };
  }

  function bigTemplate(count, sheet, last = false) {
    const portrait = sheetMM(sheet).h >= sheetMM(sheet).w;
    const dir = portrait ? 'col' : 'row';
    const rest = portrait
      ? { dir: 'row', sizes: equal(count - 1), children: Array.from({ length: count - 1 }, () => leaf()) }
      : { dir: 'col', sizes: equal(count - 1), children: Array.from({ length: count - 1 }, () => leaf()) };
    const big = leaf(), sizes = last ? [.4, .6] : [.6, .4];
    return { dir, sizes, children: last ? [rest, big] : [big, rest] };
  }

  function templateRects(root, x = 0, y = 0, w = 100, h = 64) {
    return nodeRects(root, x, y, w, h, 1).map(r => ({
      x: r.x / w * 100, y: r.y / h * 100, w: r.w / w * 100, h: r.h / h * 100,
    }));
  }

  function sharedSegments(rects) {
    const lines = [], eps = 1e-5;
    for (let i = 0; i < rects.length; i++) for (let j = i + 1; j < rects.length; j++) {
      const a = rects[i], b = rects[j];
      if (Math.abs(a.x + a.w - b.x) < eps || Math.abs(b.x + b.w - a.x) < eps) {
        const x = Math.abs(a.x + a.w - b.x) < eps ? b.x : a.x;
        const y1 = Math.max(a.y, b.y), y2 = Math.min(a.y + a.h, b.y + b.h);
        if (y2 > y1 + eps) lines.push({ dir: 'row', x, y: y1, w: 0, h: y2 - y1 });
      }
      if (Math.abs(a.y + a.h - b.y) < eps || Math.abs(b.y + b.h - a.y) < eps) {
        const y = Math.abs(a.y + a.h - b.y) < eps ? b.y : a.y;
        const x1 = Math.max(a.x, b.x), x2 = Math.min(a.x + a.w, b.x + b.w);
        if (x2 > x1 + eps) lines.push({ dir: 'col', x: x1, y, w: x2 - x1, h: 0 });
      }
    }
    return lines;
  }

  function treeDividers(sheet) {
    if (!sheet || sheet.layout === 'size') return [];
    const p = sheetMM(sheet), m = Math.max(0, Number(sheet.margin) || 0), out = [], dividers = [];
    nodeRects(sheet.root, m, m, Math.max(0, p.w - 2 * m), Math.max(0, p.h - 2 * m), Math.max(0, sheet.gap || 0), out, dividers);
    return dividers;
  }

  // px is the sheet's on-screen box (getBoundingClientRect), so the maths stays free of the DOM.
  function applyDivider(divider, startSizes, startCoord, coord, sheet, px) {
    const paper = sheetMM(sheet);
    const horizontal = divider.dir === 'row';
    const pixelSpan = horizontal ? px.width : px.height;
    const paperSpan = horizontal ? paper.w : paper.h;
    const delta = (coord - startCoord) / Math.max(1, pixelSpan) * paperSpan / divider.parentLength;
    const i = divider.index, sum = startSizes[i] + startSizes[i + 1];
    const min = sum >= .16 ? .08 : sum * .08;  // Preserve 8% of the parent where feasible, else 8% of this pair.
    const left = Math.max(min, Math.min(sum - min, startSizes[i] + delta));
    divider.node.sizes[i] = left; divider.node.sizes[i + 1] = sum - left;
  }

  function snapDivider(divider, startSizes, rawLeft, sheet) {
    const i = divider.index, pair = startSizes[i] + startSizes[i + 1];
    const min = pair >= .16 ? .08 : pair * .08;
    const paper = sheetMM(sheet), side = divider.dir === 'row' ? paper.w : paper.h;
    const threshold = side * .025, prefix = startSizes.slice(0, i).reduce((a, b) => a + b, 0);
    const lineAt = left => (divider.dir === 'row' ? divider.x : divider.y) + (left - startSizes[i]) * divider.parentLength;
    const near = candidates => {
      let best = null;
      for (const left of candidates) {
        if (!Number.isFinite(left) || left < min || left > pair - min) continue;
        const distance = Math.abs(lineAt(left) - lineAt(rawLeft));
        if (distance <= threshold && (!best || distance < best.distance)) best = { left, distance };
      }
      return best?.left ?? null;
    };
    const equal = near([pair / 2]);
    if (equal != null) return equal;

    const inside = new Set([
      ...treeLeaves(divider.node.children[i]),
      ...treeLeaves(divider.node.children[i + 1]),
    ]);
    const axis = divider.dir === 'row' ? 'w' : 'h';
    const sameSize = [];
    for (const rect of cellRects(sheet)) if (!inside.has(rect.leaf)) {
      const share = rect[axis] / divider.parentLength;
      sameSize.push(share, pair - share);
    }
    const size = near(sameSize);
    if (size != null) return size;

    const others = treeDividers(sheet).filter(other =>
      !(other.node === divider.node && other.index === divider.index) && other.dir === divider.dir);
    const currentLeft = divider.node.sizes[i], currentRight = divider.node.sizes[i + 1];
    const differenceAt = (left, other) => {
      divider.node.sizes[i] = left; divider.node.sizes[i + 1] = pair - left;
      const dividers = treeDividers(sheet);
      const target = dividers.find(candidate => candidate.node === divider.node && candidate.index === divider.index);
      const aligned = dividers.find(candidate => candidate.node === other.node && candidate.index === other.index);
      divider.node.sizes[i] = currentLeft; divider.node.sizes[i + 1] = currentRight;
      if (!target || !aligned) return null;
      return (divider.dir === 'row' ? target.x - aligned.x : target.y - aligned.y);
    };
    const aligned = [];
    for (const other of others) {
      const low = differenceAt(min, other), high = differenceAt(pair - min, other), raw = differenceAt(rawLeft, other);
      if (raw != null && Math.abs(raw) < .01) aligned.push(rawLeft);
      else if (low != null && high != null) {
        if (Math.abs(low) < .01) aligned.push(min);
        else if (Math.abs(high) < .01) aligned.push(pair - min);
        else if (low * high < 0) aligned.push(min + (pair - 2 * min) * (-low) / (high - low));
      }
    }
    const alignment = near(aligned);
    if (alignment != null) return alignment;

    const fractions = [.25, 1 / 3, .5, 2 / 3, .75].map(fraction => fraction - prefix);
    return near(fractions);
  }

  function findParent(node, target) {
    if (!node || node.leaf) return null;
    if (node.children.includes(target)) return node;
    for (const child of node.children) {
      const parent = findParent(child, target);
      if (parent) return parent;
    }
    return null;
  }

  function equalizeTree(node) {
    if (!node || node.leaf) return;
    node.sizes = equal(node.children.length);
    node.children.forEach(equalizeTree);
  }

  function treeFits(node, w, h, gap) {
    if (!node || node.leaf) return w > 0 && h > 0;
    const available = (node.dir === 'row' ? w : h) - gap * (node.children.length - 1);
    if (available <= 0) return false;
    return node.children.every((child, i) => node.dir === 'row'
      ? treeFits(child, available * node.sizes[i], h, gap)
      : treeFits(child, w, available * node.sizes[i], gap));
  }

  return {
    sheetMM, leaf, equal, gridTree, emptyTree, treeLeaves,
    normalizeTree, nodeRects, sizePack, cellRects, setCellFormats, countGrid,
    passportLayout, passportOffsets, fromPassport,
    rowsTemplate, bigTemplate, templateRects, sharedSegments, treeDividers, applyDivider,
    snapDivider, findParent, equalizeTree, treeFits,
  };
})();
