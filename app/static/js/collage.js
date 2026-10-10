'use strict';
// Places different photos into the cells of printable sheets.
// Loads after Passport and before shared keyboard controls.
// Collage = the shared photo editor + packing. Everything done to ONE photo in a cell (fill mode, rotate,
// zoom, reset, tilt, pan, wheel zoom, painting the cell) comes from PhotoEditor / PhotoUI / PhotoRender;
// this file keeps only the packing: sheets, layouts, cells, dividers and magnet, shapes, the photo pool,
// Move to Canvas and saved state. Sheet maths is in PhotoSheet.
//
// The drop zone and photo list, the selected-cell controls, composition guides, save buttons and status
// line are built by PhotoUI (data-ui slots in index.html); the stage with its view bar stays hand-written
// because the hint moves between the bar and the stage and the sheet replaces the photo grid.
//
// Moved from (the old copies are gone):
//   renderCollage / saveCollageSheet  → PhotoRender.renderSheet / exportSheet (renderCollage stays as a wrapper for tests)
//   cell pan, wheel zoom, cell paint  → PhotoUI.photoCanvas / paintCached (shared with the photo grid cards)
//   fill mode, rotate, zoom, reset    → PhotoUI.fillModeSeg / adjustRow / wireAdjust / syncAdjust (Reset no longer
//                                       undoes the 90° turn or the fill mode, like the other pages)
//   sheet tabs, Prev/Next/count       → PhotoUI.tabs, PhotoUI.stepBar / neighbour
//   composition guides                → PhotoUI.wireGuides (was the collage loop in shortcuts.js)
// ---------------------------------------------------------------- collage

const collage = { photos: [], sheets: [], active: 0, sel: null, view: 'sheet' };

{
  const view = $('#collage'), slot = name => view.querySelector(`[data-ui="${name}"]`);
  PhotoUI.mount(slot('drop'), PhotoUI.dropZone('collage'));
  PhotoUI.mount(slot('adjust'),
    PhotoUI.fillModeSeg('collage', { heading: 'page_selected_cell', labels: ['page_crop', 'page_fit_white', 'page_fit_blurred'] }),
    PhotoUI.adjustRow('collage', { heading: false }));
  PhotoUI.mount(slot('guides'), PhotoUI.guideChecks('collage', { measure: false, hiddenRow: true }));
  PhotoUI.mount(slot('save'), PhotoUI.saveActions('collage', { one: 'page_save_sheet', all: 'page_save_all_sheets', announce: true }));
}
let nextCollageSheetId = 1;
let collageMagnet = true, collageMagnetGuide = null;
try { collageMagnet = localStorage.getItem('ellashop-collage-magnet') !== 'off'; } catch (_) { /* Storage may be unavailable. */ }
const COLLAGE_SMALL_SIZES = [
  { id: '5x7.5', w: 50, h: 75 }, { id: '6x9', w: 60, h: 90 }, { id: '7x10', w: 70, h: 100 },
];
const collageCells = new WeakMap();
let collageShownSheet = null, collageShownLeaves = [];

const collageSheet = () => collage.sheets[collage.active] || null;
// Forwards to PhotoSheet that apply the active sheet by default (also called from tests/ui/*.json).
const cellRects = (sheet = collageSheet()) => PhotoSheet.cellRects(sheet);
const collageSetCellFormats = (sheet = collageSheet()) => PhotoSheet.setCellFormats(sheet);
// Forwards used only by tests/ui/*.json.
const collageSheetMM = sheet => PhotoSheet.sheetMM(sheet);
const collageLeaf = item => PhotoSheet.leaf(item);
const collageSharedSegments = rects => PhotoSheet.sharedSegments(rects);
const collageTreeDividers = sheet => PhotoSheet.treeDividers(sheet);
function collageSavedId(id) {
  const match = /^sheet-(\d+)$/.exec(id || '');
  if (match) nextCollageSheetId = Math.max(nextCollageSheetId, Number(match[1]) + 1);
  return id || `sheet-${nextCollageSheetId++}`;
}

