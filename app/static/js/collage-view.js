// The collage sheet view: the cells (populate and paint), dividers with the magnet guide, the cut-line preview,
// the sheet tabs, the photo pool and the sheet/single view bar. It reads the sheets from collage-model.js and
// asks collage-layout.js to show the selected cell's values in the controls.

import { $ } from './dom.js';
import { PhotoUI } from './photo-ui.js';
import { PhotoSheet } from './photo-sheet.js';
import { queueSave } from './orders.js';
import { t } from './i18n.js';
import { PhotoRender } from './photo-render.js';
import { syncCollageControls } from './collage-layout.js';
import {
  addCollage, cellRects, collage, collageCells, collageChanged, collageDefaultSheet, collageFilledLeaves, collageFirstEmpty,
  collageMagnet, collagePhotoForItem, collagePlace, collageRefresh, collageSetCellFormats, collageSheet, collageUsageCounts,
} from './collage-model.js';

let collageShownSheet = null, collageShownLeaves = [];

function collageRenderMagnetGuide(sheet, paper) {
  if (!collageMagnet.guide || collageMagnet.guide.sheet !== sheet) return [];
  const { dir, at } = collageMagnet.guide, guide = document.createElement('div');
  guide.className = `collage-magnet-guide ${dir}`;
  if (dir === 'row') guide.style.left = `${at / paper.w * 100}%`;
  else guide.style.top = `${at / paper.h * 100}%`;
  return [guide];
}

export function collageSelect(leaf) {
  collage.sel = leaf;
  for (const node of $('#collage-sheet').querySelectorAll('.collage-cell'))
    node.classList.toggle('selected', node._leaf === leaf);
  renderCollagePool(); syncCollageControls();
}

export function renderCollagePool() {
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
      onDone: () => { syncCollageControls(); queueSave('collage'); },
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
      collageMagnet.guide = null;
      const move = ev => {
        PhotoSheet.applyDivider(d, sizes, start, d.dir === 'row' ? ev.clientX : ev.clientY, sheet, $('#collage-sheet').getBoundingClientRect());
        const i = d.index, rawLeft = d.node.sizes[i];
        const snapped = collageMagnet.on && !ev.altKey ? PhotoSheet.snapDivider(d, sizes, rawLeft, sheet) : null;
        if (snapped != null) {
          const pair = sizes[i] + sizes[i + 1];
          d.node.sizes[i] = snapped; d.node.sizes[i + 1] = pair - snapped;
          const base = d.dir === 'row' ? d.x : d.y;
          collageMagnet.guide = { sheet, dir: d.dir, at: base + (snapped - sizes[i]) * d.parentLength };
        } else collageMagnet.guide = null;
        sheet.layout = 'custom'; collageSetCellFormats(sheet); collageRefresh();
      };
      const done = () => {
        document.removeEventListener('pointermove', move); document.removeEventListener('pointerup', done); document.removeEventListener('pointercancel', done);
        if (collageMagnet.guide?.sheet === sheet) { collageMagnet.guide = null; collageRefresh(); }
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

export function renderCollageSheetView() {
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

export function renderCollageTabs() {
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

function selectCollageView(view) {
  if (view === 'single' && !collage.sel?.item) collage.sel = collageFilledLeaves()[0] || null;
  collage.view = view === 'single' && collage.sel?.item ? 'single' : 'sheet';
  collageChanged();
}

$('#collage-view-bar').addEventListener('click', e => {
  const button = e.target.closest('button'); if (!button) return;
  if (button.dataset.view) selectCollageView(button.dataset.view);
  else if (button.dataset.step) {
    const next = PhotoUI.neighbour(collageFilledLeaves(), collage.sel, Number(button.dataset.step));
    if (next) { collage.sel = next; collageRefresh(); }
  }
});

$('#collage-add-sheet').addEventListener('click', () => {
  collage.sheets.push(collageDefaultSheet(collageSheet())); collage.active = collage.sheets.length - 1;
  collage.sel = PhotoSheet.treeLeaves(collageSheet().root)[0] || null; collage.view = 'sheet';
  collageChanged();
});

$('#collage-sheet').addEventListener('dragover', e => { if (e.dataTransfer.types.includes('Files')) e.preventDefault(); });
$('#collage-stage').addEventListener('dragover', e => { if (e.dataTransfer.types.includes('Files')) e.preventDefault(); });
new ResizeObserver(() => { if (collage.view === 'sheet') renderCollageSheetView(); }).observe($('#collage-stage'));
