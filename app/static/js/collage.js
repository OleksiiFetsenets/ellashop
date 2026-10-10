// Places different photos into the cells of printable sheets.
// Registers itself as a workspace (workspaces.js).
// Collage = the shared photo editor + packing. Everything done to ONE photo in a cell (fill mode, rotate,
// zoom, reset, tilt, pan, wheel zoom, painting the cell) comes from PhotoEditor / PhotoUI / PhotoRender;
// the packing is split in three: collage-model.js (state and sheet/cell helpers), collage-layout.js (the layout
// panel) and collage-view.js (the sheet view). This file keeps the page wiring: adding photos, saving,
// Move to Canvas, saved state and the workspace registration. Sheet maths is in PhotoSheet.
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
// "Move to Canvas" goes through the Canvas workspace's api.
// ---------------------------------------------------------------- collage

import { $, setStatus } from './dom.js';
import { PhotoUI } from './photo-ui.js';
import { PhotoSheet } from './photo-sheet.js';
import { CANVAS_DPI, CANVAS_FORMATS, COLLAGE_PAPERS, DPI, customFormatId, formatById } from './config.js';
import { queueSave, showWorkspaceError } from './orders.js';
import { t } from './i18n.js';
import { PhotoEditor } from './photo-editor.js';
import { PhotoRender } from './photo-render.js';
import { wireDrop, wireSeg } from './ui.js';
import { pickIncoming } from './ui.js';
import { itemState } from './app-state.js';
import { Workspaces } from './workspaces.js';
import {
  addCollage, cellRects, collage, collageChanged, collageDefaultSheet, collageFilledLeaves, collageHooks, collageSavedId,
  collageSelectedCanvas, collageSetCellFormats, collageSheet,
} from './collage-model.js';
import './collage-layout.js';
import { renderCollagePool, renderCollageSheetView, renderCollageTabs } from './collage-view.js';
import { syncCollageControls } from './collage-layout.js';

// main.js exposes these on window.ellashop (tests/ui/*.json use them).
export {
  cellRects, collage, collageCells, collageFilledLeaves, collageFirstEmpty, collageLeaf, collagePlace, collageSetCellFormats,
  collageSharedSegments, collageSheet, collageSheetMM, collageTreeDividers,
} from './collage-model.js';
export { collageSelect } from './collage-view.js';

{
  const view = $('#collage'), slot = name => view.querySelector(`[data-ui="${name}"]`);
  PhotoUI.mount(slot('drop'), PhotoUI.dropZone('collage'));
  PhotoUI.mount(slot('adjust'),
    PhotoUI.fillModeSeg('collage', { heading: 'page_selected_cell', labels: ['page_crop', 'page_fit_white', 'page_fit_blurred'] }),
    PhotoUI.adjustRow('collage', { heading: false }));
  PhotoUI.mount(slot('guides'), PhotoUI.guideChecks('collage', { measure: false, hiddenRow: true }));
  PhotoUI.mount(slot('save'), PhotoUI.saveActions('collage', { one: 'page_save_sheet', all: 'page_save_all_sheets', announce: true }));
}

export function refreshCollage() {
  if (!collage.sheets.length) collage.sheets.push(collageDefaultSheet());
  collage.active = Math.max(0, Math.min(collage.active, collage.sheets.length - 1));
  if (!collage.sel || !PhotoSheet.treeLeaves(collageSheet().root).includes(collage.sel)) collage.sel = PhotoSheet.treeLeaves(collageSheet().root)[0] || null;
  renderCollageTabs(); renderCollagePool(); syncCollageControls(); renderCollageSheetView();
}
collageHooks.refresh = refreshCollage;

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

wireDrop($('#collage-drop'), $('#collage-file'), files => addCollage(files.map(file => ({ blob: file, name: file.name }))));
$('[data-incoming="collage"]').addEventListener('click', async () => {
  const names = await pickIncoming(true);
  await addCollage(names.map(name => ({ src: '/incoming/' + encodeURIComponent(name), name })));
});

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

export function collageDpi(sheet) {
  const paper = PhotoSheet.sheetMM(sheet);
  return Math.max(paper.w, paper.h) > 300 ? CANVAS_DPI : DPI;
}

// Cut lines help trim a printed sheet; a canvas is one print, so Move to Canvas leaves them out.
// Also called from tests/ui/*.json.
export async function renderCollage(sheet, { cutLines = sheet.cutLines } = {}) {
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
  try {
    setStatus($('#collage-status'), t('collage_moving'));
    const name = `collage_${collage.active + 1}_${paper.w}x${paper.h}.jpg`;
    const added = await Workspaces.get('canvas').api.addRendered({
      name, fmt, orient: sheet.orient,
      render: () => {
        const canvas = PhotoRender.renderSheet(sheet, { dpi: collageDpi(sheet), cutLines: false, cellRects: cellRects(sheet) });
        return PhotoRender.jpegBlob(canvas, 1, collageDpi(sheet), sheet.density);
      },
    });
    if (added) setStatus($('#collage-status'), t('collage_moved_to_canvas'));
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

function clearCollage() {
  collage.photos = []; collage.sheets = [collageDefaultSheet()]; collage.active = 0; collage.sel = PhotoSheet.treeLeaves(collageSheet().root)[0]; collage.view = 'sheet';
  setStatus($('#collage-status'), ''); refreshCollage();
}

Workspaces.register({
  id: 'collage', tab: 'collage', order: false,
  state: collageState,
  restore: (state, { imageFor }) => collageRestore(state, imageFor),
  clear: clearCollage,
  refresh: refreshCollage,
  activate() { if ($('#collage').classList.contains('active')) refreshCollage(); },
  images: () => collage.photos.map(photo => [photo.file, photo.img]),
  count: () => collage.photos.length,
  status: (message, isError) => setStatus($('#collage-status'), message, isError),
  api: {},
});

// Keep the first sheet available before startup restores the saved workspace.
collage.sheets.push(collageDefaultSheet()); collage.sel = PhotoSheet.treeLeaves(collageSheet().root)[0];
refreshCollage();
