'use strict';
// Undo / redo controls and the Passport measurement checkbox. Photo keys are handled by PhotoUI.keys.
// Loads after the tab scripts so their controls are available.

// Passport measurement checkbox (the other tabs wire theirs through PhotoUI.wireGuides).
for (const [id, preview, key] of [['#pp-measure', pp.preview, 'passport']]) {
  const box = $(id);
  try { box.checked = localStorage.getItem('ellashop-measure-' + key) === 'on'; } catch (_) { /* storage may be unavailable */ }
  preview.showMeasure = box.checked;
  box.addEventListener('change', () => {
    preview.showMeasure = box.checked; preview.draw();
    try { localStorage.setItem('ellashop-measure-' + key, box.checked ? 'on' : 'off'); } catch (_) { /* storage may be unavailable */ }
  });
}

$('#undo').addEventListener('click', () => undo());
$('#redo').addEventListener('click', () => redo());
// ⌘Z / Ctrl+Z undo, ⇧⌘Z / Ctrl+Shift+Z (or Ctrl+Y) redo. Inside text fields the browser's own text undo runs.
document.addEventListener('keydown', e => {
  const key = e.key.toLowerCase();
  if (!(e.metaKey || e.ctrlKey) || e.altKey || (key !== 'z' && key !== 'y')) return;
  if (e.target.closest?.('input, textarea, select, [contenteditable]')) return;
  e.preventDefault();
  if (key === 'y' || e.shiftKey) redo(); else undo();
}, true);

// Resolves when the server configuration has loaded; adding photos waits for it.
const configReady = refreshConfig();
