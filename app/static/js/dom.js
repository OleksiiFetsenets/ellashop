// DOM shortcuts and the status-line helper every other script uses.
// Imported by almost every module.

export const $ = sel => document.querySelector(sel);
export const $$ = sel => [...document.querySelectorAll(sel)];

// Show a message in a status element; `err` marks it as an error.
export function setStatus(el, msg, err = false) { el.textContent = msg; el.classList.toggle('err', err); }
