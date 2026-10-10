// Manages Prints photos, face-aware crop placement, grids, and export.
// Registers itself as a workspace
// (workspaces.js): the base scripts reach it only through the registry.
// ---------------------------------------------------------------- prints

import { FORMATS, customSizeControl, fmtLabel, formatById } from './config.js';
import { $, $$, setStatus } from './dom.js';
import { PhotoUI } from './photo-ui.js';
import { AppConfig } from './app-config.js';
import { PhotoEditor } from './photo-editor.js';
import { itemState, orderName, orderState, storedSource } from './app-state.js';
import { queueSave, updateOrderPicker } from './orders.js';
import { PhotoRender } from './photo-render.js';
import { baseName, densityControl, densityLabel, loadImage } from './assets.js';
import { t } from './i18n.js';
import { wireDrop, wireSeg } from './ui.js';
import { pickIncoming } from './tabs.js';
import { Workspaces } from './workspaces.js';

export const prints = {
  items: [],
  sel: null,
  lastFmt: FORMATS[0],
  // faceQueue holds photos waiting for face detection; at most 2 run at once (faceRunning).
  faceQueue: [], faceRunning: 0,
  get item() { return this.items.find(i => i === this.sel) || null; },
};

// Shared controls (drop zone, stage, orientation/fill/blur, guides, adjust row, save) come from PhotoUI;
// editing from PhotoEditor; drawing and saving from PhotoRender.
{
  const view = $('#prints'), slot = name => view.querySelector(`[data-ui="${name}"]`);
  PhotoUI.mount(slot('drop'), PhotoUI.dropZone('prints'));
  PhotoUI.mount(slot('stage'), PhotoUI.stage('prints', 'page_add_photos_to_start_drag_the_photo_to_move_it_scroll_to_zoom'));
  PhotoUI.mount(slot('orient-fill'), PhotoUI.orientSeg('prints'), PhotoUI.fillModeSeg('prints'), PhotoUI.blurControls('prints'));
  PhotoUI.mount(slot('guides'), PhotoUI.guideChecks('prints'));
  PhotoUI.mount(slot('adjust'), PhotoUI.adjustRow('prints'));
  PhotoUI.mount(slot('save'), PhotoUI.saveActions('prints', { one: 'page_save_this_photo' }));
}

// Face detection is offered when the server has it installed (AppConfig, app-config.js).
const facesAvailable = () => !!AppConfig.data.faces;

// Smart placement: picks mode, zoom and centre from the detected faces and sets item.auto to the reason.
const autoPlace = item => PhotoEditor.smartPlace(item);

// Stage overlay: face boxes are drawn only when the "faces" checkbox is on.
function faceOverlay(ctx, item) {
  if ($('#prints-faces').checked) PhotoEditor.drawFaces(ctx, item);
}

// Detect faces one photo at a time, then update smart placement.
function runFaceQueue() {
  while (prints.faceRunning < 2 && prints.faceQueue.length) {
    // epoch: if the order changed while detecting, the result belongs to a stale list and is dropped.
    const item = prints.faceQueue.shift(), epoch = orderState.epoch;
    if (!prints.items.includes(item)) continue;
    prints.faceRunning++;
    (async () => {
      try {
        const faces = await PhotoEditor.detectFaces(item);
        if (epoch !== orderState.epoch || !prints.items.includes(item)) return;
        item.faces = faces;
        if (item.smartPending) autoPlace(item);
      } catch (e) {
        if (epoch !== orderState.epoch || !prints.items.includes(item)) return;
        item.faces = []; item.faceError = e.message;
        if (item.smartPending) autoPlace(item);
      } finally {
        item.smartPending = false; prints.faceRunning--;
        if (epoch === orderState.epoch && prints.items.includes(item)) refreshPrints();
        runFaceQueue();
      }
    })();
  }
}

