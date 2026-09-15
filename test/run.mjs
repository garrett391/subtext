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
  parseLcc,
  parseShelf,
  shelfAgreement,
  lengthFactor,
} = await import('../src/graph/classification.js');

const {
  buildBookMap,
  buildAuthorMap,
  buildSubjectMap,
  buildGenreMap,
  buildInfluenceMap,
  buildPathMap,
  expandNode,
  relatedBooks,
  connectionBetween,
  genresBetween,
  authorDamping,
  bookId,
  authorId,
} = await import('../src/graph/build.js');

const { genreAgreement, genreWeights, sharedGenres } = await import('../src/graph/genres.js');

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

await test("an uploader's namespace comes off a heading", () => {
  // "genre:high fantasy" is a private tag on 98 works; "high fantasy" is the
  // heading on nearly nine hundred.
  assert.equal(normalizeSubject('genre:high fantasy'), 'high fantasy');
  assert.equal(normalizeSubject('form:novel'), 'novel');
  assert.equal(normalizeSubject('collection:favourites'), '');
  assert.equal(normalizeSubject('series:A_Court_of_Thorns_and_Roses'), 'series:a court of thorns and roses');
  const picks = distinctiveSubjects(['genre:high fantasy', 'Thieves'], null, 4);
  assert.equal(picks.find((p) => p.key === 'high fantasy').subject, 'high fantasy');
});

await test('a series heading counts towards similarity but is never searched', () => {
  const a = vectorOf(['series:The Mistborn Saga', 'Magic'], null);
  const b = vectorOf(['series:The Mistborn Saga', 'Thieves'], null);
  assert.ok(similarity(a, b, normOf(a), normOf(b)) > 0, 'sharing a series should link two books');
  const picks = distinctiveSubjects(['series:The Mistborn Saga', 'Courts and courtiers'], null, 4).map((p) => p.key);
  assert.deepEqual(picks, ['courts and courtiers']);
});

