/**
 * Stands in for Open Library and Wikidata so the map builders can be exercised
 * without touching either service. The shapes here mirror the real responses:
 * search returns `docs` with `/works/OL…W` keys and a `subject` array, the
 * authors search returns bare keys, and the query service returns
 * `results.bindings`.
 */

const WORKS = [
  {
    key: 'OL1W',
    title: 'Watchmen',
    author: ['OL1A', 'Alan Moore'],
    year: 1986,
    editions: 74,
    subjects: ['Superheroes', 'Comic books, strips, etc', 'Graphic novels', 'Dystopias', 'Vigilantes', 'Fiction'],
    lcc: ['PN-6737.00000000.M66 W38 1987'],
    ddc: ['741.5973'],
    pages: 416,
  },
  {
    key: 'OL2W',
    title: 'V for Vendetta',
    author: ['OL1A', 'Alan Moore'],
    year: 1988,
    editions: 41,
    subjects: ['Superheroes', 'Comic books, strips, etc', 'Graphic novels', 'Dystopias', 'Anarchism', 'Fiction'],
    lcc: ['PN-6737.00000000.M66 V33 2005'],
    ddc: ['741.5973'],
    pages: 296,
  },
  {
    key: 'OL3W',
    title: 'Maus',
    author: ['OL2A', 'Art Spiegelman'],
    year: 1986,
    editions: 60,
    subjects: ['Comic books, strips, etc', 'Graphic novels', 'Holocaust, Jewish (1939-1945)', 'Biography', 'Nonfiction'],
    lcc: ['PN-6727.00000000.S6 M3 1986'],
    ddc: ['741.5973'],
    pages: 296,
    people: ['Vladek Spiegelman'],
  },
  {
    key: 'OL4W',
    title: 'Persepolis',
    author: ['OL3A', 'Marjane Satrapi'],
    year: 2000,
    editions: 38,
    subjects: ['Comic books, strips, etc', 'Graphic novels', 'Autobiography', 'Iran', 'Nonfiction'],
    lcc: ['PN-6747.00000000.S27 P4713 2003'],
    ddc: ['741.5944'],
    pages: 153,
  },
  {
    key: 'OL5W',
    title: 'The Dark Knight Returns',
    author: ['OL4A', 'Frank Miller'],
    year: 1986,
    editions: 33,
    subjects: ['Superheroes', 'Comic books, strips, etc', 'Graphic novels', 'Vigilantes', 'Dystopias', 'Fiction'],
    lcc: ['PN-6728.00000000.B36 M553 1986'],
    ddc: ['741.5973'],
    pages: 224,
  },
  {
    key: 'OL6W',
    title: 'Fun Home',
    author: ['OL5A', 'Alison Bechdel'],
    year: 2006,
    editions: 21,
    subjects: ['Comic books, strips, etc', 'Graphic novels', 'Autobiography', 'Lesbians', 'Nonfiction'],
    lcc: ['PN-6727.00000000.B3757 F86 2006'],
    ddc: ['741.5973'],
    pages: 232,
  },
  {
    key: 'OL7W',
    title: 'Nineteen Eighty-Four',
    author: ['OL6A', 'George Orwell'],
    year: 1949,
    editions: 220,
    subjects: ['Dystopias', 'Totalitarianism', 'Fiction', 'Science fiction', 'Accessible book', 'Protected DAISY'],
    lcc: ['PR-6029.00000000.R8 N49 1949'],
    ddc: ['823.912'],
    pages: 328,
  },
  {
    key: 'OL8W',
    title: 'Brave New World',
    author: ['OL7A', 'Aldous Huxley'],
    year: 1932,
    editions: 140,
    subjects: ['Dystopias', 'Science fiction', 'Fiction', 'Totalitarianism'],
    lcc: ['PR-6015.00000000.U9 B7 1932'],
    ddc: ['823.912'],
    pages: 311,
  },
  {
    key: 'OL9W',
    title: 'Jimmy Corrigan',
    author: ['OL8A', 'Chris Ware'],
    year: 2000,
    editions: 12,
    subjects: ['Comic books, strips, etc', 'Graphic novels', 'Fathers and sons', 'Fiction'],
  },
  {
    key: 'OL10W',
    title: 'From Hell',
    author: ['OL1A', 'Alan Moore'],
    year: 1999,
    editions: 18,
    subjects: ['Comic books, strips, etc', 'Graphic novels', 'Jack, the Ripper', 'Murder', 'Fiction'],
    lcc: ['PN-6737.00000000.M66 F76 1999'],
    ddc: ['741.5973'],
    pages: 572,
  },
];