function collageDefaultSheet(copy = null) {
  const sheet = copy ? {
    fmt: copy.fmt, orient: copy.orient, gap: copy.gap, margin: copy.margin,
    gapColor: copy.gapColor, cutLines: copy.cutLines, density: copy.density,
    layout: copy.layout, sizeCell: copy.sizeCell ? { ...copy.sizeCell } : null,
    root: PhotoSheet.emptyTree(copy.root),
  } : {
    fmt: FORMATS[0], orient: 'portrait', gap: 0, margin: 0, gapColor: '#ffffff',
    cutLines: true, density: 0, layout: 'grid', sizeCell: { w: 50, h: 75 }, root: PhotoSheet.gridTree(2, 2),
  };
  sheet.id = `sheet-${nextCollageSheetId++}`;
  return sheet;
}

// Refresh the page and save after a change to the sheets.
function collageChanged() { refreshCollage(); queueSave('collage'); }

// The photos on a sheet in cell order and the index of the selected cell, taken before the cells change.
function collageHeld(sheet) {
  const rects = cellRects(sheet);
  return { items: rects.map(r => r.leaf.item).filter(Boolean), index: Math.max(0, rects.findIndex(r => r.leaf === collage.sel)) };
}

// Put the held photos into new cells in order and keep the selection at the same index.
function collageFill(leaves, { items, index }) {
  leaves.forEach((leaf, i) => { leaf.item = items[i] || null; });
  collage.sel = leaves[Math.min(index, Math.max(0, leaves.length - 1))] || null;
}

function collageRepackSize(sheet, held) {
  if (!sheet || sheet.layout !== 'size') return;
  const pack = PhotoSheet.sizePack(sheet);
  if (!pack) { sheet.layout = 'grid'; sheet.root = PhotoSheet.gridTree(1, 1); sheet.sizeCell = null; }
  else sheet.root = PhotoSheet.gridTree(pack.cols, pack.rows);
  collageFill(PhotoSheet.treeLeaves(sheet.root), held);
  collageSetCellFormats(sheet);
}

// Change a sheet's paper, orientation, layout, size or spacing (`change` edits it, and may return false to
// cancel): the photos and the selection stay, and cells are repacked or given their new formats.
function collageReflow(sheet, change) {
  if (!sheet) return;
  const held = collageHeld(sheet);
  if (change() === false) return;
  if (sheet.layout === 'size') collageRepackSize(sheet, held); else collageSetCellFormats(sheet);
  collageChanged();
}

function collageReplaceRoot(sheet, root, layout) {
  const held = collageHeld(sheet);
  sheet.root = root; sheet.layout = layout;
  collageFill(PhotoSheet.treeLeaves(root), held);
  collageSetCellFormats(sheet);
  collageChanged();
}

function collageTemplateRoots(count, sheet) {
  return [
    { name: t('collage_rows'), root: PhotoSheet.rowsTemplate(count) },
    { name: t('collage_big_first'), root: PhotoSheet.bigTemplate(count, sheet, false) },
    { name: t('collage_big_last'), root: PhotoSheet.bigTemplate(count, sheet, true) },
  ];
}

function collageRenderMagnetGuide(sheet, paper) {
  if (!collageMagnetGuide || collageMagnetGuide.sheet !== sheet) return [];
  const { dir, at } = collageMagnetGuide, guide = document.createElement('div');
  guide.className = `collage-magnet-guide ${dir}`;
  if (dir === 'row') guide.style.left = `${at / paper.w * 100}%`;
  else guide.style.top = `${at / paper.h * 100}%`;
  return [guide];
}

function collageNewCellItem(photo, rect) {
  return PhotoEditor.newItem(photo.img, photo.name, {
    file: photo.file, orient: 'portrait', fmt: { id: 'cell', w: rect.w, h: rect.h },
    mode: 'fill', blur: 'motion', strength: 50, overlays: [],
  });
}

function collagePhotoForItem(item) {
  return item && collage.photos.find(photo => photo.file && photo.file === item.file);
}

function collagePlace(photo, leaf, sheet = collageSheet()) {
  if (!photo || !leaf || !sheet) return;
  const rect = cellRects(sheet).find(r => r.leaf === leaf);
  if (!rect) return;
  leaf.item = collageNewCellItem(photo, rect);
  collage.sel = leaf;
}

function collageFirstEmpty(sheet = collageSheet()) { return cellRects(sheet).find(r => !r.leaf.item)?.leaf || null; }
function collageFilledLeaves(sheet = collageSheet()) { return cellRects(sheet).filter(r => r.leaf.item).map(r => r.leaf); }

function collageSelect(leaf) {
  collage.sel = leaf;
  for (const node of $('#collage-sheet').querySelectorAll('.collage-cell'))
    node.classList.toggle('selected', node._leaf === leaf);
  renderCollagePool(); syncCollageControls();
}

