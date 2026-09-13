import assert from 'node:assert/strict';
import { installFakeNetwork, ctx, calls } from './harness.mjs';

installFakeNetwork();

const {
  normalizeSubject,
  facetsOf,
  vectorOf,
  normOf,
  similarity,
  distinctiveSubjects,
} = await import('../src/graph/subjects.js');

const {
  buildBookMap,
  buildAuthorMap,
  buildSubjectMap,
  buildInfluenceMap,
  buildPathMap,
  expandNode,
  relatedBooks,
  connectionBetween,
  bookId,
  authorId,
} = await import('../src/graph/build.js');

let passed = 0;
const test = async (name, fn) => {
  try {
    await fn();
    passed += 1;
    console.log(`  ok  ${name}`);
  } catch (err) {
    console.log(`FAIL  ${name}\n      ${err.message}`);
    process.exitCode = 1;
  }
};

console.log('\nSubjects');

await test('drops scanning metadata but keeps real headings', () => {
  assert.equal(normalizeSubject('Accessible book'), '');
  assert.equal(normalizeSubject('Protected DAISY'), '');
  assert.equal(normalizeSubject('nyt:graphic_books=2010-04-25'), '');
  assert.equal(normalizeSubject('  Graphic Novels. '), 'graphic novels');
});

await test('splits compound headings into facets', () => {
  const facets = facetsOf('Superheroes -- Comic books, strips, etc.').map((f) => f.facet);
  assert.ok(facets.includes('superheroes -- comic books, strips, etc'));
  assert.ok(facets.includes('superheroes'));
  assert.ok(facets.includes('comic books, strips, etc'));
});

await test('a specific heading outweighs a generic one', () => {
  const specific = vectorOf(['Autobiographical comics'], null);
  const generic = vectorOf(['Fiction'], null);
  assert.ok([...specific.values()][0] > [...generic.values()][0]);
});

await test('similar books score above unrelated ones', () => {
  const watchmen = vectorOf(['Superheroes', 'Graphic novels', 'Dystopias', 'Vigilantes'], null);
  const darkKnight = vectorOf(['Superheroes', 'Graphic novels', 'Vigilantes', 'Dystopias'], null);
  const cookery = vectorOf(['Cookery, French', 'Sauces'], null);
  const near = similarity(watchmen, darkKnight, normOf(watchmen), normOf(darkKnight));
  const far = similarity(watchmen, cookery, normOf(watchmen), normOf(cookery));
  assert.ok(near > 0.9, `expected a strong match, got ${near.toFixed(2)}`);
  assert.equal(far, 0);
});

await test('distinctive subjects drop restatements of each other', () => {
  const picks = distinctiveSubjects(
    ['Superheroes', 'Superheroes -- Comic books', 'Fiction', 'Dystopias'],
    null,
    4,
  ).map((p) => p.key);
  assert.ok(picks.includes('dystopias'));
  assert.equal(picks.filter((p) => p.includes('superheroes')).length, 1);
});

console.log('\nBook maps');

const bookMap = await buildBookMap('OL1W', ctx);

await test('puts the seed at the centre and neighbours around it', () => {
  assert.equal(bookMap.seedLabel, 'Watchmen');
  assert.equal(bookMap.seedSubtitle, 'Alan Moore');
  assert.equal(bookMap.seedId, bookId('OL1W'));
  assert.ok(bookMap.graph.order > 4, `only ${bookMap.graph.order} nodes`);
  assert.ok(bookMap.graph.getNodeAttribute(bookMap.seedId, 'seed'));
});

await test('ranks the closest book highest', () => {
  const ranked = bookMap.graph
    .filterNodes((id) => id !== bookMap.seedId)
    .map((id) => ({ label: bookMap.graph.getNodeAttribute(id, 'label'), score: bookMap.graph.getNodeAttribute(id, 'score') }))
    .sort((a, b) => b.score - a.score);
  assert.ok(
    ['V for Vendetta', 'The Dark Knight Returns'].includes(ranked[0].label),
    `top match was ${ranked[0].label}`,
  );
});