const AUTHORS = {
  OL1A: { name: 'Alan Moore', birth_date: '18 November 1953', remote_ids: { wikidata: 'Q205721' } },
  OL2A: { name: 'Art Spiegelman', birth_date: '1948', remote_ids: { wikidata: 'Q347262' } },
  OL3A: { name: 'Marjane Satrapi', birth_date: '1969', remote_ids: {} },
  OL4A: { name: 'Frank Miller', birth_date: '1957', remote_ids: { wikidata: 'Q368519' } },
  OL5A: { name: 'Alison Bechdel', birth_date: '1960', remote_ids: {} },
  OL6A: { name: 'George Orwell', birth_date: '1903', death_date: '1950', remote_ids: { wikidata: 'Q3335' } },
  OL7A: { name: 'Aldous Huxley', birth_date: '1894', death_date: '1963', remote_ids: {} },
  OL8A: { name: 'Chris Ware', birth_date: '1967', remote_ids: {} },
};

// Wikidata influence claims, recorded the way P737 is: on the influenced party.
const INFLUENCED_BY = {
  Q205721: ['Q3335', 'Q42'], // Alan Moore <- Orwell, Douglas Adams
  Q368519: ['Q205721'], // Frank Miller <- Alan Moore
  Q347262: ['Q205721'],
  Q3335: ['Q7245'], // Orwell <- Swift
};

const LABELS = {
  Q205721: 'Alan Moore',
  Q3335: 'George Orwell',
  Q42: 'Douglas Adams',
  Q368519: 'Frank Miller',
  Q347262: 'Art Spiegelman',
  Q7245: 'Jonathan Swift',
};

const OPEN_LIBRARY_ID = { Q205721: 'OL1A', Q3335: 'OL6A', Q368519: 'OL4A', Q347262: 'OL2A' };

// Wikidata genres (P136) on works, keyed by Open Library ID. Coverage is
// deliberately partial — Jimmy Corrigan and Persepolis resolve to nothing, as
// about half of any real map does — and "novel" stands for the form-only
// genres that sit on nearly everything.
const GENRES = {
  OL1W: [['Q1', 'superhero fiction'], ['Q2', 'alternate history']],
  OL5W: [['Q1', 'superhero fiction']],
  OL7W: [['Q3', 'dystopian fiction'], ['Q4', 'political fiction'], ['Q5', 'novel']],
  OL8W: [['Q3', 'dystopian fiction'], ['Q5', 'novel']],
  OL3W: [['Q6', 'memoir']],
  OL6W: [['Q6', 'memoir']],
  OL10W: [['Q7', 'historical fiction']],
  OL1A: [['Q1', 'superhero fiction']],
  OL4A: [['Q1', 'superhero fiction']],
};

// What a genre map reads: the genres above run backwards. Each work is its own
// Wikidata item, sized by how many Wikipedias cover it. Brave New World's item
// carries only stale work IDs, the way Dune's real item does: one is gone and
// the other redirects to the record the search index knows. OL1A is a writer
// filed under a genre.
const GENRE_LABELS = { Q1: 'superhero fiction', Q2: 'alternate history', Q3: 'dystopian fiction', Q6: 'memoir', Q7: 'historical fiction' };
const ITEM_OF = { OL1W: 'Q101', OL5W: 'Q105', OL7W: 'Q107', OL8W: 'Q108', OL3W: 'Q103', OL6W: 'Q106', OL10W: 'Q110', OL1A: 'Q205721', OL4A: 'Q368519' };
const ITEM_KEYS = { Q108: ['OL80W', 'OL81W'] };
const REDIRECTS = { OL81W: 'OL8W' };
const SITELINKS = { Q101: 60, Q105: 30, Q107: 138, Q108: 74, Q103: 50, Q106: 20, Q110: 12 };

