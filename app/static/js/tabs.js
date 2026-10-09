'use strict';
// Handles incoming photos and navigation between the photo tabs.
// Loads before settings.js and the tab scripts that add and edit photos.

// Tilt is limited to +/-20 degrees.
const clampTilt = tilt => Math.min(20, Math.max(-20, tilt));
// Passport photos zoom 0.3–15 (close-up selfies shrink, distant faces grow); others 1–6.
const clampZoom = (item, z) => item.free ? Math.min(15, Math.max(.3, z)) : Math.min(6, Math.max(1, z));
// Text for the tilt readout next to the adjust controls.
const tiltLabel = item => t('common_tilt', item ? item.tilt.toFixed(1) : '0.0');

// Default edit state for a photo; `extra` overrides. Passport and measured custom formats start without an overlays list.
function newItem(img, name, extra) {
  const overlayDefault = (PASSPORT.includes(extra?.fmt) || (extra?.fmt?.custom && extra.fmt.measure)) ? {} : { overlays: [] };
  return { img, name, rot: 0, tilt: 0, zoom: 1, cx: 0.5, cy: 0.5, orient: 'auto', mode: 'fill', bg: '#ffffff', density: 0, ...overlayDefault, ...extra };
}

// Names of the files in photos/incoming, or null (after telling the user) when it is empty.
async function fetchIncoming() {
  const names = await (await fetch('/api/incoming')).json();
  if (!names.length) { alert(t('common_incoming_empty')); return null; }
  return names;
}

// Small picker dialog for photos/incoming; resolves with the chosen file names ([] if cancelled).
async function pickIncoming(multiple) {
  const names = await fetchIncoming(); if (!names) return [];
  return new Promise(resolve => {
    const dlg = document.createElement('dialog');
    dlg.style.cssText = 'border:none;border-radius:12px;padding:16px;max-width:720px;width:90vw';
    dlg.innerHTML = `<h3 style="margin-top:0">photos/incoming</h3>
      <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(110px,1fr));gap:8px;max-height:60vh;overflow:auto">
      ${names.map(n => `<label style="cursor:pointer;font-size:12px;text-align:center">
        <img src="/incoming/${encodeURIComponent(n)}" loading="lazy" style="width:100%;height:90px;object-fit:cover;border-radius:6px;display:block">
        <input type="${multiple ? 'checkbox' : 'radio'}" name="inc" value="${n.replace(/"/g, '&quot;')}"> ${n.replace(/</g, '&lt;')}</label>`).join('')}
      </div>
      <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:12px">
        <button value="cancel">${t('common_cancel')}</button><button value="ok" class="primary">${t('common_open')}</button></div>`;
    document.body.appendChild(dlg);
    dlg.addEventListener('click', e => {
      const b = e.target.closest('button'); if (!b) return;
      const picked = b.value === 'ok' ? [...dlg.querySelectorAll('input:checked')].map(i => i.value) : [];
      dlg.close(); dlg.remove(); resolve(picked);
    });
    dlg.showModal();
  });
}

// ---------------------------------------------------------------- tabs

// Switch tab: show its view and redraw every preview, since hidden canvases cannot be sized while display:none.
$$('.tab').forEach(t => t.addEventListener('click', () => {
  prints.preview.overlayEditor.select(null); canvasPrints.preview.overlayEditor.select(null);
  $$('.tab').forEach(x => x.classList.toggle('active', x === t));
  $$('.view').forEach(v => v.classList.toggle('active', v.id === t.dataset.tab));
  $$('.prints-order-control').forEach(x => { x.hidden = t.dataset.tab !== 'prints'; });
  prints.preview.draw(); canvasPrints.preview.draw(); pp.preview.draw(); pp.drawSheet();
  printsGrid.update(); canvasGrid.update();
  if (t.dataset.tab === 'collage') refreshCollage();
  updateUndoButtons();
}));
// Open the exports folder in the file manager: the current order's folder on Prints, the root elsewhere.
$('#open-folder').addEventListener('click', () => fetch('/api/open-folder?folder=' + encodeURIComponent(
  document.querySelector('.tab.active')?.dataset.tab === 'prints' ? orderName() : ''), { method: 'POST' }));
