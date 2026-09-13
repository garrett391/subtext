/**
 * A browser-shaped environment for the tests: jsdom loaded with the real
 * index.html, plus stand-ins for the parts of a browser jsdom leaves out —
 * media queries, layout boxes, dialogs, and the SVG geometry d3-zoom reads.
 */
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const dom = new JSDOM(html, { url: 'https://example.test/', pretendToBeVisual: true });

const { window } = dom;
globalThis.window = window;
globalThis.document = window.document;
Object.defineProperty(globalThis, 'navigator', { value: window.navigator, configurable: true });
globalThis.location = window.location;
globalThis.history = window.history;
globalThis.Node = window.Node;
globalThis.SVGElement = window.SVGElement;
globalThis.MutationObserver = window.MutationObserver;
globalThis.requestAnimationFrame = window.requestAnimationFrame?.bind(window) ?? ((fn) => setTimeout(fn, 16));
globalThis.getComputedStyle = window.getComputedStyle.bind(window);

// jsdom has no media queries and no layout, so both get plausible stand-ins.
window.matchMedia = (query) => ({
  matches: /min-width:\s*760px|hover:\s*hover/.test(query),
  media: query,
  addEventListener() {},
  removeEventListener() {},
  addListener() {},
  removeListener() {},
});
globalThis.matchMedia = window.matchMedia;

window.Element.prototype.getBoundingClientRect = function () {
  return { x: 0, y: 0, top: 0, left: 0, right: 1280, bottom: 60, width: 1280, height: 800 };
};
window.HTMLDialogElement = window.HTMLDialogElement || function () {};
window.HTMLElement.prototype.showModal = function () {
  this.setAttribute('open', '');
};
window.HTMLElement.prototype.close = function () {
  this.removeAttribute('open');
};
window.Element.prototype.setPointerCapture = function () {};

// jsdom implements no SVG geometry, and d3-zoom reads an <svg>'s width and
// height through the animated-value interface to work out its extent.
for (const axis of ['width', 'height']) {
  Object.defineProperty(window.SVGElement.prototype, axis, {
    configurable: true,
    get() {
      return { baseVal: { value: axis === 'width' ? 1280 : 800 } };
    },
  });
}
window.Element.prototype.scrollIntoView = function () {};

globalThis.__dom = { window, dom };
