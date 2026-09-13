/**
 * Boots the real interface in jsdom against the fake network, so the wiring
 * between routing, the map view and the panel is exercised rather than assumed.
 * It is a smoke test: it checks things appear and nothing throws, not that they
 * look right.
 */
import assert from 'node:assert/strict';
import './uienv.mjs';
import { installFakeNetwork } from './harness.mjs';

const { window } = globalThis.__dom;

installFakeNetwork();

let passed = 0;
const test = async (name, fn) => {
  try {
    await fn();
    passed += 1;
    console.log(`  ok  ${name}`);
  } catch (err) {
    console.log(`FAIL  ${name}\n      ${err.stack?.split('\n').slice(0, 3).join('\n      ')}`);
    process.exitCode = 1;
  }
};

const settle = (ms = 220) => new Promise((r) => setTimeout(r, ms));
const $ = (id) => window.document.getElementById(id);
const text = () => $('panel').textContent;

console.log('\nInterface');

await test('boots to the empty state with examples and the influence sketch', async () => {
  await import('../src/main.js');
  await settle(50);
  assert.equal($('empty').hidden, false);
  assert.equal(window.document.querySelectorAll('.example').length, 4);
  assert.ok($('empty-art').querySelectorAll('circle').length > 10, 'no sketch drawn');
  assert.ok($('empty-art').querySelectorAll('path[transform]').length > 0, 'no arrowheads drawn');
  assert.ok($('search').querySelector('input'), 'no search box');
});

await test('opening a book draws a map and fills the panel', async () => {
  window.location.hash = '#book/OL1W';
  await settle(4000);
  assert.equal($('empty').hidden, true);
  assert.match($('map-title').textContent, /Books beside Watchmen/);
  const dots = window.document.querySelectorAll('.nodes g.node');
  assert.ok(dots.length > 4, `only ${dots.length} dots drawn`);
  assert.match(text(), /Books beside Watchmen/);
  assert.match(text(), /Everything on this map/);
});

await test('selecting a dot shows the book, its subjects and its neighbours', async () => {
  const nodes = [...window.document.querySelectorAll('.nodes g.node')];
  const target = nodes.find((n) => (n.getAttribute('aria-label') || '').includes('Dark Knight'));
  assert.ok(target, 'The Dark Knight Returns was not drawn');
  target.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await settle(2500);
  assert.match(text(), /The Dark Knight Returns/);
  assert.match(text(), /subject overlap with Watchmen/);
  assert.match(text(), /Superheroes/);
  assert.match(text(), /Shares subjects with/);
});

await test('an influence map draws directed arrows', async () => {
  window.location.hash = '#influence/OL1A';
  await settle(4000);
  assert.match($('map-title').textContent, /Influence around Alan Moore/);
  assert.ok(window.document.querySelectorAll('.edges line.influence').length > 0, 'no influence lines');
  assert.ok(window.document.querySelectorAll('.arrows path.arrow').length > 0, 'no arrowheads');
  assert.match($('legend-text').textContent, /Arrows run from influence/);
});

await test('a subject map reads its subjects out of the address bar', async () => {
  window.location.hash = '#subject/Graphic%20novels/Dystopias';
  await settle(4000);
  assert.match($('map-title').textContent, /Graphic novels and Dystopias/);
  assert.ok(window.document.querySelectorAll('.chips .chip').length === 2, 'subject chips missing');
  assert.match(text(), /answer to more of your subjects/);
});

await test('a nonsense address falls back to the empty state', async () => {
  window.location.hash = '#nonsense/xyz';
  await settle(200);
  assert.equal($('empty').hidden, false);
});

await test('a named route rewrites itself to a stable ID', async () => {
  window.location.hash = '#book/q/Maus';
  await settle(4000);
  assert.equal(window.location.hash, '#book/OL3W');
  assert.match($('map-title').textContent, /Books beside Maus/);
});

await test('the wordmark leads back to the start', async () => {
  assert.equal($('empty').hidden, true);
  const wordmark = window.document.querySelector('.wordmark');
  assert.ok(wordmark, 'no wordmark');
  wordmark.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
  await settle(300);
  assert.equal(window.location.hash, '');
  assert.equal($('empty').hidden, false);
  assert.equal($('crumb').hidden, true);
});


async function typeSearch(query) {
  window.location.hash = '';
  await settle(150);
  const input = $('search').querySelector('input');
  input.value = query;
  input.dispatchEvent(new window.Event('focus'));
  input.dispatchEvent(new window.Event('input', { bubbles: true }));
  await settle(2500);
  return [...window.document.querySelectorAll('.results .option')];
}

await test('the search box offers books, authors and subjects together', async () => {
  const rows = await typeSearch('Maus');
  const groups = [...window.document.querySelectorAll('.results .group-label')].map((g) => g.textContent);
  assert.ok(groups.includes('Books'), `groups were ${JSON.stringify(groups)}`);
  assert.ok(rows.some((r) => r.textContent.includes('Maus')), 'Maus was not offered');
  assert.ok(rows.every((r) => r.querySelector('.option-icon svg')), 'a row has no kind icon');
});

await test('things already drawn are offered before anything is fetched', async () => {
  window.location.hash = '#book/OL1W';
  await settle(4000);
  const input = $('search').querySelector('input');
  input.value = 'Maus';
  input.dispatchEvent(new window.Event('focus'));
  input.dispatchEvent(new window.Event('input', { bubbles: true }));
  await settle(400);
  const groups = [...window.document.querySelectorAll('.results .group-label')].map((g) => g.textContent);
  assert.ok(groups.includes('On this map'), `groups were ${JSON.stringify(groups)}`);
});

await test('picking an author from search opens their map', async () => {
  const rows = await typeSearch('Spiegelman');
  // A book row names its author too, so match on the row's own name.
  const row = rows.find((r) => r.querySelector('.option-name')?.textContent === 'Art Spiegelman');
  assert.ok(row, `Art Spiegelman was not offered; saw ${JSON.stringify(rows.map((r) => r.textContent))}`);
  row.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await settle(4000);
  assert.equal(window.location.hash, '#author/OL2A');
  assert.match($('map-title').textContent, /Writers near Art Spiegelman/);
});

await test('a map can be copied out as a reading list', async () => {
  let copied = '';
  Object.defineProperty(window.navigator, 'clipboard', {
    configurable: true,
    value: { writeText: (t) => ((copied = t), Promise.resolve()) },
  });
  window.location.hash = '#book/OL1W';
  await settle(4000);
  const button = [...$('panel').querySelectorAll('.button')].find((b) =>
    b.textContent.includes('Copy as a reading list'),
  );
  assert.ok(button, 'no copy button in the overview');
  button.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await settle(200);
  assert.match(copied, /Books beside Watchmen/);
  assert.match(copied, /Watchmen — Alan Moore \(1986\)/);
  assert.match(copied, /openlibrary\.org\/works\/OL1W/);
  assert.match($('status').textContent, /Copied/);
});

console.log(`\n${passed} passed${process.exitCode ? ', with failures above' : ''}\n`);
process.exit(process.exitCode || 0);
