// The collage layout panel: paper, layout type (grid, sizes, shapes, custom), cell counts, split/merge/equalize,
// gap, margin, colour, cut lines and the divider magnet. It edits the sheets (collage-model.js) and reads
// them back into the controls in syncCollageControls. The sheet drawing is collage-view.js.

import { $, $$, setStatus } from './dom.js';
import { PhotoUI } from './photo-ui.js';
import { PhotoSheet } from './photo-sheet.js';
import { COLLAGE_PAPERS, FORMATS, customSizeControl, fmtLabel, formatById } from './config.js';
import { t } from './i18n.js';
import { densityControl } from './assets.js';
import { setSeg, wireSeg } from './ui.js';
import {
  collage, collageChanged, collageMagnet, collageRefresh, collageReflow, collageReplaceRoot, collageSetCellFormats, collageSheet,
} from './collage-model.js';

const COLLAGE_SMALL_SIZES = [
  { id: '5x7.5', w: 50, h: 75 }, { id: '6x9', w: 60, h: 90 }, { id: '7x10', w: 70, h: 100 },
];

function collageTemplateRoots(count, sheet) {
  return [
    { name: t('collage_rows'), root: PhotoSheet.rowsTemplate(count) },
    { name: t('collage_big_first'), root: PhotoSheet.bigTemplate(count, sheet, false) },
    { name: t('collage_big_last'), root: PhotoSheet.bigTemplate(count, sheet, true) },
  ];
}

function collageSvg(root) {
  const cells = PhotoSheet.templateRects(root).map(r => `<rect x="${r.x}" y="${r.y}" width="${r.w}" height="${r.h}" rx="1"/>`).join('');
  return `<svg viewBox="0 0 100 64" aria-hidden="true">${cells}</svg>`;
}

function renderCollageShapes() {
  const n = Math.max(2, Math.min(20, Number($('#collage-shapes-count').value) || 5));
  $('#collage-shapes-count').value = n;
  $('#collage-shapes').innerHTML = collageTemplateRoots(n, collageSheet()).map((t, i) =>
    `<button class="collage-shape" type="button" data-shape="${i}">${collageSvg(t.root)}${t.name}</button>`).join('');
}

$('#collage-paper').innerHTML = COLLAGE_PAPERS.map((f, i) =>
  `${i === FORMATS.length ? `<span class="small collage-paper-label">${t('collage_canvas')}</span>` : ''}<button type="button" data-id="${f.id}">${fmtLabel(f)}</button>`).join('');
const collageCustomPaper = customSizeControl('#collage-paper', COLLAGE_PAPERS, [2, 200, 2, 200],
  () => collageSheet()?.fmt, fmt => setCollagePaper(fmt), '#collage-status');
$('#collage-counts').innerHTML = [2, 4, 6, 8, 9, 12].map(n => `<button type="button" data-count="${n}">${n}</button>`).join('');
$('#collage-paper').addEventListener('click', e => {
  const button = e.target.closest('button[data-id]'); if (button) setCollagePaper(formatById(COLLAGE_PAPERS, button.dataset.id));
});

const syncCollageDensity = densityControl($('#collage-density'), {
  item: () => collageSheet(), items: () => collage.sheets,
  refresh: collageChanged,
});

