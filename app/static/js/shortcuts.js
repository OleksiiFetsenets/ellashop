'use strict';
// Routes keyboard editing and tab shortcuts to the active photo view.
// Loads after the tab scripts so their controls are available.
// Overlay shortcuts take precedence in Single view; the photo shortcuts below stay intact otherwise.
document.addEventListener('keydown', e => {
  if (e.metaKey || e.ctrlKey || e.target.closest?.('input, textarea, select, [contenteditable]')) return;
  const isCanvas = $('#canvas-view').classList.contains('active');
  const isPrints = $('#prints').classList.contains('active');
  if (!isCanvas && !isPrints) return;
  const state = isCanvas ? canvasPrints : prints, grid = isCanvas ? canvasGrid : printsGrid;
  if (grid.cardCanvas(state.item)) return;
  const editor = state.preview.overlayEditor, o = editor.selected(); if (!o) return;
  const dir = ARROWS[e.key];
  if (dir) {
    const mm = outMM(state.item), step = e.altKey ? .2 : 1;
    o.x = Math.max(0, Math.min(1, o.x + dir[0] * step / mm.w));
    o.y = Math.max(0, Math.min(1, o.y + dir[1] * step / mm.h));
  } else if (['+', '=', '-', '_'].includes(e.key)) o.size = Math.max(3, Math.min(80, o.size * (e.key === '+' || e.key === '=' ? 1.1 : .9)));
  else if (e.key === 'Delete' || e.key === 'Backspace') { state.item.overlays = state.item.overlays.filter(x => x !== o); editor.select(null); }
  else if (e.key === 'Escape') editor.select(null);
  else return;
  e.preventDefault(); e.stopImmediatePropagation();
  if (e.key !== 'Escape') editor.changed();
}, true);

// + / − zoom the selected photo by 10% (Alt: 2%), in grid and single view, on every tab.
document.addEventListener('keydown', e => {
  const dir = { '+': 1, '=': 1, '-': -1, '_': -1 }[e.key];
  if (!dir || e.metaKey || e.ctrlKey ||
      e.target.matches?.('textarea, input:not([type=range]):not([type=checkbox])')) return;
  const passport = $('#passport').classList.contains('active');
  const canvas = $('#canvas-view').classList.contains('active');
  const isCollage = $('#collage').classList.contains('active');
  const item = isCollage ? collage.sel?.item : passport ? pp.active?.item : canvas ? canvasPrints.item : prints.item;
  if (!item || item.mode === 'fit' || item.mode === 'blur') return;
  e.preventDefault();
  item.zoom = clampZoom(item, item.zoom * (e.altKey ? 1.02 : 1.1) ** dir);
  item.auto = ''; item.smartPending = false;
  if (isCollage) { refreshCollage(); queueSave('collage'); }
  else if (passport) ppSyncItem(); else if (canvas) refreshCanvas(); else refreshPrints();
});

