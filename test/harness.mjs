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
  },
  {
    key: 'OL2W',
    title: 'V for Vendetta',
    author: ['OL1A', 'Alan Moore'],
    year: 1988,
    editions: 41,
    subjects: ['Superheroes', 'Comic books, strips, etc', 'Graphic novels', 'Dystopias', 'Anarchism', 'Fiction'],
  },
  {
    key: 'OL3W',
    title: 'Maus',
    author: ['OL2A', 'Art Spiegelman'],
    year: 1986,
    editions: 60,
    subjects: ['Comic books, strips, etc', 'Graphic novels', 'Holocaust, Jewish (1939-1945)', 'Biography', 'Nonfiction'],
  },
  {
    key: 'OL4W',
    title: 'Persepolis',
    author: ['OL3A', 'Marjane Satrapi'],
    year: 2000,
    editions: 38,
    subjects: ['Comic books, strips, etc', 'Graphic novels', 'Autobiography', 'Iran', 'Nonfiction'],
  },
  {
    key: 'OL5W',
    title: 'The Dark Knight Returns',
    author: ['OL4A', 'Frank Miller'],
    year: 1986,
    editions: 33,
    subjects: ['Superheroes', 'Comic books, strips, etc', 'Graphic novels', 'Vigilantes', 'Dystopias', 'Fiction'],
  },
  {
    key: 'OL6W',
    title: 'Fun Home',
    author: ['OL5A', 'Alison Bechdel'],
    year: 2006,
    editions: 21,
    subjects: ['Comic books, strips, etc', 'Graphic novels', 'Autobiography', 'Lesbians', 'Nonfiction'],
  },
  {
    key: 'OL7W',
    title: 'Nineteen Eighty-Four',
    author: ['OL6A', 'George Orwell'],
    year: 1949,
    editions: 220,
    subjects: ['Dystopias', 'Totalitarianism', 'Fiction', 'Science fiction', 'Accessible book', 'Protected DAISY'],
  },
  {
    key: 'OL8W',
    title: 'Brave New World',
    author: ['OL7A', 'Aldous Huxley'],
    year: 1932,
    editions: 140,
    subjects: ['Dystopias', 'Science fiction', 'Fiction', 'Totalitarianism'],
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

    calls.openLibrary.push(url.pathname + url.search);
    const params = url.searchParams;

    if (url.pathname === '/search.json') {
      const q = params.get('q') || '';
      const subject = params.get('subject');
      const author = params.get('author');
      const title = params.get('title');
      let docs = WORKS;

      if (subject) docs = WORKS.filter((w) => hasSubject(w, subject));
      else if (/^key:\/works\//.test(q)) docs = WORKS.filter((w) => `/works/${w.key}` === q.slice(4));
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
