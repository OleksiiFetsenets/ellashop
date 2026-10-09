'use strict';
// Places different photos into the cells of printable sheets.
// Loads after Passport and before shared keyboard controls.
// ---------------------------------------------------------------- collage

const collage = { photos: [], sheets: [], active: 0, sel: null, view: 'sheet' };
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

function collageRepackSize(sheet, priorItems = null, selectedIndex = 0) {
  if (!sheet || sheet.layout !== 'size') return;
  const items = priorItems || cellRects(sheet).map(r => r.leaf.item).filter(Boolean);
  const pack = PhotoSheet.sizePack(sheet);
  if (!pack) { sheet.layout = 'grid'; sheet.root = PhotoSheet.gridTree(1, 1); sheet.sizeCell = null; }
  else sheet.root = PhotoSheet.gridTree(pack.cols, pack.rows);
  const leaves = PhotoSheet.treeLeaves(sheet.root);
  leaves.forEach((leaf, i) => { leaf.item = items[i] || null; });
  collage.sel = leaves[Math.min(selectedIndex, Math.max(0, leaves.length - 1))] || null;
  collageSetCellFormats(sheet);
}

function collageReplaceRoot(sheet, root, layout) {
  const oldRects = cellRects(sheet), items = oldRects.map(r => r.leaf.item).filter(Boolean);
  const selectedIndex = Math.max(0, oldRects.findIndex(r => r.leaf === collage.sel));
  sheet.root = root; sheet.layout = layout;
  const leaves = PhotoSheet.treeLeaves(root);
  leaves.forEach((leaf, i) => { leaf.item = items[i] || null; });
  collage.sel = leaves[Math.min(selectedIndex, Math.max(0, leaves.length - 1))] || null;
  collageSetCellFormats(sheet);
  refreshCollage(); queueSave('collage');
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
  return newItem(photo.img, photo.name, {
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
  const list = $('#collage-pool'), usage = collageUsageCounts(); list.replaceChildren();
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
      refreshCollage(); queueSave('collage');
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
        collageSelect(leaf); refreshCollage(); queueSave('collage');
      }
      return;
    }
    if (pool !== '') {
      const photo = collage.photos[Number(pool)];
      if (photo) { collagePlace(photo, leaf); refreshCollage(); queueSave('collage'); }
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
    eye.addEventListener('click', e => { e.stopPropagation(); collageSelect(leaf); collage.view = 'single'; refreshCollage(); queueSave('collage'); });
    const handle = document.createElement('button'); handle.className = 'collage-handle'; handle.title = t('collage_drag_swap'); handle.textContent = '⠿'; handle.draggable = true;
    handle.addEventListener('dragstart', e => {
      e.stopPropagation(); e.dataTransfer.setData('text/x-ellashop-leaf', String(PhotoSheet.treeLeaves(sheet.root).indexOf(leaf)));
      e.dataTransfer.effectAllowed = 'move';
    });
    const canvas = document.createElement('canvas');
    let last = null;
    canvas.addEventListener('pointerdown', e => {
      collageSelect(leaf); last = [e.clientX, e.clientY]; canvas.setPointerCapture(e.pointerId);
    });
    canvas.addEventListener('pointermove', e => {
      if (!last) return;
      panOnCanvas(item, canvas, (it, W, H) => ({ x: 0, y: 0, w: W, h: H }), e.clientX - last[0], e.clientY - last[1]);
      last = [e.clientX, e.clientY]; item.auto = ''; item.smartPending = false;
      collagePaintCell(cell, leaf, item, sheet);
    });
    canvas.addEventListener('pointerup', () => { if (last) queueSave('collage'); last = null; });
    canvas.addEventListener('pointercancel', () => { last = null; });
    canvas.addEventListener('wheel', e => {
      if (item.mode === 'fit' || item.mode === 'blur') return;
      e.preventDefault(); item.zoom = clampZoom(item, item.zoom * Math.exp(-e.deltaY * .0015));
      collagePaintCell(cell, leaf, item, sheet); syncCollageControls(); queueSave('collage');
    }, { passive: false });
    cell.append(eye, handle, canvas); cell._item = item;
  }
  collagePaintCell(cell, leaf, item, sheet);
}

