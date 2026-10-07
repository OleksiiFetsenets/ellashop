'use strict';
// Persists Prints orders and the independent Canvas, Passport, and Collage workspaces.
// Loads after history.js; later tab scripts call its save and restore helpers.
// Capture the edit before scheduling the matching order or workspace write.
function queueSave(tab = ({ 'canvas-view': 'canvas', passport: 'passport', collage: 'collage' })[document.querySelector('.tab.active')?.dataset.tab] || 'prints') {
  recordHistory(tab);
  if (tab !== 'prints') {
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
const saveDeadlines = new Map();
// Delay writes while edits continue, with a deadline for sustained activity.
function debounceSave(key, timer, save) {
  clearTimeout(timer);
  const deadline = timer && saveDeadlines.get(key) || Date.now() + 2000;
  saveDeadlines.set(key, deadline);
  return setTimeout(() => { saveDeadlines.delete(key); save(); }, Math.max(0, Math.min(600, deadline - Date.now())));
}

// Serialize writes so a slow request cannot overwrite a newer order state.
function saveOrder() {
  if (!currentOrder || loadingOrder) return saveChain;
  const id = currentOrder.id, name = orderInput.value, state = { prints: tabState('prints') };
  saveChain = saveChain.catch(() => {}).then(async () => {
    const data = await orderRequest(`/api/orders/${id}/state`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, state }),
    });
    if (currentOrder?.id === id && orderInput.value === name) { currentOrder = data; updateOrderPicker(); }
  });
  return saveChain;
}

// Finish pending order writes before switching to another order.
async function flushOrder() {
  clearTimeout(saveTimer); saveTimer = 0;
  await saveOrder();
}

function showOrderError(error) { setStatus($('#prints-status'), error.message, true); }
function showWorkspaceError(tab, error) {
  setStatus($(tab === 'canvas' ? '#canvas-status' : tab === 'collage' ? '#collage-status' : '#pp-status'), error.message, true);
}

