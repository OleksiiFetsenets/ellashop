'use strict';
// Records per-tab edit snapshots for undo and redo.
// Loads after render.js and before orders.js, which schedules changes.
// ---------------------------------------------------------------- undo / redo
// Per-tab history of settled states (the same JSON autosave writes). A step is recorded 350 ms after
// the last change, so a drag, a slider move or a burst of typing is one step. Undo/redo rebuild the
// tab from a step, reusing images already loaded (cached by file), so it is instant — and photos
// removed from the tab come back.
const HISTORY_LIMIT = 60;
const historyStore = Object.fromEntries(['prints', 'canvas', 'passport', 'collage'].map(t => [t, { past: [], future: [], current: null, timer: 0 }]));
const historyImages = new Map();  // `${tab}|${file}` → loaded Image
const activeTabName = () => ({ 'canvas-view': 'canvas', passport: 'passport', collage: 'collage' })[document.querySelector('.tab.active')?.dataset.tab] || 'prints';
const tabBusy = tab => (tab === 'prints' ? loadingOrder || !currentOrder : workspaces[tab].loading) || historyStore[tab].restoring;

function rememberImages(tab) {
  const items = tab === 'passport' ? pp.jobs.map(j => [j.cutFile || j.file, j.item])
    : tab === 'collage' ? collage.photos.map(p => [p.file, p])
      : (tab === 'canvas' ? canvasPrints : prints).items.map(i => [i.file, i]);
  for (const [file, item] of items) if (file && item?.img) historyImages.set(`${tab}|${file}`, item.img);
}
function snapshot(tab) { rememberImages(tab); return JSON.stringify(tabState(tab)); }

// Delay the snapshot so a drag or typing burst becomes one undo step.
function recordHistory(tab) {
  const h = historyStore[tab];
  if (tabBusy(tab)) return;
  clearTimeout(h.timer);
  h.timer = setTimeout(() => commitHistory(tab), 350);
}
// Store only changed snapshots and invalidate redo after a new edit.
function commitHistory(tab) {
  const h = historyStore[tab];
  clearTimeout(h.timer); h.timer = 0;
  if (tabBusy(tab)) return;
  const now = snapshot(tab);
  if (now === h.current) return;
  if (h.current !== null) { h.past.push(h.current); if (h.past.length > HISTORY_LIMIT) h.past.shift(); }
  h.future = []; h.current = now;
  updateUndoButtons();
}
// A freshly loaded/cleared tab starts a new history (called after order switch, workspace load, Clear all).
function resetHistory(tab) {
  const h = historyStore[tab];
  clearTimeout(h.timer); h.timer = 0;
  h.past = []; h.future = []; h.current = snapshot(tab);
  updateUndoButtons();
}

async function historyImage(tab, file) {
  const key = `${tab}|${file}`;
  if (!historyImages.has(key)) historyImages.set(key, await loadImage(tab === 'prints' ? orderUrl(currentOrder.id, file) : workspaceUrl(tab, file)));
  return historyImages.get(key);
}
// Rebuild a tab from saved state, reusing cached images when possible.
// Suppress history recording during restore, then autosave the restored view.
async function applySnapshot(tab, json) {
  const h = historyStore[tab], state = JSON.parse(json);
  h.restoring = true;
  try {
    const build = async (saved, formats, file = saved.file) => newItem(await historyImage(tab, file), saved.name || file,
      { ...saved, fmt: formatById(formats, saved.fmt) });
    if (tab === 'passport') {
      const jobs = [];
      for (const saved of state.jobs || []) {
        jobs.push({ id: nextJobId++, file: saved.file, cutFile: saved.cutFile, name: saved.name, error: '',
          size: formatById(PASSPORT, saved.size), status: saved.status, face: saved.face,
          item: await build(saved.item || {}, PASSPORT, saved.cutFile || saved.file) });
      }
      pp.jobs = jobs; pp.active = jobs[state.active] || jobs[0] || null; pp.margin = state.margin ?? 5;
      ppSyncItem();
    } else if (tab === 'collage') {
      await restoreCollageSnapshot(state);
    } else {
      const target = tab === 'canvas' ? canvasPrints : prints, items = [];
      for (const saved of state.items || []) items.push(await build(saved, tab === 'canvas' ? CANVAS_FORMATS : FORMATS));
      target.items = items; target.sel = items[state.sel] || items[0] || null; target.view = state.view;
      tab === 'canvas' ? refreshCanvas() : refreshPrints();
      if (tab === 'prints' && prints.facesAvailable) {  // detections that were still running get re-queued
        prints.faceQueue.push(...items.filter(item => item.faces === null)); runFaceQueue();
      }
    }
  } finally {
    h.current = snapshot(tab);  // re-serialize from the rebuilt tab so the next change compares cleanly
    h.restoring = false;
    queueSave(tab);              // autosave the restored state
    clearTimeout(h.timer); h.timer = 0;
    updateUndoButtons();
  }
}
async function undo(tab = activeTabName()) {
  const h = historyStore[tab];
  if (h.timer) commitHistory(tab);  // a change still settling becomes the step we undo
  if (!h.past.length || h.restoring) return;
  h.future.push(h.current);
  await applySnapshot(tab, h.past.pop());
}
async function redo(tab = activeTabName()) {
  const h = historyStore[tab];
  if (!h.future.length || h.restoring) return;
  h.past.push(h.current);
  await applySnapshot(tab, h.future.pop());
}
function updateUndoButtons() {
  const h = historyStore[activeTabName()];
  $('#undo').disabled = !h.past.length && !h.timer;
  $('#redo').disabled = !h.future.length;
}