// Arrows move the photo (0.5 mm, Alt: 0.1 mm); Shift+←/→ tilt it (0.5°, Alt: 0.1°).
const ARROWS = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
document.addEventListener('keydown', e => {
  if ($('#collage').classList.contains('active') && e.key === 'Escape') {
    if (collage.view === 'single') { collage.view = 'sheet'; refreshCollage(); queueSave('collage'); e.preventDefault(); }
    return;
  }
  if (e.metaKey || e.ctrlKey || e.altKey || e.target.matches?.('input[type=text], input[type=number], textarea, [contenteditable]')) return;
  const grid = $('#prints').classList.contains('active') ? printsGrid
    : $('#canvas-view').classList.contains('active') ? canvasGrid : null;
  if (!grid) return;
  if (e.key === 'Escape') grid.choose('grid');
  else if (e.key === ']' || e.key === 'PageDown') grid.step(1);
  else if (e.key === '[' || e.key === 'PageUp') grid.step(-1);
  else return;
  e.preventDefault();
});
document.addEventListener('keydown', e => {
  const dir = ARROWS[e.key];
  if (!dir || e.metaKey || e.ctrlKey ||
      e.target.matches?.('textarea, input:not([type=range]):not([type=checkbox])')) return;
  const passport = $('#passport').classList.contains('active');
  const canvas = $('#canvas-view').classList.contains('active');
  const isCollage = $('#collage').classList.contains('active');
  const item = isCollage ? collage.sel?.item : passport ? pp.active?.item : canvas ? canvasPrints.item : prints.item;
  const preview = isCollage ? collage.preview : passport ? pp.preview : canvas ? canvasPrints.preview : prints.preview;
  if (!item) return;
  const step = e.altKey ? .1 : .5;
  if (isCollage) {
    if (e.shiftKey) {
      if (!dir[0]) return;
      item.tilt = clampTilt(item.tilt + dir[0] * step);
    } else {
      const target = collageSelectedCanvas() || preview.canvas;
      const cssPerMM = target.getBoundingClientRect().width / preview.sizeMM(item).w;
      panOnCanvas(item, target, preview.frontRect, dir[0] * step * cssPerMM, dir[1] * step * cssPerMM);
    }
    e.preventDefault(); refreshCollage(); queueSave('collage'); return;
  }
  if (e.shiftKey) {
    if (!dir[0]) return;
    item.tilt = clampTilt(item.tilt + dir[0] * step);
  } else {
    const target = (passport ? null : (canvas ? canvasGrid : printsGrid).cardCanvas(item)) || preview.canvas;
    const cssPerMM = target.getBoundingClientRect().width / preview.sizeMM(item).w;
    panOnCanvas(item, target, preview.frontRect, dir[0] * step * cssPerMM, dir[1] * step * cssPerMM);
  }
  e.preventDefault();
  item.auto = ''; item.smartPending = false;
  if (passport) ppSyncItem(); else if (canvas) refreshCanvas(); else refreshPrints();
});

for (const [id, preview, key] of [['#canvas-measure', canvasPrints.preview, 'canvas'], ['#pp-measure', pp.preview, 'passport']]) {
  const box = $(id);
  try { box.checked = localStorage.getItem('ellashop-measure-' + key) === 'on'; } catch (_) { /* storage may be unavailable */ }
  preview.showMeasure = box.checked;
  box.addEventListener('change', () => {
    preview.showMeasure = box.checked; preview.draw();
    try { localStorage.setItem('ellashop-measure-' + key, box.checked ? 'on' : 'off'); } catch (_) { /* storage may be unavailable */ }
  });
}

// Composition guides: remembered per tab; ↻ or the O key turns them.
for (const [tab, preview] of [['canvas', canvasPrints.preview], ['collage', collage.preview]]) {
  const select = $(`#${tab}-composition`), turn = $(`#${tab}-composition-turn`);
  try {
    select.value = localStorage.getItem('ellashop-composition-' + tab) || '';
    preview.compositionTurn = +(localStorage.getItem('ellashop-composition-turn-' + tab) || 0);
  } catch (_) { /* storage may be unavailable */ }
  preview.composition = select.value;
  const save = () => { try { localStorage.setItem('ellashop-composition-' + tab, select.value); localStorage.setItem('ellashop-composition-turn-' + tab, preview.compositionTurn); } catch (_) { /* storage may be unavailable */ } };
  select.addEventListener('change', () => { preview.composition = select.value; preview.draw(); save(); });
  preview.turnComposition = () => { preview.compositionTurn = ((preview.compositionTurn || 0) + 1) % 4; preview.draw(); save(); };
  turn.addEventListener('click', preview.turnComposition);
}
document.addEventListener('keydown', e => {
  if (e.key.toLowerCase() !== 'o' || e.metaKey || e.ctrlKey || e.altKey || e.target.closest?.('input, textarea, select, [contenteditable]')) return;
  const preview = $('#prints').classList.contains('active') ? prints.preview
    : $('#canvas-view').classList.contains('active') ? canvasPrints.preview
      : $('#collage').classList.contains('active') && collage.view === 'single' ? collage.preview : null;
  if (preview?.composition) { e.preventDefault(); preview.turnComposition(); }
});

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

const configReady = refreshConfig();