// Show the active sheet's and selected cell's values in the panel and the selected-cell controls.
export function syncCollageControls() {
  const sheet = collageSheet(), leaf = collage.sel, item = leaf?.item;
  if (!sheet) return;
  const leaves = PhotoSheet.treeLeaves(sheet.root), rows = sheet.root?.dir === 'col' ? sheet.root.children.length : 1;
  const cols = sheet.root?.dir === 'row' ? sheet.root.children.length : (sheet.root?.children?.[0]?.children?.length || 1);
  $$('#collage-paper button[data-id]').forEach(b => b.classList.toggle('on', b.dataset.id === sheet.fmt.id));
  collageCustomPaper(sheet.fmt);
  setSeg($('#collage-orient'), sheet.orient); setSeg($('#collage-layout'), sheet.layout);
  const gridDims = sheet.layout === 'grid' ? PhotoSheet.countGrid(leaves.length, sheet) : null;
  $('#collage-counts').querySelectorAll('[data-count]').forEach(button => {
    const dims = PhotoSheet.countGrid(Number(button.dataset.count), sheet);
    button.classList.toggle('on', !!gridDims && dims.cols === gridDims.cols && dims.rows === gridDims.rows);
  });
  $('#collage-cols').value = cols; $('#collage-rows').value = rows;
  $('#collage-layout-grid').hidden = sheet.layout !== 'grid';
  $('#collage-layout-size').hidden = sheet.layout !== 'size';
  $('#collage-layout-template').hidden = sheet.layout !== 'template';
  $('#collage-layout-custom').hidden = sheet.layout !== 'custom';
  $('#collage-gap').value = sheet.gap; $('#collage-margin').value = sheet.margin;
  $('#collage-magnet').checked = collageMagnet.on;
  setSeg($('#collage-gap-color'), sheet.gapColor); $('#collage-cutlines').checked = !!sheet.cutLines;
  $('#collage-density').classList.toggle('changed', !!sheet.density);
  syncCollageDensity();
  if (sheet.sizeCell) { $('#collage-cell-w').value = sheet.sizeCell.w / 10; $('#collage-cell-h').value = sheet.sizeCell.h / 10; }
  PhotoUI.syncAdjust('collage', item);
  if (!item) { setSeg($('#collage-mode'), 'fill'); $('#collage-zoom').value = 1; }
  ['#collage-mode button', '#collage-rot-l', '#collage-rot-r', '#collage-reset', '#collage-empty']
    .forEach(selector => $$(selector).forEach(el => { el.disabled = !item; }));
  $('#collage-merge').disabled = !leaf || leaves.length <= 1;
  $('#collage-split-row').disabled = !leaf; $('#collage-split-col').disabled = !leaf;
  renderCollageSizes(); renderCollageShapes();
}

function renderCollageSizes() {
  const sheet = collageSheet(); if (!sheet) return;
  const sizes = [...FORMATS, ...COLLAGE_SMALL_SIZES], buttons = [];
  for (const size of sizes) {
    const pack = PhotoSheet.sizePack(sheet, size), count = pack?.count || 0, small = COLLAGE_SMALL_SIZES.includes(size);
    if (!small && count < 2) continue;
    const isSelected = sheet.sizeCell && sheet.sizeCell.w === size.w && sheet.sizeCell.h === size.h;
    buttons.push(`<button type="button" data-size="${size.w}x${size.h}" class="${isSelected ? 'on' : ''}" ${count ? '' : 'disabled'}>${fmtLabel(size)} (${count})</button>`);
  }
  $('#collage-sizes').innerHTML = buttons.join('') || `<span class="small">${t('collage_no_preset_fits')}</span>`;
}

function setCollagePaper(fmt) {
  const sheet = collageSheet();
  collageReflow(sheet, () => { sheet.fmt = fmt; });
}

wireSeg($('#collage-orient'), orient => {
  const sheet = collageSheet();
  collageReflow(sheet, () => { sheet.orient = orient; });
});

// The layout panel is hidden in single view, so no user or key can reach it; this one capture guard keeps
// scripted clicks on its controls inert there too (tests/ui/6_collage.json asserts that).
$('#collage-layout-section').addEventListener('click', e => {
  if (collage.view === 'single') { e.preventDefault(); e.stopImmediatePropagation(); }
}, true);
wireSeg($('#collage-layout'), layout => {
  const sheet = collageSheet(); if (!sheet) return;
  if (layout === 'grid') {
    const dims = PhotoSheet.countGrid(PhotoSheet.treeLeaves(sheet.root).length || 4, sheet);
    collageReplaceRoot(sheet, PhotoSheet.gridTree(dims.cols, dims.rows), 'grid');
  } else collageReflow(sheet, () => {
    sheet.layout = layout;
    if (layout === 'size') sheet.sizeCell = { ...(sheet.sizeCell || { w: 50, h: 75 }) };
  });
});