const asDoc = (work) => ({
  key: `/works/${work.key}`,
  title: work.title,
  author_key: [work.author[0]],
  author_name: [work.author[1]],
  first_publish_year: work.year,
  edition_count: work.editions,
  cover_i: 1000 + Number(work.key.replace(/\D/g, '')),
  subject: work.subjects,
  ratings_average: 4.1,
  ratings_count: 900,
  // Real search results carry these, in the sortable form Open Library
  // normalises call numbers into. Works without them stand for the one book in
  // ten nobody classified.
  ...(work.lcc ? { lcc: work.lcc } : {}),
  ...(work.ddc ? { ddc: work.ddc } : {}),
  ...(work.pages ? { number_of_pages_median: work.pages } : {}),
  ...(work.people ? { person: work.people } : {}),
});

const hasSubject = (work, subject) =>
  work.subjects.some((s) => s.toLowerCase() === String(subject).toLowerCase());

export const calls = { openLibrary: [], sparql: 0 };

function json(body) {
  return Promise.resolve({
    ok: true,
    status: 200,
    json: () => Promise.resolve(body),
  });
}

export function installFakeNetwork() {
  calls.openLibrary = [];
  calls.sparql = 0;

  globalThis.fetch = (input) => {
    const url = new URL(String(input));

    if (url.hostname === 'query.wikidata.org') {
      calls.sparql += 1;
      return json({ results: { bindings: bindingsFor(url.searchParams.get('query') || '') } });
    }

    // wbsearchentities: names looked up on Wikidata itself.
    if (url.hostname === 'www.wikidata.org') {
      const q = (url.searchParams.get('search') || '').toLowerCase();
      const hits = [
        ...Object.entries(GENRE_LABELS).map(([id, label]) => ({ id, label, description: 'genre of fiction' })),
        ...Object.entries(LABELS).map(([id, label]) => ({ id, label, description: 'writer' })),
      ].filter((hit) => hit.label.toLowerCase().includes(q));
      return json({ search: hits.slice(0, 5) });
    }

    calls.openLibrary.push(url.pathname + url.search);
    const params = url.searchParams;

    if (url.pathname === '/search.json') {
      const q = params.get('q') || '';
      const subject = params.get('subject');
      const author = params.get('author');
      const title = params.get('title');
      let docs = WORKS;

      if (subject) docs = WORKS.filter((w) => hasSubject(w, subject));
      else if (/^key:\(/.test(q)) {
        // Several keys OR'd together, the way a genre map reads its books.
        const wanted = new Set([...q.matchAll(/\/works\/(OL\d+W)/g)].map((m) => m[1]));
        docs = WORKS.filter((w) => wanted.has(w.key));
      } else if (/^key:\/works\//.test(q)) docs = WORKS.filter((w) => `/works/${w.key}` === q.slice(4));
      else if (/^author_key:/.test(q)) docs = WORKS.filter((w) => w.author[0] === q.split(':')[1]);
      else if (/^subject:/.test(q)) {
        const wanted = q.replace(/^subject:"?|"$/g, '');
        docs = WORKS.filter((w) => hasSubject(w, wanted));
      } else if (title) {
        docs = WORKS.filter((w) => w.title.toLowerCase().includes(title.toLowerCase()));
        if (author) docs = docs.filter((w) => w.author[1].toLowerCase().includes(author.toLowerCase()));
      } else if (q) {
        docs = WORKS.filter((w) => `${w.title} ${w.author[1]}`.toLowerCase().includes(q.toLowerCase()));
      }

      const limit = Number(params.get('limit') || 20);
      return json({ numFound: docs.length, docs: docs.slice(0, limit).map(asDoc) });
    }

    if (url.pathname === '/search/authors.json') {
      const q = (params.get('q') || '').toLowerCase();
      const docs = Object.entries(AUTHORS)
        .filter(([, a]) => a.name.toLowerCase().includes(q))
        .map(([key, a]) => ({
          key,
          name: a.name,
          birth_date: a.birth_date,
          death_date: a.death_date,
          work_count: WORKS.filter((w) => w.author[0] === key).length,
        }));
      return json({ numFound: docs.length, docs });
    }

    if (url.pathname === '/search/subjects.json') {
      return json({ docs: [{ key: '/subjects/graphic_novels', name: 'Graphic novels', subject_type: 'subject', work_count: 4300 }] });
    }

    const work = /^\/works\/(OL\d+W)\.json$/.exec(url.pathname);
    if (work) {
      if (REDIRECTS[work[1]]) {
        return json({ key: `/works/${work[1]}`, type: { key: '/type/redirect' }, location: `/works/${REDIRECTS[work[1]]}` });
      }
      const found = WORKS.find((w) => w.key === work[1]);
      if (!found) return Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve({}) });
      return json({
        key: `/works/${found.key}`,
        title: found.title,
        subjects: found.subjects,
        covers: [1000],
        description: { type: '/type/text', value: `A description of ${found.title}.` },
        authors: [{ author: { key: `/authors/${found.author[0]}` } }],
      });
    }

    const author = /^\/authors\/(OL\d+A)\.json$/.exec(url.pathname);
    if (author) {
      const found = AUTHORS[author[1]];
      if (!found) return Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve({}) });
      return json({ key: `/authors/${author[1]}`, ...found, photos: [500], bio: `About ${found.name}.` });
    }

    const authorWorks = /^\/authors\/(OL\d+A)\/works\.json$/.exec(url.pathname);
    if (authorWorks) {
      const owned = WORKS.filter((w) => w.author[0] === authorWorks[1]);
      return json({
        size: owned.length,
        entries: owned.map((w) => ({ key: `/works/${w.key}`, title: w.title, subjects: w.subjects })),
      });
    }

    const subjectEndpoint = /^\/subjects\/(.+)\.json$/.exec(url.pathname);
    if (subjectEndpoint) {
      const wanted = decodeURIComponent(subjectEndpoint[1]).replace(/_/g, ' ');
      const owned = WORKS.filter((w) => hasSubject(w, wanted));
      return json({
        key: url.pathname,
        name: wanted,
        work_count: owned.length,
        subjects: [{ name: 'Graphic novels', count: 40 }],
        works: owned.map((w) => ({
          key: `/works/${w.key}`,
          title: w.title,
          subject: w.subjects,
          authors: [{ key: `/authors/${w.author[0]}`, name: w.author[1] }],
          first_publish_year: w.year,
          edition_count: w.editions,
          cover_id: 1000,
        })),
      });
    }

    return Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve({}) });
  };
}