function collageSelectedCanvas() {
  return collage.view === 'sheet' && collage.sel ? collageCells.get(collage.sel)?.querySelector('canvas') || null : null;
}

function collageUsageCounts() {
  const counts = new Map();
  for (const sheet of collage.sheets) for (const rect of cellRects(sheet)) {
    const file = rect.leaf.item?.file;
    if (file) counts.set(file, (counts.get(file) || 0) + 1);
  }
  return counts;
}

function renderCollagePool() {
  const list = $('#collage-queue'), usage = collageUsageCounts(); list.replaceChildren();
  collage.photos.forEach((photo, index) => {
    const used = usage.get(photo.file) || 0, li = document.createElement('li');
    li.className = `${photo === collagePhotoForItem(collage.sel?.item) ? 'sel' : ''}${used ? ' used' : ''}`.trim();
    li.draggable = true;
    li.innerHTML = '<img><div class="meta"><div class="name"></div><div class="fmt"></div></div><button class="del">✕</button>';
    li.querySelector('.del').title = t('collage_remove');
    li.querySelector('img').src = photo.img.src;
    li.querySelector('.name').textContent = photo.name;
    li.querySelector('.fmt').textContent = used ? t('collage_used', used) : t('collage_unused');
    li.addEventListener('click', e => {
      if (e.target.closest('.del')) {
        for (const sheet of collage.sheets) for (const rect of cellRects(sheet))
          if (rect.leaf.item?.file === photo.file) rect.leaf.item = null;
        collage.photos = collage.photos.filter(p => p !== photo);
        if (!collage.sel || !PhotoSheet.treeLeaves(collageSheet()?.root).includes(collage.sel)) collage.sel = PhotoSheet.treeLeaves(collageSheet()?.root)[0] || null;
      } else {
        // Fill an empty cell first; replace the selected photo only when the sheet is full.
        const target = collage.sel && !collage.sel.item ? collage.sel : collageFirstEmpty() || collage.sel;
        if (target) collagePlace(photo, target);
      }
      collageChanged();
    });
    li.addEventListener('dragstart', e => {
      e.dataTransfer.setData('text/x-ellashop-photo', String(index));
      e.dataTransfer.effectAllowed = 'copy';
    });
    list.append(li);
  });
}

function collageCellElement(leaf) {
  let cell = collageCells.get(leaf);
  if (cell) return cell;
  cell = document.createElement('div');
  cell.className = 'collage-cell'; cell._leaf = leaf; cell._item = undefined;
  cell.addEventListener('click', e => {
    if (e.target.closest('.eye')) return;
    collageSelect(leaf);
  });
  cell.addEventListener('dragover', e => { e.preventDefault(); cell.classList.add('over'); });
  cell.addEventListener('dragleave', () => cell.classList.remove('over'));
  cell.addEventListener('drop', e => {
    e.preventDefault(); cell.classList.remove('over');
    const from = e.dataTransfer.getData('text/x-ellashop-leaf');
    const pool = e.dataTransfer.getData('text/x-ellashop-photo');
    if (from !== '') {
      const source = PhotoSheet.treeLeaves(collageSheet()?.root)[Number(from)];
      if (source && source !== leaf) {
        [source.item, leaf.item] = [leaf.item, source.item]; collageSetCellFormats(collageSheet());
        collageSelect(leaf); collageChanged();
      }
      return;
    }
    if (pool !== '') {
      const photo = collage.photos[Number(pool)];
      if (photo) { collagePlace(photo, leaf); collageChanged(); }
      return;
    }
    const files = [...(e.dataTransfer.files || [])].filter(file => file.type.startsWith('image/'));
    if (files.length) addCollage(files.map(file => ({ blob: file, name: file.name })), leaf);
  });
  collageCells.set(leaf, cell);
  return cell;
}

