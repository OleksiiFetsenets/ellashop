'use strict';
// Looks up UI text from the language files (app/static/lang/<lang>/*.json, served merged as lang.js).
// Loads first, right after lang.js, so every later script can call t().
// ---------------------------------------------------------------- i18n

// Android-style placeholders: %1$s, %2$d, %3$.1f; %% is a literal percent.
function formatString(text, args) {
  return text.replace(/%(?:(\d+)\$)?(?:\.(\d+))?([sdf%])/g, (all, pos, digits, kind) => {
    if (kind === '%') return '%';
    const v = args[(pos ? +pos : 1) - 1];
    if (v === undefined) return all;
    if (kind === 'd') return String(Math.round(Number(v)));
    if (kind === 'f') return digits === undefined ? String(Number(v)) : Number(v).toFixed(+digits);
    return String(v);
  });
}

const pluralRules = new Intl.PluralRules(LANG);
// In right-to-left languages sizes, ranges and ratios (10 × 15, 32–36, 70–80%) must still read left to right:
// wrap each such run in Unicode left-to-right isolates (LRI … PDI), which are invisible.
const MATH_RUN = /\d+(?:\.\d+)?%?(?:\s*[×–:\/-]\s*\d+(?:\.\d+)?%?)+/g;
const isolateMath = text => STRINGS.language_direction === 'rtl' ? text.replace(MATH_RUN, m => `\u2066${m}\u2069`) : text;
// t('id', ...args). A plural string ({one, other, ...}) picks its form from the first argument.
function t(id, ...args) {
  let s = STRINGS[id];
  if (s === undefined) { console.error(`Missing string: ${id}`); return id; }
  if (typeof s === 'object') s = s[pluralRules.select(Number(args[0]))] ?? s.other;
  return isolateMath(formatString(s, args));
}

// Fill elements marked data-i18n (text), data-i18n-html, data-i18n-title, data-i18n-placeholder, data-i18n-aria-label.
function applyStrings(root = document) {
  const attrs = { title: 'title', placeholder: 'placeholder', 'aria-label': 'ariaLabel' };
  root.querySelectorAll('[data-i18n]').forEach(el => { el.textContent = t(el.dataset.i18n); });
  root.querySelectorAll('[data-i18n-html]').forEach(el => { el.innerHTML = t(el.dataset.i18nHtml); });
  for (const [attr, key] of Object.entries(attrs)) {
    root.querySelectorAll(`[data-i18n-${attr}]`).forEach(el => el.setAttribute(attr, t(el.dataset[`i18n${key[0].toUpperCase()}${key.slice(1)}`])));
  }
}

document.documentElement.lang = LANG;
document.documentElement.dir = STRINGS.language_direction === 'rtl' ? 'rtl' : 'ltr';
applyStrings();