await test('a long series under one heading is damped after its second volume', () => {
  assert.equal(authorDamping(1), 1);
  assert.equal(authorDamping(2), 1);
  assert.ok(authorDamping(3) < 1);
  assert.ok(authorDamping(28) < 0.1, 'the twenty-eighth volume should count for almost nothing');
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

console.log('\nGenres');

await test('a pair nobody can check is left alone, not marked different', () => {
  assert.equal(genreAgreement([], [{ label: 'space opera' }]), null);
  assert.equal(genreAgreement([{ label: 'space opera' }], [{ label: 'memoir' }]), 0);
  assert.equal(genreAgreement([{ label: 'space opera' }], [{ label: 'space opera' }]), 1);
});

await test('a genre that only names the form counts for nothing', () => {
  assert.equal(genreAgreement([{ label: 'novel' }], [{ label: 'novel' }]), null);
  assert.deepEqual(sharedGenres([{ label: 'novel' }, { label: 'gothic fiction' }], [{ label: 'novel' }, { label: 'gothic fiction' }]), ['gothic fiction']);
});

await test('a genre on two books says more than one on the whole map', () => {
  const lists = [
    [{ label: 'science fiction' }, { label: 'planetary romance' }],
    [{ label: 'science fiction' }, { label: 'planetary romance' }],
    [{ label: 'science fiction' }],
    [{ label: 'science fiction' }],
    [{ label: 'science fiction' }],
  ];
  const weights = genreWeights(lists);
  assert.ok(weights.get('planetary romance') > weights.get('science fiction'));
  const rare = genreAgreement(lists[0], lists[1], weights);
  const common = genreAgreement(lists[2], lists[3], weights);
  assert.ok(rare > common, `${rare} should beat ${common}`);
});

console.log('\nShelves');

await test('reads a call number into class, number and author', () => {
  const mistborn = parseLcc('PS-3619.00000000.A533 M57 2006');
  assert.equal(mistborn.subclass, 'PS');
  assert.equal(mistborn.root, 'P');
  assert.equal(mistborn.number, 3619);
  assert.equal(mistborn.cutter, 'A533');
  // PS3600-3626 is "individual authors who began publishing in 2001 or later",
  // numbered by surname initial. The number is a person, not a subject.
  assert.equal(mistborn.biographical, true);
  assert.equal(mistborn.period, '2001-');
});

await test('a number nobody assigned reads as no number at all', () => {
  assert.equal(parseLcc('LC-0000.000000'), null);
  assert.equal(parseLcc(''), null);
});

await test('proximity counts in a topical range but not in an author range', () => {
  const comics = (n) => parseShelf([`PN-${n}.00000000`], null);
  const american = (n) => parseShelf([`PS-${n}.00000000`], null);
  // PN6727 and PN6737 are ten apart and both comics.
  const near = shelfAgreement(comics('6727'), comics('6737'));
  const far = shelfAgreement(comics('6072'), comics('6737'));
  assert.ok(near > 0.9, `neighbouring comics scored ${near.toFixed(2)}`);
  assert.ok(far < 0.45, `distant classes scored ${far.toFixed(2)}`);

  // PS3551 and PS3569 are eighteen apart, which is the distance from A to S.
  // Asimov and Simmons are not eighteen units of anything apart.
  const asimov = shelfAgreement(american('3551'), american('3569'));
  const sanderson = shelfAgreement(american('3551'), american('3619'));
  assert.ok(asimov < near, 'an author range was scored as though it were topical');
  // Same literature and the same generation of it still beats a later one.
  assert.ok(asimov > sanderson, `${asimov.toFixed(2)} should beat ${sanderson.toFixed(2)}`);
});

await test('separates a novel from a work of theory on the same subject', () => {
  // Both are catalogued under "feminism"; only the call number knows that one
  // of them is fiction.
  const stepfordWives = parseShelf(['PS-3523.00000000.E793 S8'], ['813.54']);
  const theory = parseShelf(['HQ-1154.00000000.F79'], ['305.42']);
  assert.equal(shelfAgreement(stepfordWives, theory), 0);
});

await test('an unclassified book is unknown rather than badly filed', () => {
  const shelved = parseShelf(['PN-6737.00000000'], ['741.5973']);
  assert.equal(parseShelf([], []), null);
  assert.equal(shelfAgreement(null, shelved), null);
});

await test('picks the commonest call number out of a pile of editions', () => {
  const watchmen = parseShelf(
    ['PN-6728.00000000.W3 M821 1987', 'PN-6738.00000000', 'PN-6737.00000000.M66 W38 1987', 'PN-6737.00000000.M66W38 2005'],
    ['741.5941', '741.5', '741.5942', '741.5973'],
  );
  assert.equal(watchmen.lcc.number, 6737);
  // Where the libraries disagree past 741.5, 741.5 is what they agree on.
  assert.equal(watchmen.ddc.digits, '7415');
});

await test('prefers the more specific Dewey number when nothing else separates them', () => {
  // The Stepford Wives is filed at both 813.54 and 810, once each.
  assert.equal(parseShelf([], ['813.54', '810']).ddc.digits, '81354');
  assert.equal(parseShelf([], ['810', '813.54']).ddc.digits, '81354');
});

await test('drops a single stray call number in favour of the majority', () => {
  // The real record for The Stepford Wives carries eight PS3523s, four PZ4s and
  // one PR6019 — Ira Levin filed, once, in the middle of James Joyce.
  const stepfordWives = parseShelf(
    [
      'PS-3523.00000000.E7993 S73 2004', 'PS-3523.00000000.E7993', 'PS-3523.00000000.E7993 St3',
      'PS-3523.00000000.E7993 St4', 'PS-3523.00000000.E7993 St', 'PZ-0004.00000000.L664 St4',
      'PZ-0004.00000000.L664', 'PR-6019.00000000.O9',
    ],
    ['813.54'],
  );
  assert.equal(stepfordWives.lcc.subclass, 'PS');
  assert.equal(stepfordWives.lcc.number, 3523);
});

await test('length holds back a mismatch but never invents a match', () => {
  assert.equal(lengthFactor(240, 280), 1);
  assert.equal(lengthFactor(300, 0), 1, 'a missing page count must not penalise');
  assert.ok(lengthFactor(96, 587) < 0.9, 'a mini-comic and a long graphic novel are different objects');
  assert.ok(lengthFactor(96, 587) > 0.8, 'length must stay a nudge, not a verdict');
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

await test('a book carries its shelf and its length onto the map', () => {
  const watchmen = bookMap.graph.getNodeAttributes(bookId('OL1W'));
  assert.equal(watchmen.shelf.lcc.subclass, 'PN');
  assert.equal(watchmen.pages, 416);
  // Jimmy Corrigan has no call number in the fixture, and still made the map.
  const unshelved = bookMap.graph.getNodeAttributes(bookId('OL9W'));
  assert.equal(unshelved.shelf, null);
  assert.ok(unshelved.score > 0, 'an unclassified book was scored out of existence');
});

await test('the shelf separates the comics from the prose novels', () => {
  // Watchmen, 1984 and Brave New World all share "Dystopias" and "Fiction", so
  // subjects alone put the two novels close to the comic. PN against PR says
  // one of these is not like the others.
  const link = (a, b) => {
    const edge = bookMap.graph.edge(bookId(a), bookId(b));
    return edge ? bookMap.graph.getEdgeAttribute(edge, 'weight') : 0;
  };
  const novelToNovel = link('OL7W', 'OL8W');
  const comicToNovel = link('OL1W', 'OL7W');
  assert.ok(novelToNovel > 0, '1984 and Brave New World should be linked');
  assert.ok(
    novelToNovel > comicToNovel,
    `two dystopian novels (${novelToNovel.toFixed(2)}) should sit closer than a novel and a comic (${comicToNovel.toFixed(2)})`,
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

await test('lays Wikidata genres over the books and lifts the pairs that share one', async () => {
  // The overlay is fired without being awaited, so give it a turn to land.
  await new Promise((r) => setTimeout(r, 50));
  const orwell = bookMap.graph.getNodeAttributes(bookId('OL7W'));
  assert.ok(orwell.genres.some((g) => g.label === 'dystopian fiction'), `got ${JSON.stringify(orwell.genres)}`);
  const edge = bookMap.graph.edge(bookId('OL7W'), bookId('OL8W'));
  assert.ok(edge, '1984 and Brave New World should be linked');
  assert.ok(bookMap.graph.getEdgeAttribute(edge, 'genres'), 'the shared genre did not lift the link');
  assert.deepEqual(genresBetween(bookMap.graph, bookId('OL5W'), bookMap.seedId), ['superhero fiction']);
});

await test('a book Wikidata has never heard of keeps its place', () => {
  const unknown = bookMap.graph.getNodeAttributes(bookId('OL9W'));
  assert.deepEqual(unknown.genres, []);
  assert.ok(bookMap.graph.degree(bookId('OL9W')) > 0, 'an unresolved book lost its links');
  assert.deepEqual(genresBetween(bookMap.graph, bookId('OL9W'), bookMap.seedId), []);
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

console.log('\nGenre maps');

const genreMap = await buildGenreMap('Q1', ctx);

await test('draws everything Wikidata files under a genre, named after it', () => {
  assert.equal(genreMap.seedLabel, 'superhero fiction');
  assert.equal(genreMap.seedId, null);
  assert.ok(genreMap.graph.hasNode(bookId('OL1W')), 'Watchmen missing');
  assert.ok(genreMap.graph.hasNode(bookId('OL5W')), 'The Dark Knight Returns missing');
  assert.equal(genreMap.genre.drawn, 2);
});

await test('a writer filed under the genre is not drawn as a book', () => {
  genreMap.graph.forEachNode((_id, attrs) => assert.equal(attrs.kind, 'book'));
  assert.ok(!genreMap.graph.hasNode(authorId('OL1A')));
  assert.ok(!genreMap.graph.hasNode(bookId('OL1A')));
});

await test('stale work IDs are followed to the merged record, and the better known sits bigger', async () => {
  const dystopias = await buildGenreMap('Q3', ctx);
  assert.equal(dystopias.graph.order, 2, `drew ${dystopias.graph.order} books`);
  assert.ok(dystopias.graph.hasNode(bookId('OL8W')), 'Brave New World missing');
  assert.ok(!dystopias.graph.hasNode(bookId('OL80W')) && !dystopias.graph.hasNode(bookId('OL81W')), 'a stale work ID was drawn');
  assert.equal(dystopias.genre.known, 2);
  const orwell = dystopias.graph.getNodeAttribute(bookId('OL7W'), 'score');
  const huxley = dystopias.graph.getNodeAttribute(bookId('OL8W'), 'score');
  assert.ok(orwell > huxley, `expected 1984 (${orwell}) above Brave New World (${huxley})`);
  assert.ok(dystopias.graph.edge(bookId('OL7W'), bookId('OL8W')), 'the two dystopias were not linked');
});

await test('a genre with nothing under it says so', async () => {
  await assert.rejects(() => buildGenreMap('Q999', ctx), /files nothing/i);
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