function collagePaintCell(cell, leaf, item, sheet, rect = cell._rect) {
  const canvas = cell.querySelector('canvas'); if (!canvas || !rect) return;
  const r = cell.getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
  const W = Math.max(1, Math.round(r.width * 2 * dpr)), H = Math.max(1, Math.round(r.height * 2 * dpr));
  if (canvas.width !== W) canvas.width = W;
  if (canvas.height !== H) canvas.height = H;
  canvas.style.filter = densityFilter(sheet.density);
  const mm = { w: rect.w, h: rect.h }, key = `${gridKey(item, mm, 'collage')}|${sheet.density}|${W}|${H}`;
  if (canvas._renderKey === key) return;
  renderItem(canvas.getContext('2d'), item, W, H);
  canvas._renderKey = key;
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
  viewBar.querySelectorAll('[data-step]').forEach(b => { b.hidden = !single; });
  const current = filled.indexOf(collage.sel), count = filled.length;
  const countEl = viewBar.querySelector('.view-count'); countEl.hidden = !single; countEl.textContent = `${Math.max(0, current + 1)} / ${count}`;
  viewBar.querySelector('[data-step="-1"]').disabled = !single || current <= 0;
  viewBar.querySelector('[data-step="1"]').disabled = !single || current < 0 || current >= count - 1;
  $('#collage-add-sheet').hidden = single;
  box.hidden = single; canvas.hidden = !single;
  if (single) {
    collage.preview.draw(); canvas.style.filter = densityFilter(sheet.density);
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
  const tabs = $('#collage-tabs'); tabs.replaceChildren();
  collage.sheets.forEach((sheet, i) => {
    const tab = document.createElement('div'); tab.className = `collage-tab${i === collage.active ? ' active' : ''}`;
    const pick = document.createElement('button'); pick.className = 'collage-pick'; pick.type = 'button';
    const name = document.createElement('span'); name.className = 'collage-tab-name'; name.textContent = t('collage_sheet', i + 1);
    pick.append(name); pick.addEventListener('click', () => { collage.active = i; collage.sel = PhotoSheet.treeLeaves(sheet.root)[0] || null; collage.view = 'sheet'; refreshCollage(); queueSave('collage'); });
    const close = document.createElement('button'); close.className = 'collage-close'; close.type = 'button'; close.title = t('collage_close_sheet'); close.textContent = '✕';
    close.addEventListener('click', e => {
      e.stopPropagation();
      const count = collageFilledLeaves(sheet).length;
      if (count && !confirm(t('collage_close_filled_sheet', i + 1, count))) return;
      collage.sheets.splice(i, 1);
      if (!collage.sheets.length) collage.sheets.push(collageDefaultSheet());
      collage.active = Math.max(0, Math.min(collage.active - (i < collage.active ? 1 : 0), collage.sheets.length - 1));
      collage.sel = PhotoSheet.treeLeaves(collageSheet().root)[0] || null; collage.view = 'sheet';
      refreshCollage(); queueSave('collage');
    });
    tab.append(pick, close); tabs.append(tab);
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
  refresh: () => { refreshCollage(); queueSave('collage'); },
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
  const mode = item?.mode || 'fill'; setSeg($('#collage-mode'), mode);
  $('#collage-zoom').value = item?.zoom || 1; $('#collage-zoom').disabled = !item || mode === 'fit' || mode === 'blur';
  $('#collage-mode').querySelectorAll('button').forEach(button => { button.disabled = !item; });
  ['#collage-rot-l', '#collage-rot-r', '#collage-zoom', '#collage-reset', '#collage-empty']
    .forEach(selector => { $(selector).disabled = !item; });
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
  refreshCollage(); queueSave('collage');
}

collage.preview = new Preview($('#collage-canvas'), $('#collage-stage'), {
  getItem: () => collage.sel?.item,
  sizeMM: item => item.fmt,
  onChange: done => {
    if (done) { refreshCollage(); queueSave('collage'); }
  },
});

$('#collage-view-bar').addEventListener('click', e => {
  const button = e.target.closest('button'); if (!button) return;
  if (button.dataset.view) selectCollageView(button.dataset.view);
  else if (button.dataset.step) {
    const filled = collageFilledLeaves(), index = filled.indexOf(collage.sel), next = index + Number(button.dataset.step);
    if (filled[next]) { collage.sel = filled[next]; refreshCollage(); }
  }
});

$('#collage-add-sheet').addEventListener('click', () => {
  collage.sheets.push(collageDefaultSheet(collageSheet())); collage.active = collage.sheets.length - 1;
  collage.sel = PhotoSheet.treeLeaves(collageSheet().root)[0] || null; collage.view = 'sheet';
  refreshCollage(); queueSave('collage');
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
  refreshCollage(); queueSave('collage');
}

function setCollagePaper(fmt) {
  const sheet = collageSheet(); if (!sheet) return;
  const selected = cellRects(sheet), items = selected.map(r => r.leaf.item).filter(Boolean), selectedIndex = Math.max(0, selected.findIndex(r => r.leaf === collage.sel));
  sheet.fmt = fmt;
  if (sheet.layout === 'size') collageRepackSize(sheet, items, selectedIndex);
  else collageSetCellFormats(sheet);
  refreshCollage(); queueSave('collage');
}

wireSeg($('#collage-orient'), orient => {
  const sheet = collageSheet(); if (!sheet) return;
  const oldRects = cellRects(sheet), items = oldRects.map(r => r.leaf.item).filter(Boolean), selectedIndex = Math.max(0, oldRects.findIndex(r => r.leaf === collage.sel));
  sheet.orient = orient;
  if (sheet.layout === 'size') collageRepackSize(sheet, items, selectedIndex); else collageSetCellFormats(sheet);
  refreshCollage(); queueSave('collage');
});

const collageLayoutControl = $('#collage-layout');
collageLayoutControl.addEventListener('click', e => {
  if (collage.view === 'single') { e.preventDefault(); e.stopImmediatePropagation(); }
}, true);
wireSeg(collageLayoutControl, layout => {
  if (collage.view === 'single') return;
  const sheet = collageSheet(); if (!sheet) return;
  if (layout === 'size') {
    const size = sheet.sizeCell || { w: 50, h: 75 }, old = cellRects(sheet), items = old.map(r => r.leaf.item).filter(Boolean);
    const index = Math.max(0, old.findIndex(r => r.leaf === collage.sel));
    sheet.sizeCell = { ...size }; sheet.layout = 'size'; collageRepackSize(sheet, items, index);
  } else if (layout === 'grid') {
    const dims = PhotoSheet.countGrid(PhotoSheet.treeLeaves(sheet.root).length || 4, sheet);
    collageReplaceRoot(sheet, PhotoSheet.gridTree(dims.cols, dims.rows), 'grid'); return;
  }
  else sheet.layout = layout;
  collageSetCellFormats(sheet); refreshCollage(); queueSave('collage');
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
  const old = cellRects(sheet), items = old.map(r => r.leaf.item).filter(Boolean), index = Math.max(0, old.findIndex(r => r.leaf === collage.sel));
  sheet.sizeCell = { w: size.w, h: size.h }; sheet.layout = 'size'; collageRepackSize(sheet, items, index);
  refreshCollage(); queueSave('collage');
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

$('#collage-split-row').addEventListener('click', () => { if (collage.view === 'single') return; collageSplitSelected('row'); });
$('#collage-split-col').addEventListener('click', () => { if (collage.view === 'single') return; collageSplitSelected('col'); });
$('#collage-merge').addEventListener('click', () => { if (collage.view === 'single') return; collageMergeSelected(); });
$('#collage-start-over').addEventListener('click', () => { if (collage.view === 'single') return; collageReplaceRoot(collageSheet(), PhotoSheet.leaf(), 'custom'); });
$('#collage-equalize').addEventListener('click', () => {
  if (collage.view === 'single') return;
  const sheet = collageSheet(); if (!sheet) return;
  const parent = collage.sel ? PhotoSheet.findParent(sheet.root, collage.sel) : null;
  if (parent) parent.sizes = PhotoSheet.equal(parent.children.length);
  else PhotoSheet.equalizeTree(sheet.root);
  sheet.layout = 'custom'; collageSetCellFormats(sheet); refreshCollage(); queueSave('collage');
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
  collageSetCellFormats(sheet); refreshCollage(); queueSave('collage');
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
  collageSetCellFormats(sheet); refreshCollage(); queueSave('collage');
}

function collageMetricChange(key, input) {
  const sheet = collageSheet(), next = Number(input.value), old = Number(sheet[key]);
  if (!input.validity.valid || input.value === '' || !Number.isFinite(next) || next < 0 || next > 20 || Math.round(next * 2) !== next * 2) {
    input.value = old; setStatus($('#collage-status'), t('collage_gap_margin_range_error'), true); return;
  }
  const prior = cellRects(sheet), items = prior.map(r => r.leaf.item).filter(Boolean), selectedIndex = Math.max(0, prior.findIndex(r => r.leaf === collage.sel));
  sheet[key] = next;
  const paper = PhotoSheet.sheetMM(sheet);
  const innerW = Math.max(0, paper.w - 2 * sheet.margin), innerH = Math.max(0, paper.h - 2 * sheet.margin);
  const fits = sheet.layout === 'size' ? !!PhotoSheet.sizePack(sheet) : PhotoSheet.treeFits(sheet.root, innerW, innerH, sheet.gap);
  if (sheet.margin * 2 >= Math.min(paper.w, paper.h) || !fits) {
    sheet[key] = old; input.value = old; setStatus($('#collage-status'), t('collage_spacing_no_room'), true); return;
  }
  if (sheet.layout === 'size') collageRepackSize(sheet, items, selectedIndex); else collageSetCellFormats(sheet);
  refreshCollage(); queueSave('collage');
}

$('#collage-gap').addEventListener('change', e => collageMetricChange('gap', e.currentTarget));
$('#collage-margin').addEventListener('change', e => collageMetricChange('margin', e.currentTarget));
wireSeg($('#collage-gap-color'), color => { const sheet = collageSheet(); sheet.gapColor = color; refreshCollage(); queueSave('collage'); });
$('#collage-cutlines').addEventListener('change', e => { const sheet = collageSheet(); sheet.cutLines = e.currentTarget.checked; refreshCollage(); queueSave('collage'); });

wireSeg($('#collage-mode'), mode => {
  const item = collage.sel?.item; if (!item) return;
  item.mode = mode; refreshCollage(); queueSave('collage');
});
$('#collage-rot-l').addEventListener('click', () => { const it = collage.sel?.item; if (it) { it.rot = (it.rot + 270) % 360; refreshCollage(); queueSave('collage'); } });
$('#collage-rot-r').addEventListener('click', () => { const it = collage.sel?.item; if (it) { it.rot = (it.rot + 90) % 360; refreshCollage(); queueSave('collage'); } });
$('#collage-zoom').addEventListener('input', e => {
  const item = collage.sel?.item; if (!item) return;
  item.zoom = clampZoom(item, Number(e.currentTarget.value));
  if (collage.view === 'single') collage.preview.draw(); else renderCollageSheetView();
  queueSave('collage');
});
$('#collage-reset').addEventListener('click', () => {
  const item = collage.sel?.item; if (!item) return;
  Object.assign(item, { zoom: 1, cx: .5, cy: .5, tilt: 0, rot: 0, mode: 'fill' });
  refreshCollage(); queueSave('collage');
});
$('#collage-empty').addEventListener('click', () => {
  if (collage.sel) { collage.sel.item = null; collage.view = 'sheet'; refreshCollage(); queueSave('collage'); }
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
async function renderCollage(sheet, { cutLines = sheet.cutLines } = {}) {
  const paper = PhotoSheet.sheetMM(sheet), dpi = collageDpi(sheet);
  const PW = mm2px(paper.w, dpi), PH = mm2px(paper.h, dpi), canvas = document.createElement('canvas');
  canvas.width = PW; canvas.height = PH;
  const ctx = canvas.getContext('2d'); ctx.fillStyle = sheet.gapColor; ctx.fillRect(0, 0, PW, PH);
  for (const rect of cellRects(sheet)) {
    const x = mm2px(rect.x, dpi), y = mm2px(rect.y, dpi), w = mm2px(rect.w, dpi), h = mm2px(rect.h, dpi);
    if (!rect.leaf.item) { ctx.fillStyle = '#ffffff'; ctx.fillRect(x, y, w, h); continue; }
    const item = rect.leaf.item, photo = renderHQ(w, h, shrinks(item, w, h), (c, cw, ch) => renderItem(c, item, cw, ch));
    ctx.drawImage(photo, x, y, w, h);
  }
  if (cutLines && Number(sheet.gap) === 0) {
    ctx.fillStyle = '#000';
    for (const line of PhotoSheet.sharedSegments(cellRects(sheet))) {
      if (line.dir === 'row') ctx.fillRect(mm2px(line.x, dpi) - 1, mm2px(line.y, dpi), 2, mm2px(line.h, dpi));
      else ctx.fillRect(mm2px(line.x, dpi), mm2px(line.y, dpi) - 1, mm2px(line.w, dpi), 2);
    }
  }
  return canvas;
}

async function saveCollageSheet(sheet, index) {
  if (!confirmCollageEmpty(sheet)) return null;
  const paper = PhotoSheet.sheetMM(sheet), dpi = collageDpi(sheet), canvas = await renderCollage(sheet);
  const name = `collage_${index + 1}_${paper.w}x${paper.h}.jpg`;
  return saveFile(await jpegBlob(canvas, 1, dpi, sheet.density), name, 'Collage');
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
    const canvas = await renderCollage(sheet, { cutLines: false }), name = `collage_${collage.active + 1}_${paper.w}x${paper.h}.jpg`;
    const { file, src } = await uploadPhoto(await jpegBlob(canvas, 1, collageDpi(sheet), sheet.density), name, 'canvas');
    const img = await loadImage(src);
    if (epoch !== workspaces.canvas.epoch) return;
    canvasPrints.last.fmt = fmt; canvasPrints.last.orient = sheet.orient;
    const item = newItem(img, name, { ...canvasPrints.last, file, fmt, orient: sheet.orient, density: 0 });
    canvasPrints.items.push(item); canvasPrints.sel = item; canvasPrints.view = 'single';
    refreshCanvas(); queueSave('canvas');
    $('.tab[data-tab=canvas-view]').click();
    setStatus($('#collage-status'), t('collage_moved_to_canvas'));
  } catch (e) { setStatus($('#collage-status'), e.message, true); }
});

$('#collage-save-one').addEventListener('click', async () => {
  const sheet = collageSheet(); if (!sheet) return;
  try {
    setStatus($('#collage-status'), t('collage_saving'));
    const saved = await saveCollageSheet(sheet, collage.active);
    if (saved) setStatus($('#collage-status'), t('collage_saved_file', saved));
  } catch (e) { setStatus($('#collage-status'), e.message, true); }
});
$('#collage-save-all').addEventListener('click', async () => {
  const saved = [];
  try {
    for (const [i, sheet] of collage.sheets.entries()) {
      setStatus($('#collage-status'), t('collage_saving_sheet', i + 1, collage.sheets.length));
      const name = await saveCollageSheet(sheet, i); if (name) saved.push(name);
    }
    setStatus($('#collage-status'), t('collage_saved_sheets', saved.length));
  } catch (e) { setStatus($('#collage-status'), e.message, true); }
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

async function collageTreeFromState(saved, owner, imageFor) {
  if (!saved || saved.leaf) {
    const leaf = PhotoSheet.leaf();
    if (saved?.item?.file) {
      const img = await imageFor(saved.item.file);
      leaf.item = newItem(img, saved.item.name || saved.item.file, { ...saved.item, file: saved.item.file, fmt: formatById(COLLAGE_PAPERS, saved.item.fmt) });
    }
    return leaf;
  }
  const safe = PhotoSheet.normalizeTree(saved);
  const children = [];
  for (const child of saved.children || []) children.push(await collageTreeFromState(child, owner, imageFor));
  safe.children = children;
  return safe;
}

async function restoreCollageWorkspace(state) {
  collage.photos = [];
  for (const saved of state.photos || []) {
    try { collage.photos.push({ file: saved.file, name: saved.name || saved.file, img: await loadImage(workspaceUrl('collage', saved.file)) }); }
    catch (e) { showWorkspaceError('collage', new Error(`${saved.name || saved.file}: ${e.message}`)); }
  }
  collage.sheets = [];
  for (const saved of state.sheets || []) {
    try {
      const sheet = {
        id: collageSavedId(saved.id), fmt: formatById(COLLAGE_PAPERS, saved.fmt),
        orient: saved.orient === 'landscape' ? 'landscape' : 'portrait', gap: Number(saved.gap) || 0,
        margin: Number(saved.margin) || 0, gapColor: saved.gapColor === '#000000' ? '#000000' : '#ffffff',
        cutLines: saved.cutLines !== false, density: Math.max(-5, Math.min(5, Number(saved.density) || 0)),
        layout: ['grid', 'size', 'template', 'custom'].includes(saved.layout) ? saved.layout : 'grid',
        sizeCell: saved.sizeCell && Number(saved.sizeCell.w) > 0 && Number(saved.sizeCell.h) > 0
          ? { w: Number(saved.sizeCell.w), h: Number(saved.sizeCell.h) } : { w: 50, h: 75 },
        root: PhotoSheet.normalizeTree(saved.root),
      };
      sheet.root = await collageTreeFromState(saved.root, 'collage', file => restoreItem({ file }, 'collage', COLLAGE_PAPERS).then(item => item.img));
      collage.sheets.push(sheet);
    } catch (e) { showWorkspaceError('collage', e); }
  }
  if (!collage.sheets.length) collage.sheets.push(collageDefaultSheet());
  collage.active = Math.max(0, Math.min(Number(state.active) || 0, collage.sheets.length - 1));
  collage.view = state.view === 'single' ? 'single' : 'sheet';
  collage.sel = PhotoSheet.treeLeaves(collageSheet().root)[0] || null;
  if (collage.view === 'single' && !collage.sel?.item) collage.sel = collageFilledLeaves()[0] || collage.sel;
  collage.sheets.forEach(collageSetCellFormats);
  refreshCollage();
}

async function restoreCollageSnapshot(state) {
  const photos = [];
  for (const saved of state.photos || []) {
    try { photos.push({ file: saved.file, name: saved.name || saved.file, img: await historyImage('collage', saved.file) }); }
    catch (e) { showWorkspaceError('collage', new Error(`${saved.name || saved.file}: ${e.message}`)); }
  }
  collage.photos = photos; collage.sheets = [];
  const imageFor = file => historyImage('collage', file);
  for (const saved of state.sheets || []) {
    const sheet = {
      id: collageSavedId(saved.id), fmt: formatById(COLLAGE_PAPERS, saved.fmt),
      orient: saved.orient === 'landscape' ? 'landscape' : 'portrait', gap: Number(saved.gap) || 0,
      margin: Number(saved.margin) || 0, gapColor: saved.gapColor === '#000000' ? '#000000' : '#ffffff',
      cutLines: saved.cutLines !== false, density: Math.max(-5, Math.min(5, Number(saved.density) || 0)),
      layout: ['grid', 'size', 'template', 'custom'].includes(saved.layout) ? saved.layout : 'grid',
      sizeCell: saved.sizeCell ? { ...saved.sizeCell } : { w: 50, h: 75 },
      root: await collageTreeFromState(saved.root, 'collage', imageFor),
    };
    collage.sheets.push(sheet);
  }
  if (!collage.sheets.length) collage.sheets.push(collageDefaultSheet());
  collage.active = Math.max(0, Math.min(Number(state.active) || 0, collage.sheets.length - 1));
  collage.view = state.view === 'single' ? 'single' : 'sheet';
  collage.sel = PhotoSheet.treeLeaves(collageSheet().root)[0] || null;
  if (collage.view === 'single' && !collage.sel?.item) collage.sel = collageFilledLeaves()[0] || collage.sel;
  collage.sheets.forEach(collageSetCellFormats); refreshCollage();
}

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
