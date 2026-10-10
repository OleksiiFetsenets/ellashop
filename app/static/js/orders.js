'use strict';
// Persists the Prints order and the independent Canvas, Passport, and Collage workspaces: debounced saves,
// the order picker, and restoring saved state. It knows no page: every workspace is reached through the
// registry (workspaces.js) by its state(), restore() and clear().
// Loads after history.js; the page scripts call its save helpers (queueSave).
// Capture the edit before scheduling the matching order or workspace write.
// `tab` defaults to the visible tab.
function queueSave(tab = Workspaces.active().id) {
  recordHistory(tab);
  if (!Workspaces.get(tab).order) {
    const ws = workspaces[tab];
    if (ws.loading) return;
    ws.timer = debounceSave(tab, ws.timer, () => { ws.timer = 0; saveWorkspace(tab).catch(e => showWorkspaceError(tab, e)); });
    return;
  }
  if (loadingOrder || !currentOrder) return;
  saveTimer = debounceSave('prints', saveTimer, () => { saveTimer = 0; saveOrder().catch(showOrderError); });
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
  if (!currentOrder || loadingOrder) return saveChain;
  const id = currentOrder.id, name = orderInput.value, state = { prints: Workspaces.get('prints').state() };
  // Chained so writes run in order; one failed write must not block the next.
  saveChain = saveChain.catch(() => {}).then(async () => {
    const data = await orderRequest(`/api/orders/${id}/state`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, state }),
    });
    // Apply the server's reply only if the user has not switched order or renamed it meanwhile.
    if (currentOrder?.id === id && orderInput.value === name) { currentOrder = data; updateOrderPicker(); }
  });
  return saveChain;
}

// Finish pending order writes before switching to another order.
async function flushOrder() {
  clearTimeout(saveTimer); saveTimer = 0;
  await saveOrder();
}

function showOrderError(error) { Workspaces.get('prints').status(error.message, true); }
function showWorkspaceError(tab, error) { Workspaces.get(tab).status(error.message, true); }

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
function updateOrderPicker() {
  if (!currentOrder) return;
  let option = orderPicker.querySelector(`option[value="${currentOrder.id}"]`);
  if (!option) { option = document.createElement('option'); option.value = currentOrder.id; orderPicker.append(option); }
  const count = Workspaces.get('prints').count();
  option.textContent = t('order_picker_count', count, currentOrder.name || currentOrder.folder);
  orderPicker.value = currentOrder.id;
}

async function listOrders() {
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
function clearTab(tab) { Workspaces.get(tab).clear(); }

// Save the outgoing order, restore the selected one, and reset its history.
// `flush` is false when the previous order was just saved or deleted. A newer switch bumps orderEpoch,
// which makes this call stop after any await (and loadingOrder blocks saves until the order is loaded).
async function switchOrder(id, flush = true) {
  if (flush) await flushOrder();
  const epoch = ++orderEpoch, ws = Workspaces.get('prints');
  loadingOrder = true;
  currentOrder = null;
  ws.clear();
  const order = await orderRequest(`/api/orders/${id}`);
  if (epoch !== orderEpoch) return;
  currentOrder = order;
  orderInput.value = order.name;
  orderInput.placeholder = order.folder;
  await ws.restore(order.state?.prints || {}, { source: 'disk', imageFor: file => loadImage(orderUrl(id, file)) });
  loadingOrder = false;
  rememberOrder(id); updateOrderPicker();
  queueSave(ws.id);
  resetHistory(ws.id);
}

// Recreate a workspace from its separately persisted state.
async function restoreWorkspace(tab) {
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

orderInput.addEventListener('input', () => { if (currentOrder) { currentOrder.name = orderInput.value; currentOrder.folder = orderName(); queueSave(); updateOrderPicker(); } });
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
  if (!currentOrder || !confirm(t('order_delete_confirm', currentOrder.name || currentOrder.folder))) return;
  try {
    clearTimeout(saveTimer); await saveChain;
    await orderRequest(`/api/orders/${currentOrder.id}/delete`, { method: 'POST' });
    currentOrder = null;
    const orders = await listOrders();
    const next = orders[0] || await orderRequest('/api/orders', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    await switchOrder(next.id, false);
  } catch (e) { showOrderError(e); }
});
// On close/reload write the latest state synchronously-enough: sendBeacon, or a keepalive fetch if the beacon is refused.
window.addEventListener('pagehide', () => {
  if (currentOrder) {
    clearTimeout(saveTimer);
    const body = JSON.stringify({ name: orderInput.value, state: { prints: Workspaces.get('prints').state() } });
    if (!navigator.sendBeacon?.(`/api/orders/${currentOrder.id}/state`, new Blob([body], { type: 'application/json' })))
      fetch(`/api/orders/${currentOrder.id}/state`, { method: 'POST', body, keepalive: true });
  }
  for (const ws of Workspaces.standalone()) {
    clearTimeout(workspaces[ws.id].timer);
    const body = JSON.stringify(ws.state());
    if (!navigator.sendBeacon?.(`/api/workspace/${ws.id}`, new Blob([body], { type: 'application/json' })))
      fetch(`/api/workspace/${ws.id}`, { method: 'POST', body, keepalive: true });
  }
});
