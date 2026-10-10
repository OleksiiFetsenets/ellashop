// Records per-workspace edit snapshots for undo and redo. It knows no page: every workspace is reached
// through the registry (workspaces.js) by its state(), images() and restore().
// orders.js schedules the changes.
// ---------------------------------------------------------------- undo / redo
// Per-tab history of settled states (the same JSON autosave writes). A step is recorded 350 ms after
// the last change, so a drag, a slider move or a burst of typing is one step. Undo/redo rebuild the
// tab from a step, reusing images already loaded (cached by file), so it is instant — and photos
// removed from the tab come back.
// Steps kept per tab; the oldest is dropped beyond this.

import { Workspaces } from './workspaces.js';
import { orderState, orderUrl, workspaceUrl, workspaces } from './app-state.js';
import { loadImage } from './assets.js';
import { queueSave } from './orders.js';
import { $ } from './dom.js';
const HISTORY_LIMIT = 60;
// past/future hold JSON snapshots, current the latest recorded one, timer the pending debounce;
// `restoring` (set during applySnapshot) pauses recording. One entry per workspace, created on first use.
const historyStore = {};
const historyOf = tab => (historyStore[tab] ??= { past: [], future: [], current: null, timer: 0 });
const historyImages = new Map();  // `${tab}|${file}` → loaded Image
// Which history applies to the visible tab.
const activeTabName = () => Workspaces.active().id;
// True while the tab is loading or restoring, when changes must not become history steps.
const tabBusy = tab => (Workspaces.get(tab).order ? orderState.loading || !orderState.current : workspaces[tab].loading) || historyOf(tab).restoring;

// Keep loaded images by file so undo can rebuild items (even removed ones) without refetching.
function rememberImages(tab) {
  for (const [file, img] of Workspaces.get(tab).images()) if (file && img) historyImages.set(`${tab}|${file}`, img);
}
function snapshot(tab) { rememberImages(tab); return JSON.stringify(Workspaces.get(tab).state()); }

// Delay the snapshot so a drag or typing burst becomes one undo step.
export function recordHistory(tab) {
  const h = historyOf(tab);
  if (tabBusy(tab)) return;
  clearTimeout(h.timer);
  h.timer = setTimeout(() => commitHistory(tab), 350);
}
// Store only changed snapshots and invalidate redo after a new edit.
function commitHistory(tab) {
  const h = historyOf(tab);
  clearTimeout(h.timer); h.timer = 0;
  if (tabBusy(tab)) return;
  const now = snapshot(tab);
  if (now === h.current) return;
  if (h.current !== null) { h.past.push(h.current); if (h.past.length > HISTORY_LIMIT) h.past.shift(); }
  h.future = []; h.current = now;
  updateUndoButtons();
}
// A freshly loaded/cleared tab starts a new history (called after order switch, workspace load, Clear all).
export function resetHistory(tab) {
  const h = historyOf(tab);
  clearTimeout(h.timer); h.timer = 0;
  h.past = []; h.future = []; h.current = snapshot(tab);
  updateUndoButtons();
}

// Cached image for a saved file, loading it from the order or workspace when not cached.
async function historyImage(tab, file) {
  const key = `${tab}|${file}`;
  if (!historyImages.has(key)) historyImages.set(key, await loadImage(Workspaces.get(tab).order ? orderUrl(orderState.current.id, file) : workspaceUrl(tab, file)));
  return historyImages.get(key);
}
// Rebuild a tab from saved state, reusing cached images when possible.
// Suppress history recording during restore, then autosave the restored view.
async function applySnapshot(tab, json) {
  const h = historyOf(tab);
  h.restoring = true;
  try {
    await Workspaces.get(tab).restore(JSON.parse(json), { source: 'undo', imageFor: file => historyImage(tab, file) });
  } finally {
    h.current = snapshot(tab);  // re-serialize from the rebuilt tab so the next change compares cleanly
    h.restoring = false;
    queueSave(tab);              // autosave the restored state
    clearTimeout(h.timer); h.timer = 0;
    updateUndoButtons();
  }
}
// Undo/redo move one step; the current state goes onto the opposite stack.
export async function undo(tab = activeTabName()) {
  const h = historyOf(tab);
  if (h.timer) commitHistory(tab);  // a change still settling becomes the step we undo
  if (!h.past.length || h.restoring) return;
  h.future.push(h.current);
  await applySnapshot(tab, h.past.pop());
}
export async function redo(tab = activeTabName()) {
  const h = historyOf(tab);
  if (!h.future.length || h.restoring) return;
  h.past.push(h.current);
  await applySnapshot(tab, h.future.pop());
}
export function updateUndoButtons() {
  const h = historyOf(activeTabName());
  $('#undo').disabled = !h.past.length && !h.timer;
  $('#redo').disabled = !h.future.length;
}
