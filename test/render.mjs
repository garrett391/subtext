// Dumps the empty-state sketch and a real map as standalone SVG files, so the
// drawing code can be looked at rather than only asserted about.
import { writeFileSync } from 'node:fs';
import './uienv.mjs';
import { installFakeNetwork } from './harness.mjs';

const { window } = globalThis.__dom;
installFakeNetwork();
await import('../src/main.js');
const settle = (ms) => new Promise((r) => setTimeout(r, ms));
await settle(200);

const wrap = (inner, w, h, vb) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="${vb}">` +
  `<rect x="-9999" y="-9999" width="19999" height="19999" fill="#12101a"/>` +
  `<style>text{font-family:sans-serif;fill:#efeae2}.label{opacity:0}.label.shown{opacity:1}` +
  `.edges line{stroke-opacity:.35}.halos circle{opacity:.34}.node .core{stroke:#100e15;stroke-width:1.5}` +
  `.node .ring{fill:none;stroke:transparent}.node.seed .ring{stroke:rgba(239,234,226,.55)}</style>` +
  inner + '</svg>';

const art = window.document.getElementById('empty-art');
writeFileSync(new URL('../out-empty.svg', import.meta.url), wrap(art.innerHTML, 460, 460, '-200 -200 400 400'));

for (const [name, hash, vb] of [
  ['book', '#book/OL1W', '-320 -300 640 600'],
  ['influence', '#influence/OL1A', '-430 -300 860 600'],
]) {
  window.location.hash = hash;
  await settle(5000);
  const svg = window.document.querySelector('svg.map');
  const defs = svg.querySelector('defs').outerHTML;
  const root = svg.querySelector('g');
  writeFileSync(new URL(`../out-${name}.svg`, import.meta.url), wrap(defs + `<g>${root.innerHTML}</g>`, 860, 600, vb));
  console.log(name, 'nodes:', svg.querySelectorAll('g.node').length, 'arrows:', svg.querySelectorAll('path.arrow').length);
}
process.exit(0);
