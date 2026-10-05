// Ellashop — crop photos to print formats and make passport-photo sheets.
'use strict';
// Defines print, canvas, and passport sizes shared by the later UI scripts.
// Loads first so rendering and every tab can use the same format rules.

const DPI = 300;
const mm2px = (mm, dpi = DPI) => Math.round(mm / 25.4 * dpi);

// Print formats in mm, short side first.
const FORMATS = [
  { id: '10x15', w: 100, h: 150 },
  { id: '9x13', w: 90, h: 130 },
  { id: '13x18', w: 130, h: 180 },
  { id: '10x10', w: 100, h: 100 },
  { id: '15x20', w: 150, h: 200 },
  { id: '15x15', w: 150, h: 150 },
  { id: '20x20', w: 200, h: 200 },
  { id: '20x30', w: 200, h: 300 },
];
const CANVAS_FORMATS = ['20x30', '30x40', '30x30', '40x50', '40x60', '50x70', '50x90', '50x100', '50x120']
  .map(id => { const [w, h] = id.split('x').map(x => +x * 10); return { id, w, h }; });
const COLLAGE_PAPERS = [...FORMATS, ...CANVAS_FORMATS.filter(f => !FORMATS.some(print => print.id === f.id))];
const CANVAS_DPI = 150;
const fmtLabel = f => `${f.w / 10}×${f.h / 10}`;

// Passport sizes. Guides are mm from the top edge: where the top of the head (or the hairline,
// when `measure` is 'hairline') and the chin should fall (min..max).
// Named documents give only the face height (chin → crown/hairline); the head is placed with
// 40% of the spare height above it and 60% below (room for neck and shoulders).
const passportPreset = (id, label, w, h, [min, max], measure, bgNote) => {
  const top = Math.round((h - (min + max) / 2) * .4 * 2) / 2;
  return { id, label, w, h, measure, bgNote, face: [min, max], crown: [top - 1, top + 1], chin: [top + min, top + max] };
};
const PASSPORT = [
  // Regular 3.5×4.5: chin to the very top of the head (incl. hair) 32–36 mm = 70–80% of the height.
  passportPreset('35x45', '3.5 × 4.5 cm', 35, 45, [32, 36], 'crown', 'plain white or light grey'),
  passportPreset('visa', 'VISA', 50, 50, [32, 36], 'crown', 'plain white or light grey'),  // chin → very top of head
  passportPreset('ca-passport', 'Canada — passport', 50, 70, [31, 36], 'crown', 'plain white or light'),
  passportPreset('cn-visa', 'China — visa', 33, 48, [28, 33], 'crown', 'plain white or off-white'),
];
const SHEET = { w: 100, h: 150 }; // 10×15 paper

function formatById(list, id) {
  const preset = list.find(f => f.id === id);
  if (preset) return preset;
  const match = /^custom-(\d+(?:\.\d+)?)x(\d+(?:\.\d+)?)$/.exec(id || '');
  if (!match) return list[0];
  const [w, h] = match.slice(1).map(Number);
  const passport = list === PASSPORT;
  const min = passport ? [20, 20] : list === CANVAS_FORMATS ? [100, 100] : [20, 20];
  const max = passport ? [100, 150] : list === CANVAS_FORMATS || list === COLLAGE_PAPERS ? [2000, 2000] : [1000, 1000];
  if (!Number.isFinite(w) || !Number.isFinite(h) || w > h || w < min[0] || h < min[1] || w > max[0] || h > max[1]) return list[0];
  if (!passport) return { id, w, h, custom: true };
  const roundHalf = n => Math.round(n * 2) / 2;
  return { ...passportPreset(id, `Custom ${w / 10} × ${h / 10} cm`, w, h,
    [roundHalf(h * .7), roundHalf(h * .8)], 'crown', 'as required'), custom: true };
}

function customFormatId(wCm, hCm, list) {
  const w = Math.round(Number(wCm) * 10 * 10) / 10, h = Math.round(Number(hCm) * 10 * 10) / 10;
  if (!Number.isFinite(w) || !Number.isFinite(h)) return null;
  const [short, long] = [w, h].sort((a, b) => a - b);
  const id = `custom-${short}x${long}`;
  return formatById(list, id).custom ? id : null;
}

function customSizeControl(selector, list, limits, selected, apply, status) {
  const bar = $(selector), button = document.createElement('button'), row = document.createElement('div');
  button.type = 'button'; button.className = 'custom-size-button'; button.textContent = 'Custom…';
  row.className = 'custom-size-row'; row.hidden = true;
  row.innerHTML = `W <input type="number" step="0.1" min="${limits[0]}" max="${limits[1]}" aria-label="Width in cm"> × H <input type="number" step="0.1" min="${limits[2]}" max="${limits[3]}" aria-label="Height in cm"> cm <button type="button">Apply</button>`;
  bar.append(button); bar.after(row);
  const [width, height] = row.querySelectorAll('input');
  button.addEventListener('click', e => { e.stopPropagation(); row.hidden = !row.hidden; if (!row.hidden) width.focus(); });
  const submit = () => {
    const w = +width.value, h = +height.value;
    if (!width.value || !height.value || !width.validity.valid || !height.validity.valid ||
        w < limits[0] || w > limits[1] || h < limits[2] || h > limits[3]) {
      setStatus($(status), `Size must be ${limits[0]}–${limits[1]} cm wide and ${limits[2]}–${limits[3]} cm high.`, true); return;
    }
    const id = customFormatId(w, h, list);
    if (!id) { setStatus($(status), 'This size does not fit the available format.', true); return; }
    apply(formatById(list, id)); row.hidden = true;
  };
  row.querySelector('button').addEventListener('click', submit);
  row.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); submit(); } });
  return fmt => {
    button.classList.toggle('on', !!fmt?.custom);
    button.textContent = fmt?.custom ? fmtLabel(fmt) : 'Custom…';
    if (fmt?.custom) { width.value = fmt.w / 10; height.value = fmt.h / 10; }
  };
}

const $ = sel => document.querySelector(sel);
const $$ = sel => [...document.querySelectorAll(sel)];