// Persist Canvas, Passport, and Collage independently of the selected Prints order.
function saveWorkspace(tab) {
  const ws = workspaces[tab];
  if (ws.loading) return ws.chain;
  const state = tabState(tab), epoch = ws.epoch;
  ws.chain = ws.chain.catch(() => {}).then(async () => {
    if (epoch !== ws.epoch) return;
    await orderRequest(`/api/workspace/${tab}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(state),
    });
  });
  return ws.chain;
}

function updateOrderPicker() {
  if (!currentOrder) return;
  let option = orderPicker.querySelector(`option[value="${currentOrder.id}"]`);
  if (!option) { option = document.createElement('option'); option.value = currentOrder.id; orderPicker.append(option); }
  const count = prints.items.length;
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

function clearPrints() {
  prints.items = []; prints.sel = null; prints.view = null; prints.faceQueue = [];
  setStatus($('#prints-status'), '');
  $('#prints-grid').replaceChildren();
  refreshPrints();
}

function clearTab(tab) {
  if (tab === 'canvas') {
    canvasPrints.items = []; canvasPrints.sel = null; canvasPrints.view = null;
    setStatus($('#canvas-status'), ''); $('#canvas-grid').replaceChildren(); refreshCanvas();
    return;
  }
  if (tab === 'collage') { clearCollage(); return; }
  pp.jobs = []; pp.active = null; pp.queue = [];
  clearTimeout(sheetTimer);
  setStatus($('#pp-status'), ''); $('#pp-tabs').replaceChildren(); ppSyncItem();
}

// Rehydrate saved photo metadata with its stored image and format.
async function restoreItem(saved, owner, formats, file = saved.file) {
  if (!file) return null;
  const img = await loadImage(owner === 'canvas' || owner === 'passport' || owner === 'collage' ? workspaceUrl(owner, file) : orderUrl(owner, file));
  const fmt = formatById(formats, saved.fmt);
  return newItem(img, saved.name || file, { ...saved, file: saved.file, fmt });
}

// Save the outgoing order, restore the selected one, and reset its history.
async function switchOrder(id, flush = true) {
  if (flush) await flushOrder();
  const epoch = ++orderEpoch;
  loadingOrder = true;
  currentOrder = null;
  clearPrints();
  const order = await orderRequest(`/api/orders/${id}`);
  if (epoch !== orderEpoch) return;
  currentOrder = order;
  orderInput.value = order.name;
  orderInput.placeholder = order.folder;
  const state = order.state || {};
  for (const saved of state.prints?.items || []) {
    try { const item = await restoreItem(saved, id, FORMATS); if (item) prints.items.push(item); }
    catch (e) { setStatus($('#prints-status'), `${saved.name}: ${e.message}`, true); }
  }
  prints.sel = prints.items[state.prints?.sel] || prints.items[0] || null;
  prints.view = state.prints?.view;
  loadingOrder = false;
  rememberOrder(id); updateOrderPicker();
  refreshPrints();
  resetHistory('prints');
  if (prints.facesAvailable) {
    prints.faceQueue.push(...prints.items.filter(item => item.faces === null));
    runFaceQueue();
  }
}

// Recreate a workspace from its separately persisted state.
async function restoreWorkspace(tab) {
  const ws = workspaces[tab], epoch = ++ws.epoch;
  ws.loading = true;
  try {
    clearTab(tab);
    const state = await orderRequest(`/api/workspace/${tab}`);
    if (epoch !== ws.epoch) return;
    if (tab === 'canvas') {
      for (const saved of state.items || []) {
        try { const item = await restoreItem(saved, tab, CANVAS_FORMATS); if (item) canvasPrints.items.push(item); }
        catch (e) { showWorkspaceError(tab, new Error(`${saved.name}: ${e.message}`)); }
      }
      canvasPrints.sel = canvasPrints.items[state.sel] || canvasPrints.items[0] || null;
      canvasPrints.view = state.view;
      refreshCanvas();
    } else if (tab === 'passport') {
      for (const saved of state.jobs || []) {
        try {
          const size = formatById(PASSPORT, saved.size);
          const item = await restoreItem(saved.item || {}, tab, PASSPORT, saved.cutFile || saved.file);
          if (item) pp.jobs.push({ id: nextJobId++, file: saved.file, cutFile: saved.cutFile,
            name: saved.name, size,
            right: saved.right ?? passportOffsets(size).right, down: saved.down ?? passportOffsets(size).down,
            status: saved.status === 'done' ? 'done' : 'new', face: saved.face,
            item, error: '' });
        } catch (e) { showWorkspaceError(tab, new Error(`${saved.name}: ${e.message}`)); }
      }
      pp.active = pp.jobs[state.active] || pp.jobs[0] || null;
      ppSyncItem();
      if (pp.config.faces) pp.jobs.filter(job => job.face === null).forEach(ppDetectFace);
    } else {
      await restoreCollageWorkspace(state);
    }
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
window.addEventListener('pagehide', () => {
  if (currentOrder) {
    clearTimeout(saveTimer);
    const body = JSON.stringify({ name: orderInput.value, state: { prints: tabState('prints') } });
    if (!navigator.sendBeacon?.(`/api/orders/${currentOrder.id}/state`, new Blob([body], { type: 'application/json' })))
      fetch(`/api/orders/${currentOrder.id}/state`, { method: 'POST', body, keepalive: true });
  }
  for (const tab of ['canvas', 'passport', 'collage']) {
    clearTimeout(workspaces[tab].timer);
    const body = JSON.stringify(tabState(tab));
    if (!navigator.sendBeacon?.(`/api/workspace/${tab}`, new Blob([body], { type: 'application/json' })))
      fetch(`/api/workspace/${tab}`, { method: 'POST', body, keepalive: true });
  }
});
