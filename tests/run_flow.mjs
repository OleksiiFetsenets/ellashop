// Runs one browser journey (a JSON list of steps) in headless Google Chrome over the DevTools protocol.
// Needs only Node 22+ (built-in WebSocket) and Chrome. Prints ✓/✗ per step; exit code 1 on the first failure.
// Usage: node tests/run_flow.mjs <steps.json> <screenshot dir>
//
// Steps: goto {url}, click {sel}, drag {sel, dx, dy, alt}, type {sel, value}, press {key}, eval {expr}, sleep {ms}, waitFor {sel},
// assert {assert: "selector :: text~=words"}, assertNoErrors, shot {name}.
// `eval` awaits promises; throwing an Error fails the step with its message.
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const [stepsFile, outDir] = process.argv.slice(2);
const steps = JSON.parse(readFileSync(stepsFile, 'utf8'));
mkdirSync(outDir, { recursive: true });
const CHROME = process.env.CHROME || [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  '/usr/bin/google-chrome',
].find(existsSync);
const WAIT_MS = 15000;
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---- Chrome and the DevTools connection
const profile = mkdtempSync(join(tmpdir(), 'ellashop-chrome-'));
const chrome = spawn(CHROME, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`,
  '--window-size=1400,900', '--no-first-run', '--no-default-browser-check', 'about:blank'], { stdio: 'ignore' });
const cleanup = () => { chrome.kill(); try { rmSync(profile, { recursive: true, force: true }); } catch { /* still closing */ } };
process.on('exit', cleanup);

let port;
for (let i = 0; i < 100 && !port; i++) {
  try { port = readFileSync(join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0]; } catch { await sleep(100); }
}
if (!port) { console.error('Chrome did not start'); process.exit(1); }
const page = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(t => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });

let nextId = 1;
const pending = new Map(), listeners = new Set(), errors = [];
ws.onmessage = ({ data }) => {
  const msg = JSON.parse(data);
  if (msg.id) {
    const p = pending.get(msg.id); pending.delete(msg.id);
    msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result);
  } else listeners.forEach(fn => fn(msg));
};
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const id = nextId++; pending.set(id, { resolve, reject });
  ws.send(JSON.stringify({ id, method, params }));
});
const once = (method, ms) => new Promise((resolve, reject) => {
  const fn = msg => { if (msg.method === method) { listeners.delete(fn); clearTimeout(t); resolve(msg.params); } };
  const t = setTimeout(() => { listeners.delete(fn); reject(new Error(`no ${method} within ${ms} ms`)); }, ms);
  listeners.add(fn);
});

// Page errors that make assertNoErrors fail: uncaught exceptions, console.error and failed loads.
listeners.add(({ method, params }) => {
  if (method === 'Runtime.exceptionThrown') errors.push(params.exceptionDetails.exception?.description || params.exceptionDetails.text);
  else if (method === 'Runtime.consoleAPICalled' && params.type === 'error') errors.push(params.args.map(a => a.value ?? a.description).join(' '));
  else if (method === 'Log.entryAdded' && params.entry.level === 'error') errors.push(`${params.entry.text} ${params.entry.url || ''}`);
});
await Promise.all(['Page.enable', 'Runtime.enable', 'Log.enable'].map(m => send(m)));

// ---- helpers run inside the page
async function evaluate(expression) {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description?.split('\n')[0] || r.exceptionDetails.text);
  return r.result.value;
}
const visible = sel => `(() => { const el = document.querySelector(${JSON.stringify(sel)});
  if (!el) return null; el.scrollIntoView({ block: 'center', inline: 'center' });
  const r = el.getBoundingClientRect(), s = getComputedStyle(el);
  return r.width && r.height && s.visibility !== 'hidden' && s.display !== 'none' ? { x: r.x + r.width / 2, y: r.y + r.height / 2 } : null; })()`;
async function waitFor(sel) {
  const end = Date.now() + WAIT_MS;
  for (;;) {
    const point = await evaluate(visible(sel));
    if (point) return point;
    if (Date.now() > end) throw new Error(`${sel} not visible within ${WAIT_MS} ms`);
    await sleep(100);
  }
}
async function click(sel) {
  const { x, y } = await waitFor(sel);
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
}
const KEYS = { Escape: 27, Enter: 13, Tab: 9, Backspace: 8, Delete: 46, ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40 };

// ---- steps
const run = {
  async goto({ url }) { const loaded = once('Page.loadEventFired', 30000); await send('Page.navigate', { url }); await loaded; return url; },
  async click({ sel }) { await click(sel); return sel; },
  // Real mouse drag from the element's centre by (dx, dy) CSS px; alt holds Alt during the move and release.
  async drag({ sel, dx = 0, dy = 0, alt = false }) {
    // dx/dy may be a page expression (e.g. a share of an element's width) evaluated just before the drag.
    if (typeof dx === 'string') dx = await evaluate(dx);
    if (typeof dy === 'string') dy = await evaluate(dy);
    const { x, y } = await waitFor(sel), modifiers = alt ? 1 : 0;
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 });
    for (let i = 1; i <= 10; i++) {
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x + dx * i / 10, y: y + dy * i / 10, button: 'left', buttons: 1, modifiers });
    }
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: x + dx, y: y + dy, button: 'left', buttons: 0, clickCount: 1, modifiers });
    return `${sel} by ${dx},${dy}${alt ? ' with Alt' : ''}`;
  },
  async type({ sel, value }) {
    await click(sel);
    await evaluate(`document.querySelector(${JSON.stringify(sel)}).select?.()`);
    await send('Input.insertText', { text: String(value) });
    return `${sel} ← ${value}`;
  },
  async press({ key }) {
    const code = KEYS[key] || key.toUpperCase().charCodeAt(0);
    for (const type of ['keyDown', 'keyUp']) await send('Input.dispatchKeyEvent', { type, key, code: key, windowsVirtualKeyCode: code });
    return key;
  },
  async eval({ expr }) { return JSON.stringify(await evaluate(expr)) ?? 'undefined'; },
  async sleep({ ms }) { await sleep(ms); return `${ms} ms`; },
  async waitFor({ sel }) { await waitFor(sel); return `${sel} visible`; },
  async assert({ assert }) {
    const [sel, rule] = assert.split(' :: ');
    const want = rule.replace(/^text~=/, '');
    const text = await evaluate(`document.querySelector(${JSON.stringify(sel)})?.textContent ?? null`);
    if (!text?.includes(want)) throw new Error(`${sel} text is ${JSON.stringify(text)}, expected it to contain ${JSON.stringify(want)}`);
    return assert;
  },
  async assertNoErrors() { if (errors.length) throw new Error(`page errors: ${errors.join(' | ')}`); return 'no errors'; },
  async shot({ name }) {
    const { data } = await send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(join(outDir, `${name}.png`), Buffer.from(data, 'base64'));
    return `${name}.png`;
  },
};

for (const [i, step] of steps.entries()) {
  const label = `step ${i + 1}  ${step.op.padEnd(14)}`;
  try {
    if (!run[step.op]) throw new Error(`unknown step "${step.op}"`);
    const result = await run[step.op](step);
    console.log(`  ✓ ${label} ${String(result).slice(0, 100)}`);
  } catch (e) {
    console.log(`  ✗ ${label} ${e.message}`);
    try { await run.shot({ name: `failed-step-${i + 1}` }); } catch { /* page may be gone */ }
    process.exit(1);
  }
}
process.exit(0);