prints.preview = new PhotoEditor.Stage($('#prints-canvas'), $('#prints-stage'), {
  getItem: () => prints.item,
  // Any manual move/zoom ends automatic placement for this photo.
  onChange: () => { if (prints.item) { prints.item.auto = ''; prints.item.smartPending = false; } syncPrintControls(); queueSave('prints'); },
  overlay: faceOverlay,
  render: PhotoRender.renderItem,
});
PhotoEditor.attachOverlays($('#prints-overlays'), prints, refreshPrints, prints.preview);
PhotoUI.wireGuides('prints', prints.preview);

$('#formats').innerHTML = FORMATS.map(f => `<button data-id="${f.id}">${fmtLabel(f)}</button>`).join('');

const syncPrintCustom = customSizeControl('#formats', FORMATS, [2, 100, 2, 100], () => prints.item?.fmt, setPrintFormat, '#prints-status');

const syncPrintsDensity = densityControl($('#prints-density'), { item: () => prints.item, items: () => prints.items, refresh: () => refreshPrints() });
function syncPrintControls() {
  const it = prints.item;
  prints.preview.overlayEditor.sync();
  syncPrintsDensity();
  $$('#formats button[data-id]').forEach(b => b.classList.toggle('on', !!it && b.dataset.id === it.fmt.id));
  syncPrintCustom(it?.fmt);
  PhotoUI.syncAdjust('prints', it);
  $('#prints-hint').textContent = it
    ? t('prints_hint_selected', it.name, fmtLabel(it.fmt))
    : t('prints_hint_empty');
}

// Queue caption: format, mode, face count and the reason for automatic placement.
function printLabel(it) {
  return t('prints_label', fmtLabel(it.fmt), t(it.mode === 'blur' ? 'prints_blur' : it.mode === 'fit' ? 'prints_fit' : 'prints_crop')) + (it.faces === null ? t('prints_faces_pending') : it.faces ? t('prints_faces_count', it.faces.length) : '') + (it.auto ? t('prints_auto_detail', ({ 'blur: faces don\'t fit': t('prints_auto_blur'), faces: t('prints_auto_faces'), centre: t('prints_auto_centre') })[it.auto] || it.auto) : '') + densityLabel(it);
}

const printsGrid = PhotoUI.photoGrid(prints, $('#prints-stage'), $('#prints-grid'), $('#prints-view-bar'),
  $('#prints-hint'), printLabel, PhotoEditor.outMM, PhotoRender.renderItem, refreshPrints, 'prints');

PhotoUI.keys.register('prints', {
  active: () => $('#prints').classList.contains('active'),
  item: () => prints.item, stage: prints.preview, grid: printsGrid, changed: refreshPrints,
});

function refreshPrints() {
  PhotoUI.renderQueue(prints, $('#prints-queue'), refreshPrints, printLabel);
  syncPrintControls(); prints.preview.draw(); printsGrid.update();
  queueSave('prints'); updateOrderPicker();
}

async function addPrints(sources) {
  await AppConfig.ready;
  const id = orderState.current?.id, epoch = orderState.epoch;
  for (const source of sources) {
    try {
      const { src, name, file } = await storedSource(source, id);
      const img = await loadImage(src);
      if (epoch !== orderState.epoch) return;
      // faces: null = detection pending, undefined = detection unavailable. smartPending: auto-place once faces are known.
      const it = PhotoEditor.newItem(img, name, { fmt: prints.lastFmt, blur: 'motion', strength: 50,
        file, faces: facesAvailable() ? null : undefined, smartPending: $('#prints-smart').checked, auto: '' });
      prints.items.push(it);
      if (!prints.sel) prints.sel = it;
      if (facesAvailable()) { prints.faceQueue.push(it); runFaceQueue(); }
      else if (it.smartPending) { autoPlace(it); it.smartPending = false; }
    } catch (e) { setStatus($('#prints-status'), t('prints_source_error', source.name, e.message), true); }
  }
  refreshPrints();
}

wireDrop($('#prints-drop'), $('#prints-file'), files =>
  addPrints(files.map(f => ({ blob: f, name: f.name }))));

$('[data-incoming=prints]').addEventListener('click', async () => {
  const names = await pickIncoming(true);
  addPrints(names.map(n => ({ src: '/incoming/' + encodeURIComponent(n), name: n })));
});

