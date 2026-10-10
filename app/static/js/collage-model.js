// Collage state and the sheets/cells model helpers shared by the layout panel (collage-layout.js), the sheet
// view (collage-view.js) and the page wiring (collage.js). It draws nothing: the page registers what a change
// refreshes in collageHooks.refresh, so this file imports neither of the other collage files.

import { $, setStatus } from './dom.js';
import { FORMATS } from './config.js';
import { queueSave } from './orders.js';
import { PhotoEditor } from './photo-editor.js';
import { PhotoSheet } from './photo-sheet.js';
import { loadImage } from './assets.js';
import { storedSource, workspaceUrl } from './app-state.js';

export const collage ={ photos: [], sheets: [], active: 0, sel: null, view: 'sheet' };

let nextCollageSheetId = 1;
// The divider magnet: whether it snaps, and the guide line shown while a divider is dragged.
export const collageMagnet = { on: true, guide: null };
try { collageMagnet.on = localStorage.getItem('ellashop-collage-magnet') !== 'off'; } catch (_) { /* Storage may be unavailable. */ }
export const collageCells = new WeakMap();
// Set by collage.js: redraws the whole page after a change.
export const collageHooks = { refresh() {} };
export const collageRefresh = () => collageHooks.refresh();

export const collageSheet = () => collage.sheets[collage.active] || null;
// Forwards to PhotoSheet that apply the active sheet by default (also called from tests/ui/*.json).
export const cellRects = (sheet = collageSheet()) => PhotoSheet.cellRects(sheet);
export const collageSetCellFormats = (sheet = collageSheet()) => PhotoSheet.setCellFormats(sheet);
// Forwards used only by tests/ui/*.json.
export const collageSheetMM = sheet => PhotoSheet.sheetMM(sheet);
export const collageLeaf = item => PhotoSheet.leaf(item);
export const collageSharedSegments = rects => PhotoSheet.sharedSegments(rects);
export const collageTreeDividers = sheet => PhotoSheet.treeDividers(sheet);
export function collageSavedId(id) {
  const match = /^sheet-(\d+)$/.exec(id || '');
  if (match) nextCollageSheetId = Math.max(nextCollageSheetId, Number(match[1]) + 1);
  return id || `sheet-${nextCollageSheetId++}`;
}

export function collageDefaultSheet(copy = null) {
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
export function collageChanged() { collageRefresh(); queueSave('collage'); }

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
export function collageReflow(sheet, change) {
  if (!sheet) return;
  const held = collageHeld(sheet);
  if (change() === false) return;
  if (sheet.layout === 'size') collageRepackSize(sheet, held); else collageSetCellFormats(sheet);
  collageChanged();
}

export function collageReplaceRoot(sheet, root, layout) {
  const held = collageHeld(sheet);
  sheet.root = root; sheet.layout = layout;
  collageFill(PhotoSheet.treeLeaves(root), held);
  collageSetCellFormats(sheet);
  collageChanged();
}

function collageNewCellItem(photo, rect) {
  return PhotoEditor.newItem(photo.img, photo.name, {
    file: photo.file, orient: 'portrait', fmt: { id: 'cell', w: rect.w, h: rect.h },
    mode: 'fill', blur: 'motion', strength: 50, overlays: [],
  });
}

export function collagePhotoForItem(item) {
  return item && collage.photos.find(photo => photo.file && photo.file === item.file);
}

export function collagePlace(photo, leaf, sheet = collageSheet()) {
  if (!photo || !leaf || !sheet) return;
  const rect = cellRects(sheet).find(r => r.leaf === leaf);
  if (!rect) return;
  leaf.item = collageNewCellItem(photo, rect);
  collage.sel = leaf;
}

export function collageFirstEmpty(sheet = collageSheet()) { return cellRects(sheet).find(r => !r.leaf.item)?.leaf || null; }
export function collageFilledLeaves(sheet = collageSheet()) { return cellRects(sheet).filter(r => r.leaf.item).map(r => r.leaf); }

export function collageSelectedCanvas() {
  return collage.view === 'sheet' && collage.sel ? collageCells.get(collage.sel)?.querySelector('canvas') || null : null;
}

export function collageUsageCounts() {
  const counts = new Map();
  for (const sheet of collage.sheets) for (const rect of cellRects(sheet)) {
    const file = rect.leaf.item?.file;
    if (file) counts.set(file, (counts.get(file) || 0) + 1);
  }
  return counts;
}

// Load the given sources into the photo pool and place each in the next empty cell (the first in `firstCell`).
export async function addCollage(sources, firstCell = null) {
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