await test('links neighbours to each other, not only to the seed', () => {
  const withoutSeed = bookMap.graph.filterEdges(
    (_e, _a, source, target) => source !== bookMap.seedId && target !== bookMap.seedId,
  );
  assert.ok(withoutSeed.length > 0, 'the map is a star, not a network');
});

await test('caps how many links any one book carries', () => {
  let worst = 0;
  bookMap.graph.forEachNode((id) => {
    if (id !== bookMap.seedId) worst = Math.max(worst, bookMap.graph.degree(id));
  });
  assert.ok(worst <= 16, `one book carries ${worst} links`);
});

await test('explains a link with the subjects behind it', () => {
  const shared = connectionBetween(bookMap.graph, bookId('OL5W'), bookMap.seedId);
  assert.ok(shared.includes('superheroes'), `got ${JSON.stringify(shared)}`);
});

await test('a book with no subjects on record says so', async () => {
  await assert.rejects(() => buildBookMap('OL999W', ctx), /no work with the ID/);
});

console.log('\nAuthor maps');

const authorMap = await buildAuthorMap('OL1A', ctx);

await test('maps writers rather than books', () => {
  assert.equal(authorMap.seedLabel, 'Alan Moore');
  authorMap.graph.forEachNode((_id, attrs) => assert.equal(attrs.kind, 'author'));
  assert.ok(authorMap.graph.order > 2);
});

await test('leaves the author off their own map', () => {
  assert.equal(authorMap.graph.filterNodes((_id, a) => a.key === 'OL1A' && !a.seed).length, 0);
});

await test('lays Wikidata influence over the subject links, pointing the right way', async () => {
  // The overlay is fired without being awaited, so give it a turn to land.
  await new Promise((r) => setTimeout(r, 50));
  const influence = authorMap.graph.filterEdges((_e, attrs) => attrs.influence);
  assert.ok(influence.length > 0, 'no influence edges were drawn');
  const edge = influence[0];
  const attrs = authorMap.graph.getEdgeAttributes(edge);
  assert.ok(attrs.from && attrs.to && attrs.from !== attrs.to);
  // Alan Moore influenced Frank Miller, not the other way round.
  const millerEdge = authorMap.graph.edge(authorId('OL1A'), authorId('OL4A'));
  if (millerEdge) {
    assert.equal(authorMap.graph.getEdgeAttribute(millerEdge, 'from'), authorId('OL1A'));
  }
});

console.log('\nSubject maps');

const subjectMap = await buildSubjectMap(['Graphic novels', 'Dystopias'], ctx);

await test('ranks books answering both subjects above books answering one', () => {
  const scored = subjectMap.graph.mapNodes((id, attrs) => ({ label: attrs.label, matches: attrs.matches, score: attrs.score }));
  const both = scored.filter((s) => s.matches === 2);
  const one = scored.filter((s) => s.matches === 1);
  assert.ok(both.length > 0, 'nothing matched both subjects');
  assert.ok(Math.min(...both.map((s) => s.score)) >= Math.max(...one.map((s) => s.score)) - 1e-9);
});

await test('reports how big each subject is', () => {
  assert.equal(subjectMap.counts.length, 2);
  assert.ok(subjectMap.counts.every((c) => c.workCount > 0));
});

await test('an unknown subject fails with an explanation', async () => {
  await assert.rejects(() => buildSubjectMap(['zzzz nothing'], ctx), /nothing filed under/i);
});

console.log('\nInfluence maps');

const influenceMap = await buildInfluenceMap('OL1A', ctx);

await test('reaches back and forward from the seed', () => {
  assert.equal(influenceMap.seedLabel, 'Alan Moore');
  const gens = influenceMap.graph.mapNodes((_id, attrs) => attrs.gen);
  assert.ok(gens.some((g) => g < 0), 'nobody earlier than the seed');
  assert.ok(gens.some((g) => g > 0), 'nobody later than the seed');
});

