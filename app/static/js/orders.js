// Persists the Prints order and the independent Canvas, Passport, and Collage workspaces: debounced saves,
// the order picker, and restoring saved state. It knows no page: every workspace is reached through the
// registry (workspaces.js) by its state(), restore() and clear().
// The page modules call its save helpers (queueSave).
// Capture the edit before scheduling the matching order or workspace write.
// `tab` defaults to the visible tab.

import { Workspaces } from './workspaces.js';
import { recordHistory, resetHistory } from './history.js';
import { orderInput, orderName, orderPicker, orderRequest, orderState, orderUrl, rememberOrder, workspaceUrl, workspaces } from './app-state.js';
import { t } from './i18n.js';
import { loadImage } from './assets.js';
import { $ } from './dom.js';
export function queueSave(tab = Workspaces.active().id) {
  recordHistory(tab);
  if (!Workspaces.get(tab).order) {
    const ws = workspaces[tab];
    if (ws.loading) return;
    ws.timer = debounceSave(tab, ws.timer, () => { ws.timer = 0; saveWorkspace(tab).catch(e => showWorkspaceError(tab, e)); });
    return;
  }
  if (orderState.loading || !orderState.current) return;
  orderState.timer = debounceSave('prints', orderState.timer, () => { orderState.timer = 0; saveOrder().catch(showOrderError); });
}

// Save 600 ms after the last change, but never later than 2 s after the first unsaved one: views that
// redraw continuously (e.g. while the background is being removed) must not postpone saving forever.
// key -> time by which the pending save must run, set when the first unsaved change arrives.
const saveDeadlines = new Map();
// Delay writes while edits continue, with a deadline for sustained activity.
function debounceSave(key, timer, save) {
  clearTimeout(timer);
  // A timer still pending means a save is already waiting: keep its deadline, else start a new 2 s window.
  const deadline = timer && saveDeadlines.get(key) || Date.now() + 2000;
  saveDeadlines.set(key, deadline);
  return setTimeout(() => { saveDeadlines.delete(key); save(); }, Math.max(0, Math.min(600, deadline - Date.now())));
}

// Serialize writes so a slow request cannot overwrite a newer order state.
function saveOrder() {
  if (!orderState.current || orderState.loading) return orderState.chain;
  const id = orderState.current.id, name = orderInput.value, state = { prints: Workspaces.get('prints').state() };
  // Chained so writes run in order; one failed write must not block the next.
  orderState.chain = orderState.chain.catch(() => {}).then(async () => {
    const data = await orderRequest(`/api/orders/${id}/state`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, state }),
    });
    // Apply the server's reply only if the user has not switched order or renamed it meanwhile.
    if (orderState.current?.id === id && orderInput.value === name) { orderState.current = data; updateOrderPicker(); }
  });
  return orderState.chain;
}

// Finish pending order writes before switching to another order.
export async function flushOrder() {
  clearTimeout(orderState.timer); orderState.timer = 0;
  await saveOrder();
}

export function showOrderError(error) { Workspaces.get('prints').status(error.message, true); }
export function showWorkspaceError(tab, error) { Workspaces.get(tab).status(error.message, true); }