function collagePopulateCell(cell, leaf, sheet) {
  const item = leaf.item;
  cell.classList.toggle('empty', !item);
  cell.classList.toggle('selected', leaf === collage.sel);
  if (!item) {
    if (cell._item !== null) { cell.replaceChildren(); cell.textContent = t('collage_drop_photo'); cell._item = null; }
    return;
  }
  if (cell._item !== item) {
    cell.replaceChildren();
    const eye = document.createElement('button'); eye.className = 'eye'; eye.title = t('collage_open_single_view'); eye.textContent = '👁';
    eye.addEventListener('click', e => { e.stopPropagation(); collageSelect(leaf); collage.view = 'single'; collageChanged(); });
    const handle = document.createElement('button'); handle.className = 'collage-handle'; handle.title = t('collage_drag_swap'); handle.textContent = '⠿'; handle.draggable = true;
    handle.addEventListener('dragstart', e => {
      e.stopPropagation(); e.dataTransfer.setData('text/x-ellashop-leaf', String(PhotoSheet.treeLeaves(sheet.root).indexOf(leaf)));
      e.dataTransfer.effectAllowed = 'move';
    });
    const canvas = document.createElement('canvas');
    PhotoUI.photoCanvas(canvas, item, {
      onSelect: () => collageSelect(leaf),
      onMove: () => collagePaintCell(cell, leaf, item, sheet),
      onDone: () => queueSave('collage'),
      onWheel: () => { collagePaintCell(cell, leaf, item, sheet); syncCollageControls(); queueSave('collage'); },
    });
    cell.append(eye, handle, canvas); cell._item = item;
  }
  collagePaintCell(cell, leaf, item, sheet);
}

function collagePaintCell(cell, leaf, item, sheet, rect = cell._rect) {
  const canvas = cell.querySelector('canvas'); if (!canvas || !rect) return;
  const r = cell.getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
  const W = Math.max(1, Math.round(r.width * 2 * dpr)), H = Math.max(1, Math.round(r.height * 2 * dpr));
  canvas.style.filter = PhotoRender.densityFilter(sheet.density);
  PhotoUI.paintCached(canvas, item, { w: rect.w, h: rect.h }, W, H, PhotoRender.renderItem, `collage|${sheet.density}`);
}

function collageRenderDividers(sheet, paper, rect) {
  if (!sheet || sheet.layout === 'size') return [];
  return PhotoSheet.treeDividers(sheet).map(d => {
    const el = document.createElement('div'); el.className = `collage-divider ${d.dir}`;
    if (d.dir === 'row') Object.assign(el.style, {
      left: `${d.x / paper.w * 100}%`, top: `${d.spanStart / paper.h * 100}%`,
      height: `${d.spanLength / paper.h * 100}%`,
    });
    else Object.assign(el.style, {
      left: `${d.spanStart / paper.w * 100}%`, top: `${d.y / paper.h * 100}%`,
      width: `${d.spanLength / paper.w * 100}%`,
    });
    el.addEventListener('pointerdown', e => {
      e.preventDefault(); e.stopPropagation();
      const start = d.dir === 'row' ? e.clientX : e.clientY, sizes = [...d.node.sizes];
      collageMagnetGuide = null;
      const move = ev => {
        PhotoSheet.applyDivider(d, sizes, start, d.dir === 'row' ? ev.clientX : ev.clientY, sheet, $('#collage-sheet').getBoundingClientRect());
        const i = d.index, rawLeft = d.node.sizes[i];
        const snapped = collageMagnet && !ev.altKey ? PhotoSheet.snapDivider(d, sizes, rawLeft, sheet) : null;
        if (snapped != null) {
          const pair = sizes[i] + sizes[i + 1];
          d.node.sizes[i] = snapped; d.node.sizes[i + 1] = pair - snapped;
          const base = d.dir === 'row' ? d.x : d.y;
          collageMagnetGuide = { sheet, dir: d.dir, at: base + (snapped - sizes[i]) * d.parentLength };
        } else collageMagnetGuide = null;
        sheet.layout = 'custom'; collageSetCellFormats(sheet); refreshCollage(false);
      };
      const done = () => {
        document.removeEventListener('pointermove', move); document.removeEventListener('pointerup', done); document.removeEventListener('pointercancel', done);
        if (collageMagnetGuide?.sheet === sheet) { collageMagnetGuide = null; refreshCollage(false); }
        queueSave('collage');
      };
      document.addEventListener('pointermove', move); document.addEventListener('pointerup', done, { once: true });
      document.addEventListener('pointercancel', done, { once: true });
    });
    return el;
  });
}

function collageRenderCutLines(sheet, rects, paper) {
  if (!sheet?.cutLines || Number(sheet.gap) !== 0) return [];
  return PhotoSheet.sharedSegments(rects).map(line => {
    const el = document.createElement('div'); el.className = 'collage-cut-line';
    if (line.dir === 'row') Object.assign(el.style, {
      left: `calc(${line.x / paper.w * 100}% - 1px)`, top: `${line.y / paper.h * 100}%`,
      width: '2px', height: `${line.h / paper.h * 100}%`,
    });
    else Object.assign(el.style, {
      left: `${line.x / paper.w * 100}%`, top: `calc(${line.y / paper.h * 100}% - 1px)`,
      width: `${line.w / paper.w * 100}%`, height: '2px',
    });
    return el;
  });
}

