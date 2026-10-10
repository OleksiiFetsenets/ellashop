'use strict';
// What the app currently has open: the Prints order and the standalone workspaces' save state, the server URLs
// of stored photos, and the helpers that upload and serialise them. Page-agnostic; history.js, orders.js and
// the pages build on it. Loads after assets.js and before history.js.
// ---------------------------------------------------------------- app state

// Order state. orderEpoch (and workspaces[tab].epoch for the Canvas/Passport/Collage workspaces) is bumped
// whenever the open order or workspace is replaced; async work that started earlier compares the epoch it
// captured and drops its result if it changed. saveTimer/saveChain debounce and serialise saves;
// loading is true while a saved state is being restored (so restoring does not trigger a save).
const orderInput = $('#order-name');
const orderPicker = $('#order-picker');
let currentOrder = null, orderEpoch = 0, saveTimer = 0, saveChain = Promise.resolve(), loadingOrder = false;
const workspaces = {
  canvas: { epoch: 0, timer: 0, chain: Promise.resolve(), loading: false },
  passport: { epoch: 0, timer: 0, chain: Promise.resolve(), loading: false },
  collage: { epoch: 0, timer: 0, chain: Promise.resolve(), loading: false },
};
// Order ids start with YYYYMMDD and a time (HHMM at offsets 9-13); turned into "YYYY-MM-DD_HH-MM" for folder names.
const dateFolder = id => `${id.slice(0, 4)}-${id.slice(4, 6)}-${id.slice(6, 8)}_${id.slice(9, 11)}-${id.slice(11, 13)}`;
// Export folder name: the typed order name, else the date folder of the open order.
const orderName = () => orderInput.value || (currentOrder ? dateFolder(currentOrder.id) : '');
const orderUrl = (id, file) => `/orders/${encodeURIComponent(id)}/files/${encodeURIComponent(file)}`;
const workspaceUrl = (tab, file) => `/workspace/${tab}/files/${encodeURIComponent(file)}`;
const rememberOrder = id => { try { localStorage.setItem('ellashop-order-id', id); } catch (_) { /* storage may be unavailable */ } };
const lastOrder = () => { try { return localStorage.getItem('ellashop-order-id'); } catch (_) { return null; } };

// fetch + JSON; throws the server's error message on a non-2xx response.
async function orderRequest(url, options) {
  const response = await fetch(url, options);
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || t('order_request_failed', response.status));
  return data;
}

// Store a photo on the server and return a source with a stable URL. `owner` is an order id, or a
// workspace name (canvas/passport/collage), which stores outside any order.
async function uploadPhoto(blob, name, owner = currentOrder?.id) {
  if (!owner) throw new Error(t('order_storage_not_ready'));
  const workspace = owner === 'canvas' || owner === 'passport' || owner === 'collage';
  const url = workspace ? `/api/workspace/${owner}/files` : `/api/orders/${owner}/files`;
  const { file } = await orderRequest(`${url}?name=${encodeURIComponent(name)}`, { method: 'POST', body: blob });
  return { file, src: workspace ? workspaceUrl(owner, file) : orderUrl(owner, file), name };
}

// Make sure a picked photo is stored on the server (sources already carrying `file` are).
async function storedSource(source, owner) {
  if (source.file) return source;
  const blob = source.blob || await (await fetch(source.src)).blob();
  return uploadPhoto(blob, source.name, owner);
}

// JSON-able copy of an item for saving: drops runtime-only fields and keeps just the format id.
function itemState(item) {
  const { img, wrapCache, renderKey, faceError, ...settings } = item;
  return { ...settings, fmt: item.fmt?.id };
}