/** Answers the three shapes of query wikidata.js sends. */
function bindingsFor(query) {
  const entity = (qid) => ({ type: 'uri', value: `http://www.wikidata.org/entity/${qid}` });
  const literal = (v) => ({ type: 'literal', value: v });

  // worksInGenre: VALUES ?genre { wd:Q… }, the genres run backwards — or,
  // with no P136 in the query, just the genre's name.
  if (query.includes('VALUES ?genre')) {
    const qid = /VALUES \?genre \{ wd:(Q\d+) \}/.exec(query)?.[1];
    const label = GENRE_LABELS[qid];
    if (!query.includes('P136')) return label ? [{ genreLabel: literal(label) }] : [];
    const rows = [];
    for (const [key, genres] of Object.entries(GENRES)) {
      if (!genres.some(([g]) => g === qid)) continue;
      // The real query filters writers and editions out; the harness leaves
      // one writer in, so the builder is seen to cope with either.
      const item = ITEM_OF[key];
      const keys = ITEM_KEYS[item] || Object.keys(ITEM_OF).filter((k) => ITEM_OF[k] === item);
      for (const olKey of keys) {
        rows.push({
          genreLabel: literal(label),
          item: entity(item),
          itemLabel: literal(WORKS.find((w) => w.key === key)?.title || LABELS[item] || item),
          ol: literal(olKey),
          sitelinks: literal(String(SITELINKS[item] || 0)),
        });
      }
    }
    return rows.sort((a, b) => Number(b.sitelinks.value) - Number(a.sitelinks.value));
  }

  // genresFor: VALUES ?ol { "OL1W" … } joined to P136.
  if (query.includes('wdt:P136 ?genre')) {
    const keys = [...query.matchAll(/"(OL\d+[WA])"/g)].map((m) => m[1]);
    const rows = [];
    for (const key of keys) {
      for (const [qid, label] of GENRES[key] || []) {
        rows.push({ ol: literal(key), genre: entity(qid), genreLabel: literal(label) });
      }
    }
    return rows;
  }

  // itemsForAuthors / influenceAmong: VALUES ?ol { "OL1A" … }
  if (query.includes('wdt:P648 ?ol')) {
    const keys = [...query.matchAll(/"(OL\d+A)"/g)].map((m) => m[1]);
    const rows = [];
    for (const key of keys) {
      const qid = Object.keys(OPEN_LIBRARY_ID).find((q) => OPEN_LIBRARY_ID[q] === key);
      if (!qid) continue;
      const sources = INFLUENCED_BY[qid] || [];
      if (!sources.length || !query.includes('P737')) {
        rows.push({ ol: literal(key), item: entity(qid), itemLabel: literal(LABELS[qid]) });
        continue;
      }
      for (const source of sources) {
        rows.push({
          ol: literal(key),
          item: entity(qid),
          itemLabel: literal(LABELS[qid]),
          influencer: entity(source),
          ...(OPEN_LIBRARY_ID[source] ? { influencerOl: literal(OPEN_LIBRARY_ID[source]) } : {}),
        });
      }
    }
    return rows;
  }

  // influenceNeighbours: VALUES ?anchor { wd:Q… }, both directions.
  if (query.includes('VALUES ?anchor')) {
    const anchors = [...query.matchAll(/wd:(Q\d+)/g)].map((m) => m[1]);
    const rows = [];
    const push = (from, to) =>
      rows.push({
        from: entity(from),
        fromLabel: literal(LABELS[from] || from),
        ...(OPEN_LIBRARY_ID[from] ? { fromOl: literal(OPEN_LIBRARY_ID[from]) } : {}),
        to: entity(to),
        toLabel: literal(LABELS[to] || to),
        ...(OPEN_LIBRARY_ID[to] ? { toOl: literal(OPEN_LIBRARY_ID[to]) } : {}),
      });
    for (const anchor of anchors) {
      for (const source of INFLUENCED_BY[anchor] || []) push(source, anchor);
      for (const [target, sources] of Object.entries(INFLUENCED_BY)) {
        if (sources.includes(anchor)) push(anchor, target);
      }
    }
    return rows;
  }

  // authorFacts: VALUES ?item { wd:Q… }
  const item = /wd:(Q\d+)/.exec(query);
  if (item) {
    const qid = item[1];
    const rows = [
      { type: literal('description'), text: literal('English comics writer') },
      { type: literal('article'), text: literal('https://en.wikipedia.org/wiki/Alan_Moore') },
      { type: literal('genre'), value: entity('Q1'), valueLabel: literal('superhero comics') },
    ];
    for (const source of INFLUENCED_BY[qid] || []) {
      rows.push({
        type: literal('influencedBy'),
        value: entity(source),
        valueLabel: literal(LABELS[source] || source),
        ...(OPEN_LIBRARY_ID[source] ? { valueOl: literal(OPEN_LIBRARY_ID[source]) } : {}),
      });
    }
    for (const [target, sources] of Object.entries(INFLUENCED_BY)) {
      if (!sources.includes(qid)) continue;
      rows.push({
        type: literal('influenced'),
        value: entity(target),
        valueLabel: literal(LABELS[target] || target),
        ...(OPEN_LIBRARY_ID[target] ? { valueOl: literal(OPEN_LIBRARY_ID[target]) } : {}),
      });
    }
    return rows;
  }

  return [];
}

export const ctx = {
  updates: 0,
  check() {},
  update() {
    ctx.updates += 1;
  },
  progress() {},
};