$('#collage-counts').addEventListener('click', e => {
  const button = e.target.closest('[data-count]'); if (!button) return;
  const { cols, rows } = PhotoSheet.countGrid(Number(button.dataset.count), collageSheet());
  collageReplaceRoot(collageSheet(), PhotoSheet.gridTree(cols, rows), 'grid');
});
$('#collage-apply-grid').addEventListener('click', () => {
  const cols = Number($('#collage-cols').value), rows = Number($('#collage-rows').value);
  if (!Number.isInteger(cols) || cols < 1 || cols > 10 || !Number.isInteger(rows) || rows < 1 || rows > 10) {
    setStatus($('#collage-status'), t('collage_grid_range_error'), true); return;
  }
  collageReplaceRoot(collageSheet(), PhotoSheet.gridTree(cols, rows), 'grid');
});

$('#collage-sizes').addEventListener('click', e => {
  const button = e.target.closest('[data-size]'); if (!button || button.disabled) return;
  const [w, h] = button.dataset.size.split('x').map(Number);
  setCollageSizeCell({ w, h });
});

function setCollageSizeCell(size) {
  const sheet = collageSheet(); if (!sheet) return;
  const pack = PhotoSheet.sizePack(sheet, size);
  if (!pack) { setStatus($('#collage-status'), t('collage_cell_does_not_fit'), true); return; }
  collageReflow(sheet, () => { sheet.sizeCell = { w: size.w, h: size.h }; sheet.layout = 'size'; });
}

$('#collage-apply-cell-size').addEventListener('click', () => {
  const w = Number($('#collage-cell-w').value) * 10, h = Number($('#collage-cell-h').value) * 10;
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0 || w > 1000 || h > 1000) {
    setStatus($('#collage-status'), t('collage_cell_size_range_error'), true); return;
  }
  setCollageSizeCell({ w, h });
});

$('#collage-shapes').addEventListener('click', e => {
  const button = e.target.closest('[data-shape]'); if (!button) return;
  const templates = collageTemplateRoots(Number($('#collage-shapes-count').value), collageSheet());
  if (templates[Number(button.dataset.shape)]) collageReplaceRoot(collageSheet(), templates[Number(button.dataset.shape)].root, 'template');
});
$('#collage-shapes-minus').addEventListener('click', () => { $('#collage-shapes-count').value = Math.max(2, Number($('#collage-shapes-count').value) - 1); renderCollageShapes(); });
$('#collage-shapes-plus').addEventListener('click', () => { $('#collage-shapes-count').value = Math.min(20, Number($('#collage-shapes-count').value) + 1); renderCollageShapes(); });
$('#collage-shapes-count').addEventListener('change', renderCollageShapes);

$('#collage-split-row').addEventListener('click', () => collageSplitSelected('row'));
$('#collage-split-col').addEventListener('click', () => collageSplitSelected('col'));
$('#collage-merge').addEventListener('click', collageMergeSelected);
$('#collage-start-over').addEventListener('click', () => collageReplaceRoot(collageSheet(), PhotoSheet.leaf(), 'custom'));
$('#collage-equalize').addEventListener('click', () => {
  const sheet = collageSheet(); if (!sheet) return;
  const parent = collage.sel ? PhotoSheet.findParent(sheet.root, collage.sel) : null;
  if (parent) parent.sizes = PhotoSheet.equal(parent.children.length);
  else PhotoSheet.equalizeTree(sheet.root);
  sheet.layout = 'custom'; collageSetCellFormats(sheet); collageChanged();
});
$('#collage-magnet').addEventListener('change', e => {
  collageMagnet.on = e.currentTarget.checked; collageMagnet.guide = null;
  try { localStorage.setItem('ellashop-collage-magnet', collageMagnet.on ? 'on' : 'off'); } catch (_) { /* Storage may be unavailable. */ }
  collageRefresh();
});

