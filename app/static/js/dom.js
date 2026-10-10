'use strict';
// DOM shortcuts and the status-line helper every other script uses.
// Loads first (after lang.js), so no script ever calls a helper that is defined further down.

const $ = sel => document.querySelector(sel);
const $$ = sel => [...document.querySelectorAll(sel)];

// Show a message in a status element; `err` marks it as an error.
function setStatus(el, msg, err = false) { el.textContent = msg; el.classList.toggle('err', err); }