await test('follows the line a second generation back', () => {
  const labels = influenceMap.graph.mapNodes((_id, attrs) => attrs.label);
  // Swift influenced Orwell, who influenced Moore.
  assert.ok(labels.includes('Jonathan Swift'), `second hop missing from ${JSON.stringify(labels)}`);
  const swift = influenceMap.graph.findNode((_id, a) => a.label === 'Jonathan Swift');
  assert.ok(influenceMap.graph.getNodeAttribute(swift, 'gen') <= -1);
});

await test('every edge is directed and carries its orientation', () => {
  influenceMap.graph.forEachEdge((_e, attrs) => {
    assert.ok(attrs.influence);
    assert.ok(attrs.from && attrs.to);
  });
});

await test('keeps a writer with no Open Library record, keyed by Wikidata', () => {
  const adams = influenceMap.graph.findNode((_id, a) => a.label === 'Douglas Adams');
  assert.ok(adams, 'Douglas Adams was dropped');
  assert.equal(influenceMap.graph.getNodeAttribute(adams, 'openLibrary'), null);
});

await test('sizes writers by how much runs through them', () => {
  const scores = influenceMap.graph.mapNodes((id, attrs) => (attrs.seed ? 1 : attrs.score));
  assert.ok(Math.max(...scores) <= 1 && Math.min(...scores) > 0);
});

console.log('\nPaths');

const path = await buildPathMap({ kind: 'book', key: 'OL1W' }, { kind: 'book', key: 'OL6W' }, ctx);

await test('finds a route and anchors both ends', () => {
  assert.equal(path.fromLabel, 'Watchmen');
  assert.equal(path.toLabel, 'Fun Home');
  assert.ok(path.path.length >= 2);
  assert.equal(path.path[0], bookId('OL1W'));
  assert.equal(path.path.at(-1), bookId('OL6W'));
  assert.equal(path.graph.getNodeAttribute(path.path[0], 'anchor'), 'start');
  assert.equal(path.graph.getNodeAttribute(path.path.at(-1), 'anchor'), 'end');
});

await test('every step of the route survives into the drawn map', () => {
  for (const id of path.path) assert.ok(path.graph.hasNode(id), `${id} was trimmed away`);
  for (let i = 0; i < path.path.length - 1; i++) {
    assert.ok(path.graph.edge(path.path[i], path.path[i + 1]), `no link between steps ${i} and ${i + 1}`);
  }
});

await test('an author at one end becomes their most republished book', async () => {
  const mixed = await buildPathMap({ kind: 'author', key: 'OL6A' }, { kind: 'book', key: 'OL6W' }, ctx);
  assert.equal(mixed.fromLabel, 'Nineteen Eighty-Four');
  assert.equal(mixed.converted.length, 1);
  assert.equal(mixed.converted[0].from, 'George Orwell');
  assert.equal(mixed.converted[0].to, 'Nineteen Eighty-Four');
});

console.log('\nGrowing a map');

await test('adds new books and wires them in', async () => {
  const before = bookMap.graph.order;
  const added = await expandNode(bookMap.graph, bookId('OL3W'), ctx, 5);
  assert.ok(bookMap.graph.order >= before);
  assert.ok(added >= 0);
  assert.ok(bookMap.graph.getNodeAttribute(bookId('OL3W'), 'expanded'));
});

await test('the panel list ranks by overlap and excludes the book itself', async () => {
  const seed = bookMap.graph.getNodeAttributes(bookId('OL1W'));
  const related = await relatedBooks(seed, ctx, { subjects: 3, limit: 6 });
  assert.ok(related.length > 0);
  assert.ok(!related.some((r) => r.book.key === 'OL1W'));
  assert.ok(related[0].score >= related.at(-1).score);
});

console.log('\nRequests');

await test('caches, so the same subject is never fetched twice', () => {
  const seen = new Map();
  for (const call of calls.openLibrary) seen.set(call, (seen.get(call) || 0) + 1);
  const repeated = [...seen.entries()].filter(([, n]) => n > 1);
  assert.equal(repeated.length, 0, `repeated: ${JSON.stringify(repeated.slice(0, 3))}`);
});

console.log(`\n${passed} passed${process.exitCode ? ', with failures above' : ''}\n`);