function collageSplitSelected(dir) {
  const sheet = collageSheet(), target = collage.sel; if (!sheet || !target) return;
  const split = () => ({ dir, sizes: [.5, .5], children: [target, PhotoSheet.leaf()] });
  const insert = node => {
    if (node.leaf) return node === target ? split() : node;
    if (node.dir === dir && node.children.includes(target)) {
      const i = node.children.indexOf(target), size = node.sizes[i] / 2;
      node.children.splice(i, 1, target, PhotoSheet.leaf()); node.sizes.splice(i, 1, size, size); return node;
    }
    node.children = node.children.map(insert); return node;
  };
  const oldRoot = sheet.root;
  sheet.root = insert(oldRoot);
  if (sheet.root === target) sheet.root = split();
  sheet.layout = 'custom'; collage.sel = sheet.root === target ? sheet.root.children[0] : PhotoSheet.treeLeaves(sheet.root).find(leaf => leaf === target) || PhotoSheet.treeLeaves(sheet.root)[0];
  collageSetCellFormats(sheet); collageChanged();
}

function collageMergeSelected() {
  const sheet = collageSheet(), target = collage.sel; if (!sheet || !target || PhotoSheet.treeLeaves(sheet.root).length <= 1) return;
  const remove = node => {
    if (node.leaf) return node === target ? null : node;
    const next = [];
    node.children.forEach((child, i) => {
      const result = remove(child);
      if (result) next.push({ child: result, size: node.sizes[i] });
    });
    if (!next.length) return null;
    if (next.length === 1) return next[0].child;
    const sum = next.reduce((n, x) => n + x.size, 0);
    node.children = next.map(x => x.child); node.sizes = next.map(x => x.size / sum);
    return node;
  };
  sheet.root = remove(sheet.root) || PhotoSheet.leaf(); sheet.layout = 'custom';
  collage.sel = PhotoSheet.treeLeaves(sheet.root)[0] || null;
  collageSetCellFormats(sheet); collageChanged();
}

function collageMetricChange(key, input) {
  const sheet = collageSheet(), next = Number(input.value), old = Number(sheet[key]);
  if (!input.validity.valid || input.value === '' || !Number.isFinite(next) || next < 0 || next > 20 || Math.round(next * 2) !== next * 2) {
    input.value = old; setStatus($('#collage-status'), t('collage_gap_margin_range_error'), true); return;
  }
  collageReflow(sheet, () => {
    sheet[key] = next;
    const paper = PhotoSheet.sheetMM(sheet);
    const innerW = Math.max(0, paper.w - 2 * sheet.margin), innerH = Math.max(0, paper.h - 2 * sheet.margin);
    const fits = sheet.layout === 'size' ? !!PhotoSheet.sizePack(sheet) : PhotoSheet.treeFits(sheet.root, innerW, innerH, sheet.gap);
    if (sheet.margin * 2 >= Math.min(paper.w, paper.h) || !fits) {
      sheet[key] = old; input.value = old; setStatus($('#collage-status'), t('collage_spacing_no_room'), true); return false;
    }
  });
}

$('#collage-gap').addEventListener('change', e => collageMetricChange('gap', e.currentTarget));
$('#collage-margin').addEventListener('change', e => collageMetricChange('margin', e.currentTarget));
wireSeg($('#collage-gap-color'), color => { const sheet = collageSheet(); sheet.gapColor = color; collageChanged(); });
$('#collage-cutlines').addEventListener('change', e => { const sheet = collageSheet(); sheet.cutLines = e.currentTarget.checked; collageChanged(); });
