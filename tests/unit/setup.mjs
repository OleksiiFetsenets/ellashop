// Minimal browser fakes so the app's ES modules can be imported under Node. Import this FIRST, then
// `await import('../../app/static/js/….js')`. Only module-load code needs them; the maths under test never touches the DOM.
const element = () => new Proxy(function () {}, {
  get: (_, key) => key === 'style' || key === 'dataset' || key === 'classList' ? element() : key === Symbol.toPrimitive ? () => '' : element(),
  set: () => true,
  apply: () => element(),
});
globalThis.LANG = 'en';
// t('id') returns the id itself, so a missing string neither logs nor throws.
globalThis.STRINGS = new Proxy({}, { get: (_, key) => key === 'language_direction' ? 'ltr' : typeof key === 'string' ? key : undefined });
globalThis.devicePixelRatio = 1;
globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
globalThis.document = {
  documentElement: {},
  body: element(),
  querySelector: () => null,
  querySelectorAll: () => [],
  createElement: () => element(),
  addEventListener() {},
  fonts: { add() {}, load: async () => [], ready: Promise.resolve() },
};
globalThis.addEventListener = () => {};