// Persist Canvas, Passport, and Collage independently of the selected Prints order.
function saveWorkspace(tab) {
  const ws = workspaces[tab];
  if (ws.loading) return ws.chain;
  const state = Workspaces.get(tab).state(), epoch = ws.epoch;
  ws.chain = ws.chain.catch(() => {}).then(async () => {
    // The workspace was cleared or reloaded after this save was queued: its state is stale, skip it.
    if (epoch !== ws.epoch) return;
    await orderRequest(`/api/workspace/${tab}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(state),
    });
  });
  return ws.chain;
}

// Keep the dropdown entry of the open order in step with its name and photo count.
export function updateOrderPicker() {
  if (!orderState.current) return;
  let option = orderPicker.querySelector(`option[value="${orderState.current.id}"]`);
  if (!option) { option = document.createElement('option'); option.value = orderState.current.id; orderPicker.append(option); }
  const count = Workspaces.get('prints').count();
  option.textContent = t('order_picker_count', count, orderState.current.name || orderState.current.folder);
  orderPicker.value = orderState.current.id;
}

export async function listOrders() {
  const orders = await orderRequest('/api/orders');
  orderPicker.replaceChildren();
  for (const order of orders) {
    const option = document.createElement('option'); option.value = order.id;
    const n = order.counts.prints;
    option.textContent = t('order_picker_count', n, order.name || order.folder);
    orderPicker.append(option);
  }
  return orders;
}

// Empty a Canvas/Passport/Collage tab in the UI only.
export function clearTab(tab) { Workspaces.get(tab).clear(); }

// Save the outgoing order, restore the selected one, and reset its history.
// `flush` is false when the previous order was just saved or deleted. A newer switch bumps orderState.epoch,
// which makes this call stop after any await (and orderState.loading blocks saves until the order is loaded).
export async function switchOrder(id, flush = true) {
  if (flush) await flushOrder();
  const epoch = ++orderState.epoch, ws = Workspaces.get('prints');
  orderState.loading = true;
  orderState.current = null;
  ws.clear();
  const order = await orderRequest(`/api/orders/${id}`);
  if (epoch !== orderState.epoch) return;
  orderState.current = order;
  orderInput.value = order.name;
  orderInput.placeholder = order.folder;
  await ws.restore(order.state?.prints || {}, { source: 'disk', imageFor: file => loadImage(orderUrl(id, file)) });
  orderState.loading = false;
  rememberOrder(id); updateOrderPicker();
  queueSave(ws.id);
  resetHistory(ws.id);
}

// Recreate a workspace from its separately persisted state.
export async function restoreWorkspace(tab) {
  // ws.epoch is bumped per restore (and per clear) so a slower, older restore cannot overwrite a newer one;
  // ws.loading blocks saves until the restore finishes.
  const ws = workspaces[tab], epoch = ++ws.epoch;
  ws.loading = true;
  try {
    clearTab(tab);
    const state = await orderRequest(`/api/workspace/${tab}`);
    if (epoch !== ws.epoch) return;
    await Workspaces.get(tab).restore(state, { source: 'disk', imageFor: file => loadImage(workspaceUrl(tab, file)) });
  } finally { if (epoch === ws.epoch) { ws.loading = false; resetHistory(tab); } }
}

orderInput.addEventListener('input', () => { if (orderState.current) { orderState.current.name = orderInput.value; orderState.current.folder = orderName(); queueSave(); updateOrderPicker(); } });
orderPicker.addEventListener('change', async () => {
  const id = orderPicker.value;
  try { await switchOrder(id); } catch (e) { showOrderError(e); }
});
$('#new-order').addEventListener('click', async () => {
  try {
    await flushOrder();
    const order = await orderRequest('/api/orders', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    await listOrders(); await switchOrder(order.id, false);
  } catch (e) { showOrderError(e); }
});
$('#delete-order').addEventListener('click', async () => {
  if (!orderState.current || !confirm(t('order_delete_confirm', orderState.current.name || orderState.current.folder))) return;
  try {
    clearTimeout(orderState.timer); await orderState.chain;
    await orderRequest(`/api/orders/${orderState.current.id}/delete`, { method: 'POST' });
    orderState.current = null;
    const orders = await listOrders();
    const next = orders[0] || await orderRequest('/api/orders', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    await switchOrder(next.id, false);
  } catch (e) { showOrderError(e); }
});
// On close/reload write the latest state synchronously-enough: sendBeacon, or a keepalive fetch if the beacon is refused.
window.addEventListener('pagehide', () => {
  if (orderState.current) {
    clearTimeout(orderState.timer);
    const body = JSON.stringify({ name: orderInput.value, state: { prints: Workspaces.get('prints').state() } });
    if (!navigator.sendBeacon?.(`/api/orders/${orderState.current.id}/state`, new Blob([body], { type: 'application/json' })))
      fetch(`/api/orders/${orderState.current.id}/state`, { method: 'POST', body, keepalive: true });
  }
  for (const ws of Workspaces.standalone()) {
    clearTimeout(workspaces[ws.id].timer);
    const body = JSON.stringify(ws.state());
    if (!navigator.sendBeacon?.(`/api/workspace/${ws.id}`, new Blob([body], { type: 'application/json' })))
      fetch(`/api/workspace/${ws.id}`, { method: 'POST', body, keepalive: true });
  }
});