function renderCollageSheetView() {
  const stage = $('#collage-stage'), box = $('#collage-sheet'), sheet = collageSheet(), canvas = $('#collage-canvas');
  if (!sheet) { box.replaceChildren(); box.hidden = true; canvas.hidden = true; return; }
  const rects = cellRects(sheet), leaves = rects.map(r => r.leaf), paper = PhotoSheet.sheetMM(sheet);
  const filled = collageFilledLeaves(sheet);
  if (collage.view === 'single' && (!collage.sel?.item || !filled.includes(collage.sel))) collage.view = 'sheet';
  const single = collage.view === 'single';
  $('#collage-layout-section').hidden = single;
  $('#collage-layout-note').hidden = !single;
  $('#collage-composition-row').hidden = !single;
  const viewBar = $('#collage-view-bar'), hint = $('#collage-hint'), emptyPool = !collage.photos.length;
  viewBar.hidden = emptyPool;
  if (emptyPool) {
    if (hint.parentElement !== stage) stage.append(hint);
    hint.classList.add('collage-empty-hint');
  } else {
    const seg = viewBar.querySelector('.seg');
    if (hint.parentElement !== viewBar || hint.previousElementSibling !== seg) seg.after(hint);
    hint.classList.remove('collage-empty-hint');
  }
  hint.hidden = single;
  hint.textContent = emptyPool
    ? t('collage_add_photos_hint')
    : t('collage_drag_photos_hint');
  viewBar.classList.toggle('has-hint', !single && !emptyPool);
  viewBar.querySelectorAll('[data-view]').forEach(b => b.classList.toggle('on', b.dataset.view === collage.view));
  PhotoUI.stepBar(viewBar, filled, collage.sel, single);
  $('#collage-add-sheet').hidden = single;
  box.hidden = single; canvas.hidden = !single;
  if (single) {
    collage.preview.draw(); canvas.style.filter = PhotoRender.densityFilter(sheet.density);
    return;
  }
  const stageRect = stage.getBoundingClientRect(), cs = getComputedStyle(stage);
  const maxW = Math.max(50, stageRect.width - 48), maxH = Math.max(50, stageRect.height - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom) - 8 - (emptyPool ? 28 : 0));  // room for the hint under the sheet
  const scale = Math.min(maxW / paper.w, maxH / paper.h), cssW = paper.w * scale, cssH = paper.h * scale;
  box.style.width = `${cssW}px`; box.style.height = `${cssH}px`; box.style.background = sheet.gapColor;
  box.replaceChildren();
  for (const rect of rects) {
    const cell = collageCellElement(rect.leaf); cell._rect = rect;
    Object.assign(cell.style, { left: `${rect.x / paper.w * 100}%`, top: `${rect.y / paper.h * 100}%`,
      width: `${rect.w / paper.w * 100}%`, height: `${rect.h / paper.h * 100}%` });
    box.append(cell); collagePopulateCell(cell, rect.leaf, sheet);
  }
  box.append(...collageRenderCutLines(sheet, rects, paper), ...collageRenderDividers(sheet, paper), ...collageRenderMagnetGuide(sheet, paper));
  hint.style.top = emptyPool ? `${box.offsetTop + box.offsetHeight + 8}px` : '';
  collageShownSheet = sheet; collageShownLeaves = leaves;
}