function setPrintFormat(fmt) {
  const it = prints.item; if (!it) return;
  it.fmt = prints.lastFmt = fmt;
  if (it.auto) autoPlace(it);
  refreshPrints();
}
$('#formats').addEventListener('click', e => {
  const b = e.target.closest('button[data-id]'); if (b) setPrintFormat(formatById(FORMATS, b.dataset.id));
});
wireSeg($('#prints-orient'), v => { const it = prints.item; if (it) { it.orient = v; if (it.auto) autoPlace(it); refreshPrints(); } });
wireSeg($('#prints-mode'), v => { const it = prints.item; if (it) { PhotoEditor.setMode(it, v); refreshPrints(); } });
wireSeg($('#prints-blur'), v => { const it = prints.item; if (it) { it.blur = v; refreshPrints(); } });
$('#prints-strength').addEventListener('input', e => { const it = prints.item; if (it) { it.strength = +e.target.value; prints.preview.draw(); queueSave(); } });
$('#prints-faces').addEventListener('change', () => prints.preview.draw());
$('#prints-auto').addEventListener('click', () => { const it = prints.item; if (it) { autoPlace(it); refreshPrints(); } });
PhotoUI.wireAdjust('prints', { item: () => prints.item, changed: refreshPrints, redraw: () => { prints.preview.draw(); queueSave(); } });
$('#apply-all').addEventListener('click', () => {
  const it = prints.item; if (!it) return;
  // Photos still on automatic placement are re-placed for the new format; the rest only take over the mode.
  prints.items.forEach(x => { x.fmt = it.fmt; if (x.auto) autoPlace(x); else x.mode = it.mode; });
  refreshPrints();
});

function savePrint(it) {
  const mm = PhotoEditor.outMM(it);
  return PhotoRender.exportItem(it, { name: `${baseName(it.name)}_${mm.w / 10}x${mm.h / 10}.jpg`, folder: orderName() });
}

PhotoUI.wireSave('prints', {
  item: () => prints.item, items: () => prints.items, save: savePrint, folder: orderName,
  msg: { saving: 'prints_saving', savedFile: 'prints_saved_file', savingCount: 'prints_saving_count', savedAll: 'prints_saved_photos' },
});

// Rebuild the photos from saved state. A saved photo that fails to load is reported and skipped when opening
// a saved order ('disk'); an undo step ('undo') throws instead.
async function restorePrints(state, { imageFor, source }) {
  const items = [];
  for (const saved of state.items || []) {
    if (!saved.file) continue;
    try {
      items.push(PhotoEditor.newItem(await imageFor(saved.file), saved.name || saved.file, { ...saved, fmt: formatById(FORMATS, saved.fmt) }));
    } catch (e) {
      if (source !== 'disk') throw e;
      setStatus($('#prints-status'), `${saved.name}: ${e.message}`, true);
    }
  }
  prints.items = items; prints.sel = items[state.sel] || items[0] || null; prints.view = state.view;
  refreshPrints();
  if (facesAvailable()) {  // detections that were still running get re-queued
    prints.faceQueue.push(...items.filter(item => item.faces === null)); runFaceQueue();
  }
}

Workspaces.register({
  id: 'prints', tab: 'prints', order: true,
  state: () => ({ items: prints.items.map(itemState), sel: prints.items.indexOf(prints.sel), view: prints.view || null }),
  restore: restorePrints,
  clear() {
    prints.items = []; prints.sel = null; prints.view = null; prints.faceQueue = [];
    setStatus($('#prints-status'), '');
    $('#prints-grid').replaceChildren();
    refreshPrints();
  },
  refresh: refreshPrints,
  leave() { prints.preview.overlayEditor.select(null); },
  activate() { prints.preview.draw(); printsGrid.update(); },
  redraw() { prints.preview.redraw(); printsGrid.update(); },
  images: () => prints.items.map(item => [item.file, item.img]),
  count: () => prints.items.length,
  status: (message, isError) => setStatus($('#prints-status'), message, isError),
  api: {},
});
syncPrintControls();