function renderCollageTabs() {
  PhotoUI.tabs($('#collage-tabs'), collage.sheets, {
    cls: { tab: 'collage-tab', pick: 'collage-pick', name: 'collage-tab-name', close: 'collage-close' },
    label: (sheet, i) => t('collage_sheet', i + 1),
    active: sheet => sheet === collageSheet(),
    onPick: (sheet, i) => { collage.active = i; collage.sel = PhotoSheet.treeLeaves(sheet.root)[0] || null; collage.view = 'sheet'; collageChanged(); },
    onClose: (sheet, i) => {
      const count = collageFilledLeaves(sheet).length;
      if (count && !confirm(t('collage_close_filled_sheet', i + 1, count))) return;
      collage.sheets.splice(i, 1);
      if (!collage.sheets.length) collage.sheets.push(collageDefaultSheet());
      collage.active = Math.max(0, Math.min(collage.active - (i < collage.active ? 1 : 0), collage.sheets.length - 1));
      collage.sel = PhotoSheet.treeLeaves(collageSheet().root)[0] || null; collage.view = 'sheet';
      collageChanged();
    },
    closeTitle: t('collage_close_sheet'),
  });
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

function syncCollageControls() {
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
  $('#collage-magnet').checked = collageMagnet;
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

function refreshCollage() {
  if (!collage.sheets.length) collage.sheets.push(collageDefaultSheet());
  collage.active = Math.max(0, Math.min(collage.active, collage.sheets.length - 1));
  if (!collage.sel || !PhotoSheet.treeLeaves(collageSheet().root).includes(collage.sel)) collage.sel = PhotoSheet.treeLeaves(collageSheet().root)[0] || null;
  renderCollageTabs(); renderCollagePool(); syncCollageControls(); renderCollageSheetView();
}

function selectCollageView(view) {
  if (view === 'single' && !collage.sel?.item) collage.sel = collageFilledLeaves()[0] || null;
  collage.view = view === 'single' && collage.sel?.item ? 'single' : 'sheet';
  collageChanged();
}

collage.preview = new PhotoEditor.Stage($('#collage-canvas'), $('#collage-stage'), {
  getItem: () => collage.sel?.item,
  sizeMM: item => item.fmt,
  onChange: done => {
    if (done) collageChanged();
  },
});
PhotoUI.wireGuides('collage', collage.preview);
// Keys act on the selected sheet cell while the sheet shows; Escape leaves the single view; O needs the single view.
PhotoUI.keys.register('collage', {
  active: () => $('#collage').classList.contains('active'),
  item: () => collage.sel?.item, stage: collage.preview,
  panTarget: () => collageSelectedCanvas(),
  changed: collageChanged,
  escape: () => {
    if (collage.view !== 'single') return false;
    collage.view = 'sheet'; collageChanged(); return true;
  },
  guides: () => collage.view === 'single',
});

$('#collage-view-bar').addEventListener('click', e => {
  const button = e.target.closest('button'); if (!button) return;
  if (button.dataset.view) selectCollageView(button.dataset.view);
  else if (button.dataset.step) {
    const next = PhotoUI.neighbour(collageFilledLeaves(), collage.sel, Number(button.dataset.step));
    if (next) { collage.sel = next; refreshCollage(); }
  }
});

$('#collage-add-sheet').addEventListener('click', () => {
  collage.sheets.push(collageDefaultSheet(collageSheet())); collage.active = collage.sheets.length - 1;
  collage.sel = PhotoSheet.treeLeaves(collageSheet().root)[0] || null; collage.view = 'sheet';
  collageChanged();
});

wireDrop($('#collage-drop'), $('#collage-file'), files => addCollage(files.map(file => ({ blob: file, name: file.name }))));
$('[data-incoming="collage"]').addEventListener('click', async () => {
  const names = await pickIncoming(true);
  await addCollage(names.map(name => ({ src: '/incoming/' + encodeURIComponent(name), name })));
});

async function addCollage(sources, firstCell = null) {
  const sheet = collageSheet(); if (!sheet) return;
  for (const source of sources) {
    try {
      const stored = await storedSource(source, 'collage'), img = await loadImage(stored.src || workspaceUrl('collage', stored.file));
      const photo = { file: stored.file, name: stored.name || source.name, img };
      collage.photos.push(photo);
      const target = firstCell || collageFirstEmpty(sheet);
      if (target) collagePlace(photo, target, sheet);
      firstCell = null;
    } catch (e) { setStatus($('#collage-status'), `${source.name}: ${e.message}`, true); }
  }
  collageChanged();
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
  collageMagnet = e.currentTarget.checked; collageMagnetGuide = null;
  try { localStorage.setItem('ellashop-collage-magnet', collageMagnet ? 'on' : 'off'); } catch (_) { /* Storage may be unavailable. */ }
  refreshCollage();
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

wireSeg($('#collage-mode'), mode => {
  const item = collage.sel?.item; if (!item) return;
  PhotoEditor.setMode(item, mode); collageChanged();
});
// Rotate, zoom and reset of the selected cell's photo are the shared ones (Reset leaves the 90° turn and the fill mode alone).
PhotoUI.wireAdjust('collage', {
  item: () => collage.sel?.item, changed: collageChanged,
  redraw: () => { if (collage.view === 'single') collage.preview.draw(); else renderCollageSheetView(); queueSave('collage'); },
});
$('#collage-empty').addEventListener('click', () => {
  if (collage.sel) { collage.sel.item = null; collage.view = 'sheet'; collageChanged(); }
});

function confirmCollageEmpty(sheet, action = 'save') {
  const empty = cellRects(sheet).filter(r => !r.leaf.item).length;
  return !empty || confirm(t(action === 'move' ? 'collage_empty_cells_move' : 'collage_empty_cells_save', empty));
}

function collageDpi(sheet) {
  const paper = PhotoSheet.sheetMM(sheet);
  return Math.max(paper.w, paper.h) > 300 ? CANVAS_DPI : DPI;
}

// Cut lines help trim a printed sheet; a canvas is one print, so Move to Canvas leaves them out.
// Also called from tests/ui/*.json.
async function renderCollage(sheet, { cutLines = sheet.cutLines } = {}) {
  return PhotoRender.renderSheet(sheet, { dpi: collageDpi(sheet), cutLines, cellRects: cellRects(sheet) });
}

async function saveCollageSheet(sheet, index) {
  if (!confirmCollageEmpty(sheet)) return null;
  const paper = PhotoSheet.sheetMM(sheet);
  return PhotoRender.exportSheet(sheet, {
    name: `collage_${index + 1}_${paper.w}x${paper.h}.jpg`, folder: 'Collage',
    dpi: collageDpi(sheet), cellRects: cellRects(sheet),
  });
}

$('#collage-to-canvas').addEventListener('click', async () => {
  const sheet = collageSheet(); if (!sheet) return;
  if (!confirmCollageEmpty(sheet, 'move')) return;
  const paper = PhotoSheet.sheetMM(sheet), short = Math.min(paper.w, paper.h), long = Math.max(paper.w, paper.h);
  const customId = customFormatId(short / 10, long / 10, CANVAS_FORMATS);
  const fmt = CANVAS_FORMATS.find(f => f.w === short && f.h === long) ||
    (customId ? formatById(CANVAS_FORMATS, customId) : null);
  if (!fmt) {
    setStatus($('#collage-status'), t('collage_canvas_size_error'), true); return;
  }
  const epoch = workspaces.canvas.epoch;
  try {
    setStatus($('#collage-status'), t('collage_moving'));
    const canvas = PhotoRender.renderSheet(sheet, { dpi: collageDpi(sheet), cutLines: false, cellRects: cellRects(sheet) });
    const name = `collage_${collage.active + 1}_${paper.w}x${paper.h}.jpg`;
    const { file, src } = await uploadPhoto(await PhotoRender.jpegBlob(canvas, 1, collageDpi(sheet), sheet.density), name, 'canvas');
    const img = await loadImage(src);
    if (epoch !== workspaces.canvas.epoch) return;
    canvasPrints.last.fmt = fmt; canvasPrints.last.orient = sheet.orient;
    const item = PhotoEditor.newItem(img, name, { ...canvasPrints.last, file, fmt, orient: sheet.orient, density: 0 });
    canvasPrints.items.push(item); canvasPrints.sel = item; canvasPrints.view = 'single';
    refreshCanvas(); queueSave('canvas');
    $('.tab[data-tab=canvas-view]').click();
    setStatus($('#collage-status'), t('collage_moved_to_canvas'));
  } catch (e) { setStatus($('#collage-status'), e.message, true); }
});

// A cancelled save (empty-cell confirm) returns null, which wireSave neither reports nor counts.
PhotoUI.wireSave('collage', {
  item: collageSheet, items: () => collage.sheets,
  save: sheet => saveCollageSheet(sheet, collage.sheets.indexOf(sheet)),
  msg: { saving: 'collage_saving', savedFile: 'collage_saved_file', savingCount: 'collage_saving_sheet', savedAll: 'collage_saved_sheets' },
});

function collageState() {
  const tree = node => node.leaf ? { leaf: true, item: node.item ? itemState(node.item) : null }
    : { dir: node.dir, sizes: [...node.sizes], children: node.children.map(tree) };
  return {
    photos: collage.photos.map(({ file, name }) => ({ file, name })),
    sheets: collage.sheets.map(sheet => ({
      id: sheet.id, fmt: sheet.fmt.id, orient: sheet.orient, gap: sheet.gap, margin: sheet.margin,
      gapColor: sheet.gapColor, cutLines: sheet.cutLines, density: sheet.density,
      layout: sheet.layout, sizeCell: sheet.sizeCell ? { ...sheet.sizeCell } : null, root: tree(sheet.root),
    })),
    active: collage.active, view: collage.view,
  };
}

async function collageTreeFromState(saved, imageFor) {
  if (!saved || saved.leaf) {
    const leaf = PhotoSheet.leaf();
    if (saved?.item?.file) {
      const img = await imageFor(saved.item.file);
      leaf.item = PhotoEditor.newItem(img, saved.item.name || saved.item.file, { ...saved.item, file: saved.item.file, fmt: formatById(COLLAGE_PAPERS, saved.item.fmt) });
    }
    return leaf;
  }
  const safe = PhotoSheet.normalizeTree(saved);
  const children = [];
  for (const child of saved.children || []) children.push(await collageTreeFromState(child, imageFor));
  safe.children = children;
  return safe;
}

// One saved sheet back to a live one; validates every field. `imageFor(file)` loads a photo's image.
async function collageSheetFromState(saved, imageFor) {
  return {
    id: collageSavedId(saved.id), fmt: formatById(COLLAGE_PAPERS, saved.fmt),
    orient: saved.orient === 'landscape' ? 'landscape' : 'portrait', gap: Number(saved.gap) || 0,
    margin: Number(saved.margin) || 0, gapColor: saved.gapColor === '#000000' ? '#000000' : '#ffffff',
    cutLines: saved.cutLines !== false, density: Math.max(-5, Math.min(5, Number(saved.density) || 0)),
    layout: ['grid', 'size', 'template', 'custom'].includes(saved.layout) ? saved.layout : 'grid',
    sizeCell: saved.sizeCell && Number(saved.sizeCell.w) > 0 && Number(saved.sizeCell.h) > 0
      ? { w: Number(saved.sizeCell.w), h: Number(saved.sizeCell.h) } : { w: 50, h: 75 },
    root: await collageTreeFromState(saved.root, imageFor),
  };
}

// Rebuild the photo pool and sheets from saved state; a photo or sheet that fails to load is reported and skipped.
async function collageRestore(state, imageFor) {
  const photos = [], sheets = [];
  for (const saved of state.photos || []) {
    try { photos.push({ file: saved.file, name: saved.name || saved.file, img: await imageFor(saved.file) }); }
    catch (e) { showWorkspaceError('collage', new Error(`${saved.name || saved.file}: ${e.message}`)); }
  }
  for (const saved of state.sheets || []) {
    try { sheets.push(await collageSheetFromState(saved, imageFor)); }
    catch (e) { showWorkspaceError('collage', e); }
  }
  collage.photos = photos; collage.sheets = sheets;
  if (!collage.sheets.length) collage.sheets.push(collageDefaultSheet());
  collage.active = Math.max(0, Math.min(Number(state.active) || 0, collage.sheets.length - 1));
  collage.view = state.view === 'single' ? 'single' : 'sheet';
  collage.sel = PhotoSheet.treeLeaves(collageSheet().root)[0] || null;
  if (collage.view === 'single' && !collage.sel?.item) collage.sel = collageFilledLeaves()[0] || collage.sel;
  collage.sheets.forEach(collageSetCellFormats);
  refreshCollage();
}

const restoreCollageWorkspace = state => collageRestore(state, file => loadImage(workspaceUrl('collage', file)));
const restoreCollageSnapshot = state => collageRestore(state, file => historyImage('collage', file));

function clearCollage() {
  collage.photos = []; collage.sheets = [collageDefaultSheet()]; collage.active = 0; collage.sel = PhotoSheet.treeLeaves(collageSheet().root)[0]; collage.view = 'sheet';
  setStatus($('#collage-status'), ''); refreshCollage();
}

// Keep the first sheet available before startup restores the saved workspace.
collage.sheets.push(collageDefaultSheet()); collage.sel = PhotoSheet.treeLeaves(collageSheet().root)[0];
$('#collage-sheet').addEventListener('dragover', e => { if (e.dataTransfer.types.includes('Files')) e.preventDefault(); });
$('#collage-stage').addEventListener('dragover', e => { if (e.dataTransfer.types.includes('Files')) e.preventDefault(); });
refreshCollage();
new ResizeObserver(() => { if (collage.view === 'sheet') renderCollageSheetView(); }).observe($('#collage-stage'));
