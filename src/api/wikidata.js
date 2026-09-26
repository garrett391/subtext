import { cached } from './cache.js';

/**
 * Open Library knows what books are about. It doesn't know who read whom.
 * Wikidata does: property P737, "influenced by", is an editorially curated
 * claim that one writer shaped another, and it's the one piece of this app that
 * couldn't be reconstructed from a catalogue.
 *
 * Wikidata also keeps a handful of controlled vocabularies a library catalogue
 * has no equivalent of, each one item per value rather than whatever a
 * cataloguer typed: genres (P136), main subjects (P921), and awards (P166).
 * Any of them run backwards is a map — everything filed as planetary romance,
 * everything about totalitarianism, everything that won the Booker — and on a
 * single book they're the most exact things said about it anywhere here. It
 * also records when a book was first published (P577) and in what language
 * (P407), which a catalogue full of reprints and translations can't.
 *
 * The join between the two is property P648, "Open Library ID", which Wikidata
 * records for tens of thousands of authors and works. That's what lets a book
 * or writer found on Open Library be looked up here without guessing at names.
 *
 * Wikidata's query service is a free, shared, sometimes busy resource, and it's
 * a supplement rather than the foundation: every call here is allowed to fail.
 * When it does, the callers lose influence arrows and keep everything else.
 */

const SPARQL = 'https://query.wikidata.org/sparql';
const SEARCH = 'https://www.wikidata.org/w/api.php';
const TIMEOUT_MS = 15000;

// Kept short so batched queries stay well inside a comfortable URL length.
const BATCH = 18;

let degraded = false;

/** True once a query has failed, so the interface can say so once and move on. */
export const isDegraded = () => degraded;

async function runQuery(sparql) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${SPARQL}?format=json&query=${encodeURIComponent(sparql)}`, {
      signal: controller.signal,
      headers: { Accept: 'application/sparql-results+json' },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    return data?.results?.bindings || [];
  } catch {
    degraded = true;
    return null; // Null means "couldn't ask", which callers treat differently from "no results".
  } finally {
    clearTimeout(timer);
  }
}

const value = (binding, name) => binding?.[name]?.value || '';

/** "http://www.wikidata.org/entity/Q205721" comes back as "Q205721". */
const qidOf = (uri) => {
  const match = /\/(Q\d+)$/.exec(uri || '');
  return match ? match[1] : '';
};

/** The number in a QID, for the rare place one item has to be picked over another. */
const qidNumber = (qid) => Number(String(qid || '').slice(1)) || Infinity;

// The label service falls back to the entity ID when nothing is translated,
// which reads as a bug if it reaches the interface.
const isPlaceholder = (label) => !label || /^Q\d+$/.test(label);

const chunk = (list, size) => {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
};

const quoted = (strings) => strings.map((s) => `"${String(s).replace(/["\\]/g, '')}"`).join(' ');
const entities = (qids) => qids.map((q) => `wd:${q}`).join(' ');

/**
 * Wikidata's times arrive as "1965-01-01T00:00:00Z": the year padded to four
 * digits, a leading minus for BCE, and usually a placeholder day, since most
 * claims about books carry year precision. Only the year is wanted.
 */
export function yearOfTime(text) {
  const match = /^(-?)0*(\d+)-/.exec(String(text || ''));
  if (!match) return null;
  const year = Number(match[2]);
  if (!year) return null;
  return match[1] ? -year : year;
}

// ---------- Finding an author ----------

/**
 * Resolves Open Library author IDs to Wikidata items in one query per batch.
 * Returns a map from Open Library key to `{ qid, label }`, or null if the
 * service couldn't be reached.
 */
export function itemsForAuthors(openLibraryKeys) {
  const keys = [...new Set(openLibraryKeys.filter(Boolean))].sort();
  if (!keys.length) return Promise.resolve(new Map());

  return cached(`wd:items:${keys.join(',')}`, async () => {
    const found = new Map();
    let reachable = false;

    for (const batch of chunk(keys, BATCH)) {
      const rows = await runQuery(`
        SELECT ?ol ?item ?itemLabel WHERE {
          VALUES ?ol { ${quoted(batch)} }
          ?item wdt:P648 ?ol .
          SERVICE wikibase:label { bd:serviceParam wikibase:language "en,mul". }
        }`);
      if (rows === null) continue;
      reachable = true;
      for (const row of rows) {
        const key = value(row, 'ol');
        const qid = qidOf(value(row, 'item'));
        if (key && qid && !found.has(key)) found.set(key, { qid, label: value(row, 'itemLabel') });
      }
    }
    return reachable ? found : null;
  });
}

/** Wikidata's own search box, for the few places something is known only by name. */
async function searchEntities(name, limit = 5) {
  const params = new URLSearchParams({
    action: 'wbsearchentities',
    search: name,
    language: 'en',
    uselang: 'en',
    type: 'item',
    limit: String(limit),
    format: 'json',
    origin: '*', // Wikidata's API needs this to answer a browser at all.
  });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${SEARCH}?${params}`, { signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    return Array.isArray(data?.search) ? data.search : [];
  } catch {
    degraded = true;
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Last resort when an author has no Open Library ID recorded on Wikidata. */
export function itemForName(name) {
  return cached(`wd:name:${name.toLowerCase()}`, async () => {
    const hits = await searchEntities(name);
    if (!hits) return null;
    // Wikidata's one-line descriptions are enough to tell a novelist from a
    // footballer of the same name.
    const person = hits.find((h) => /writer|author|novelist|poet|cartoonist|artist|journalist|screenwriter|playwright|illustrator/i.test(h.description || ''));
    const pick = person || hits[0];
    return pick?.id ? { qid: pick.id, label: pick.label || name } : null;
  });
}

// ---------- Collections: genres, awards, themes ----------

// A particular work's description opens with its year or its form — "1980
// graphic novel by Art Spiegelman" — where a category's opens with the
// category: "genre of fiction", "British literary award". That is what keeps a
// search for "maus" from offering the book as a genre.
const WORK_LIKE = /^(\d{4}\b|(graphic )?novel|novella|book|short story|poem|play|film|television|tv\b|video game|album|song|single|series|manga|comic|painting|essay|anthology|collection)/i;

/**
 * The vocabularies a map can be drawn from. Each is a property recorded on
 * works, and a map of one value is every work carrying it. The description
 * patterns are how a name typed into a URL or the search box is told apart
 * from its namesakes: "fantasy" is a genre, a film and a band, and Wikidata's
 * one-line descriptions say which.
 */
const COLLECTIONS = {
  genre: {
    property: 'P136',
    reject: /disambiguation|film|television|video game|album|band|magazine|painting|award|prize/i,
    prefer: /\bgenre\b|subgenre|\b(fiction|literature|literary|poetry|drama|comics)\b/i,
    works: false,
  },
  award: {
    property: 'P166',
    reject: /disambiguation|film festival|music|song|album|sport|football/i,
    prefer: /\b(awards?|prize|medal|honou?rs?|list)\b/i,
    works: false,
  },
  theme: {
    property: 'P921',
    // Nearly anything can be a book's main subject — a play, a war, a person —
    // so only the obvious non-topics are turned away.
    reject: /disambiguation|family name|given name|film|television|video game|album|song/i,
    prefer: null,
    works: true,
  },
};

export const isCollectionKind = (kind) => Object.prototype.hasOwnProperty.call(COLLECTIONS, kind);

/** Whether a search hit's one-line description reads as this kind of thing. */
function describedAs(spec, hit) {
  const description = hit?.description || '';
  if (!description || spec.reject.test(description)) return false;
  if (!spec.works && WORK_LIKE.test(description)) return false;
  return !spec.prefer || spec.prefer.test(description);
}

/** What kind of collection a search hit is, by its description, or null. Themes aren't guessed at. */
function kindOfHit(hit) {
  if (describedAs(COLLECTIONS.award, hit)) return 'award';
  if (describedAs(COLLECTIONS.genre, hit)) return 'genre';
  return null;
}

/**
 * A genre, award or theme named in a URL rather than identified. The same name
 * usually sits on several items, so the description decides; failing that,
 * Wikidata's own first choice, since a name typed out in full is usually exact.
 */
export function collectionByName(kind, name) {
  const spec = COLLECTIONS[kind];
  if (!spec) return Promise.resolve(null);
  return cached(`wd:byName:${kind}:${name.toLowerCase()}`, async () => {
    const hits = await searchEntities(name, 7);
    if (!hits) return null;
    const preferred = hits.find((h) => describedAs(spec, h));
    const passable = hits.find((h) => !spec.reject.test(h?.description || ''));
    const pick = preferred || passable || hits[0];
    return pick?.id ? { qid: pick.id, label: pick.label || name } : null;
  });
}

/**
 * Genres and awards matching what's being typed, for the search box. Themes
 * are left out on purpose: nearly any item on Wikidata could be one, so
 * offering them would mean offering a map for every name that matched.
 * Returns `[{ kind, qid, label, description }]`, empty when nothing fits or
 * Wikidata couldn't be asked.
 */
export function searchCollections(query, limit = 3) {
  const text = String(query || '').trim();
  if (text.length < 3) return Promise.resolve([]);
  return cached(`wd:search:${text.toLowerCase()}`, async () => {
    const hits = await searchEntities(text, 7);
    if (!hits) return [];
    const out = [];
    for (const hit of hits) {
      const kind = kindOfHit(hit);
      if (!kind || !hit.id || !hit.label) continue;
      out.push({ kind, qid: hit.id, label: hit.label, description: hit.description || '' });
      if (out.length >= limit) break;
    }
    return out;
  });
}

// How many rows a collection query may return. Big genres run to thousands of
// works with an Open Library ID; the best-known few hundred are more than a
// map holds.
const COLLECTION_ROWS = 200;

/**
 * A vocabulary run backwards: every work Wikidata files under one genre,
 * award or main subject that also carries an Open Library work ID. That is a
 * subject map from a vocabulary no library has, and it reaches every book
 * Wikidata knows rather than the half of a map that happens to resolve.
 *
 * Rows come best known first, judged by how many Wikipedias have an article
 * on the work. P648 is also recorded on writers and on single editions, and
 * both are left out here: this map is books. One item can carry several work
 * IDs (Dune has three), so the caller gets every key and decides. An award
 * carries the year it was given, where Wikidata recorded one.
 *
 * Returns `{ label, works, truncated }`, where each work is
 * `{ qid, label, key, sitelinks, year }`, or null when the service couldn't
 * be reached.
 */
export function worksUnder(kind, qid) {
  const spec = COLLECTIONS[kind];
  if (!spec || !/^Q\d+$/.test(qid || '')) return Promise.resolve({ label: '', works: [], truncated: false });

  return cached(`wd:under:${kind}:${qid}`, async () => {
    // Full statements rather than the `wdt:` shortcut, so the award's date
    // qualifier is in reach; statements editors have marked as wrong are skipped.
    const rows = await runQuery(`
      SELECT ?collectionLabel ?item ?itemLabel ?ol ?sitelinks ?when WHERE {
        VALUES ?collection { wd:${qid} }
        ?item p:${spec.property} ?claim .
        ?claim ps:${spec.property} ?collection .
        MINUS { ?claim wikibase:rank wikibase:DeprecatedRank }
        OPTIONAL { ?claim pq:P585 ?when }
        ?item wdt:P648 ?ol .
        FILTER(STRENDS(?ol, "W"))
        OPTIONAL { ?item wikibase:sitelinks ?sitelinks }
        SERVICE wikibase:label { bd:serviceParam wikibase:language "en,mul". }
      }
      ORDER BY DESC(?sitelinks)
      LIMIT ${COLLECTION_ROWS}`);
    if (rows === null) return null;

    const works = [];
    const seen = new Map();
    let label = '';
    for (const row of rows) {
      label = label || value(row, 'collectionLabel');
      const item = qidOf(value(row, 'item'));
      const key = value(row, 'ol');
      if (!item || !/^OL\d+W$/.test(key)) continue;
      const year = yearOfTime(value(row, 'when'));
      const already = seen.get(`${item}:${key}`);
      if (already) {
        // The same book honoured twice under one award keeps its first year.
        if (year && (!already.year || year < already.year)) already.year = year;
        continue;
      }
      const work = {
        qid: item,
        label: isPlaceholder(value(row, 'itemLabel')) ? '' : value(row, 'itemLabel'),
        key,
        sitelinks: Number(value(row, 'sitelinks')) || 0,
        year,
      };
      seen.set(`${item}:${key}`, work);
      works.push(work);
    }

    // A collection with nothing under it still needs a name for the message.
    if (isPlaceholder(label)) {
      const named = await runQuery(`
        SELECT ?collectionLabel WHERE {
          VALUES ?collection { wd:${qid} }
          SERVICE wikibase:label { bd:serviceParam wikibase:language "en,mul". }
        }`);
      const found = value(named?.[0], 'collectionLabel');
      label = isPlaceholder(found) ? '' : found;
    }
    return { label, works, truncated: rows.length >= COLLECTION_ROWS };
  });
}

// ---------- Genres ----------

/**
 * Wikidata's genres for a set of Open Library works or authors, one query per
 * batch. P648 is recorded on works as well as on writers, so the same join
 * that finds an author finds a book.
 *
 * Returns a map from Open Library key to a list of `{ qid, label }`, holding
 * only the keys that resolved and carry at least one genre — or null when the
 * service couldn't be reached.
 */
export function genresFor(openLibraryKeys) {
  const keys = [...new Set(openLibraryKeys.filter(Boolean))].sort();
  if (!keys.length) return Promise.resolve(new Map());

  return cached(`wd:genres:${keys.join(',')}`, async () => {
    const found = new Map();
    let reachable = false;

    for (const batch of chunk(keys, BATCH)) {
      const rows = await runQuery(`
        SELECT ?ol ?genre ?genreLabel WHERE {
          VALUES ?ol { ${quoted(batch)} }
          ?item wdt:P648 ?ol .
          ?item wdt:P136 ?genre .
          SERVICE wikibase:label { bd:serviceParam wikibase:language "en,mul". }
        }
        LIMIT 1000`);
      if (rows === null) continue;
      reachable = true;
      for (const row of rows) {
        const key = value(row, 'ol');
        const qid = qidOf(value(row, 'genre'));
        const label = value(row, 'genreLabel');
        if (!key || !qid || isPlaceholder(label)) continue;
        const list = found.get(key) || [];
        if (!list.some((g) => g.qid === qid)) list.push({ qid, label });
        found.set(key, list);
      }
    }
    return reachable ? found : null;
  });
}

// ---------- One book ----------

/**
 * Everything Wikidata says about one book that the catalogue doesn't, in a
 * single query: when it was first published and in what language, what it's
 * about in Wikidata's own terms, what it won, what series it belongs to, and
 * where its Wikipedia article is. Each branch of the union contributes its own
 * rows rather than multiplying against the others.
 *
 * Returns null when the service couldn't be reached, and an object with empty
 * fields when Wikidata simply hasn't heard of the book.
 */
export function workFacts(key) {
  if (!/^OL\d+W$/.test(key || '')) return Promise.resolve(null);

  return cached(`wd:work:${key}`, async () => {
    const rows = await runQuery(`
      SELECT ?item ?type ?value ?valueLabel ?text ?when ?ordinal ?fame WHERE {
        VALUES ?ol { "${key}" }
        ?item wdt:P648 ?ol .
        {
          ?item wdt:P577 ?date .
          BIND("published" AS ?type)
          BIND(STR(?date) AS ?text)
        } UNION {
          ?item wdt:P407 ?value .
          BIND("language" AS ?type)
        } UNION {
          ?item wdt:P495 ?value .
          BIND("country" AS ?type)
        } UNION {
          ?item wdt:P136 ?value .
          BIND("genre" AS ?type)
        } UNION {
          ?item wdt:P921 ?value .
          BIND("theme" AS ?type)
        } UNION {
          ?item p:P166 ?claim .
          ?claim ps:P166 ?value .
          MINUS { ?claim wikibase:rank wikibase:DeprecatedRank }
          OPTIONAL { ?claim pq:P585 ?when }
          OPTIONAL { ?value wikibase:sitelinks ?fame }
          BIND("award" AS ?type)
        } UNION {
          ?item p:P179 ?claim .
          ?claim ps:P179 ?value .
          OPTIONAL { ?claim pq:P1545 ?ordinal }
          BIND("series" AS ?type)
        } UNION {
          ?article schema:about ?item ; schema:isPartOf <https://en.wikipedia.org/> .
          BIND("article" AS ?type)
          BIND(STR(?article) AS ?text)
        } UNION {
          ?item schema:description ?description .
          FILTER(LANG(?description) = "en")
          BIND("description" AS ?type)
          BIND(STR(?description) AS ?text)
        }
        SERVICE wikibase:label { bd:serviceParam wikibase:language "en,mul". }
      }
      LIMIT 300`);
    if (rows === null) return null;

    // One Open Library ID occasionally sits on two items, a work and a
    // mislinked edition. The one Wikidata has the most to say about is the work.
    const perItem = new Map();
    for (const row of rows) {
      const item = qidOf(value(row, 'item'));
      if (item) perItem.set(item, (perItem.get(item) || 0) + 1);
    }
    const qid = [...perItem.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || '';

    const facts = {
      key,
      qid,
      description: '',
      article: '',
      year: null,
      language: null,
      country: '',
      genres: [],
      themes: [],
      awards: [],
      series: null,
    };
    if (!qid) return facts;

    const awards = new Map();
    const languages = [];
    for (const row of rows) {
      if (qidOf(value(row, 'item')) !== qid) continue;
      const type = value(row, 'type');
      if (type === 'published') {
        // Several dates means several editions; the first is the publication.
        const year = yearOfTime(value(row, 'text'));
        if (year && (!facts.year || year < facts.year)) facts.year = year;
        continue;
      }
      if (type === 'description') {
        facts.description = facts.description || value(row, 'text');
        continue;
      }
      if (type === 'article') {
        facts.article = facts.article || value(row, 'text');
        continue;
      }
      const label = value(row, 'valueLabel');
      const valueQid = qidOf(value(row, 'value'));
      if (!valueQid || isPlaceholder(label)) continue;

      if (type === 'language') languages.push({ qid: valueQid, label });
      else if (type === 'country') facts.country = facts.country || label;
      else if (type === 'genre' && !facts.genres.some((g) => g.qid === valueQid)) facts.genres.push({ qid: valueQid, label });
      else if (type === 'theme' && !facts.themes.some((t) => t.qid === valueQid)) facts.themes.push({ qid: valueQid, label });
      else if (type === 'series' && !facts.series) {
        facts.series = { qid: valueQid, label, ordinal: Number(value(row, 'ordinal')) || null };
      } else if (type === 'award') {
        const year = yearOfTime(value(row, 'when'));
        const entry = awards.get(valueQid) || { qid: valueQid, label, year: null, fame: Number(value(row, 'fame')) || 0 };
        if (year && (!entry.year || year < entry.year)) entry.year = year;
        awards.set(valueQid, entry);
      }
    }

    // Nineteen Eighty-Four is recorded as written in English and in Newspeak.
    // The established languages have the low item numbers, so the lowest wins.
    languages.sort((a, b) => qidNumber(a.qid) - qidNumber(b.qid));
    facts.language = languages[0] || null;

    // The best-known awards first, so the Hugo outranks a state library's list.
    facts.awards = [...awards.values()]
      .sort((a, b) => b.fame - a.fame || (a.year ?? 9999) - (b.year ?? 9999))
      .map(({ qid: id, label, year }) => ({ qid: id, label, year }));
    return facts;
  });
}

// ---------- Influence ----------

/**
 * Every influence claim among a set of authors already on a map. P737 is
 * recorded on the influenced writer, so asking each of them who influenced them
 * finds every link where both ends are present.
 *
 * Returns `{ edges, items }`, or null when the service couldn't be reached.
 */
export function influenceAmong(openLibraryKeys) {
  const keys = [...new Set(openLibraryKeys.filter(Boolean))].sort();
  if (keys.length < 2) return Promise.resolve({ edges: [], items: new Map() });

  return cached(`wd:among:${keys.join(',')}`, async () => {
    const inSet = new Set(keys);
    const edges = [];
    const items = new Map();
    let reachable = false;

    for (const batch of chunk(keys, BATCH)) {
      const rows = await runQuery(`
        SELECT ?ol ?item ?influencer ?influencerOl WHERE {
          VALUES ?ol { ${quoted(batch)} }
          ?item wdt:P648 ?ol .
          OPTIONAL {
            ?item wdt:P737 ?influencer .
            OPTIONAL { ?influencer wdt:P648 ?influencerOl . }
          }
        }`);
      if (rows === null) continue;
      reachable = true;
      for (const row of rows) {
        const key = value(row, 'ol');
        const qid = qidOf(value(row, 'item'));
        if (key && qid) items.set(key, qid);
        const sourceKey = value(row, 'influencerOl');
        // Only links whose other end is also on this map.
        if (sourceKey && inSet.has(sourceKey) && sourceKey !== key) {
          edges.push({ from: sourceKey, to: key });
        }
      }
    }
    return reachable ? { edges, items } : null;
  });
}

/**
 * One hop of the influence network around a set of writers, in both
 * directions — who shaped them, and who they went on to shape.
 */
export function influenceNeighbours(qids) {
  const list = [...new Set(qids.filter(Boolean))].sort();
  if (!list.length) return Promise.resolve([]);

  return cached(`wd:hop:${list.join(',')}`, async () => {
    const edges = [];
    let reachable = false;

    for (const batch of chunk(list, BATCH)) {
      const rows = await runQuery(`
        SELECT DISTINCT ?from ?fromLabel ?fromOl ?to ?toLabel ?toOl WHERE {
          VALUES ?anchor { ${entities(batch)} }
          { ?anchor wdt:P737 ?from . BIND(?anchor AS ?to) }
          UNION
          { ?to wdt:P737 ?anchor . BIND(?anchor AS ?from) }
          OPTIONAL { ?from wdt:P648 ?fromOl . }
          OPTIONAL { ?to wdt:P648 ?toOl . }
          SERVICE wikibase:label { bd:serviceParam wikibase:language "en,mul". }
        }
        LIMIT 500`);
      if (rows === null) continue;
      reachable = true;
      for (const row of rows) {
        const from = qidOf(value(row, 'from'));
        const to = qidOf(value(row, 'to'));
        if (!from || !to || from === to) continue;
        edges.push({
          from: { qid: from, label: value(row, 'fromLabel'), openLibrary: value(row, 'fromOl') },
          to: { qid: to, label: value(row, 'toLabel'), openLibrary: value(row, 'toOl') },
        });
      }
    }
    // An anchor is already on the caller's map under a name it trusts, so an
    // unlabelled anchor is harmless; only an unlabelled stranger is unusable.
    const anchors = new Set(list);
    const usable = (end) => anchors.has(end.qid) || !isPlaceholder(end.label);
    return reachable ? edges.filter((e) => usable(e.from) && usable(e.to)) : null;
  });
}

// Writers collect honours of every kind — doctorates, orders, fellowships.
// Only the ones that are about the writing are shown.
const LITERARY_HONOUR = /prize|award|medal/i;

/**
 * Everything worth showing about one writer, in a single query. Each branch of
 * the union contributes its own rows rather than multiplying against the
 * others, which keeps a writer with four genres and thirty influences from
 * returning a hundred and twenty rows of the same four genres.
 */
export function authorFacts(qid) {
  if (!qid) return Promise.resolve(null);

  return cached(`wd:facts:${qid}`, async () => {
    const rows = await runQuery(`
      SELECT ?type ?value ?valueLabel ?valueOl ?text ?when ?fame WHERE {
        VALUES ?item { wd:${qid} }
        {
          ?item wdt:P737 ?value .
          BIND("influencedBy" AS ?type)
          OPTIONAL { ?value wdt:P648 ?valueOl . }
        } UNION {
          ?value wdt:P737 ?item .
          BIND("influenced" AS ?type)
          OPTIONAL { ?value wdt:P648 ?valueOl . }
        } UNION {
          ?item wdt:P136 ?value .
          BIND("genre" AS ?type)
        } UNION {
          ?item wdt:P135 ?value .
          BIND("movement" AS ?type)
        } UNION {
          ?item p:P166 ?claim .
          ?claim ps:P166 ?value .
          MINUS { ?claim wikibase:rank wikibase:DeprecatedRank }
          OPTIONAL { ?claim pq:P585 ?when }
          OPTIONAL { ?value wikibase:sitelinks ?fame }
          BIND("award" AS ?type)
        } UNION {
          ?article schema:about ?item ; schema:isPartOf <https://en.wikipedia.org/> .
          BIND("article" AS ?type)
          BIND(STR(?article) AS ?text)
        } UNION {
          ?item schema:description ?description .
          FILTER(LANG(?description) = "en")
          BIND("description" AS ?type)
          BIND(STR(?description) AS ?text)
        }
        SERVICE wikibase:label { bd:serviceParam wikibase:language "en,mul". }
      }
      LIMIT 400`);
    if (rows === null) return null;

    const facts = {
      qid,
      description: '',
      article: '',
      genres: [],
      movements: [],
      awards: [],
      influencedBy: [],
      influenced: [],
    };
    const seen = new Set();
    const awards = new Map();

    for (const row of rows) {
      const type = value(row, 'type');
      if (type === 'description') {
        facts.description = facts.description || value(row, 'text');
        continue;
      }
      if (type === 'article') {
        facts.article = facts.article || value(row, 'text');
        continue;
      }
      const label = value(row, 'valueLabel');
      if (isPlaceholder(label)) continue;

      if (type === 'award') {
        if (!LITERARY_HONOUR.test(label)) continue;
        const id = qidOf(value(row, 'value'));
        const year = yearOfTime(value(row, 'when'));
        const entry = awards.get(id) || { qid: id, label, years: [], fame: Number(value(row, 'fame')) || 0 };
        if (year && !entry.years.includes(year)) entry.years.push(year);
        awards.set(id, entry);
        continue;
      }

      const dedupe = `${type}:${label.toLowerCase()}`;
      if (seen.has(dedupe)) continue;
      seen.add(dedupe);

      if (type === 'genre') facts.genres.push(label);
      else if (type === 'movement') facts.movements.push(label);
      else if (type === 'influencedBy' || type === 'influenced') {
        facts[type].push({
          qid: qidOf(value(row, 'value')),
          name: label,
          openLibrary: value(row, 'valueOl'),
        });
      }
    }

    facts.genres = facts.genres.slice(0, 6);
    facts.movements = facts.movements.slice(0, 4);
    // Best known first, so a Nobel leads and a regional prize trails.
    facts.awards = [...awards.values()]
      .sort((a, b) => b.fame - a.fame)
      .slice(0, 5)
      .map(({ qid: id, label, years }) => ({ qid: id, label, years: years.sort((a, b) => a - b) }));
    facts.influencedBy.sort((a, b) => a.name.localeCompare(b.name));
    facts.influenced.sort((a, b) => a.name.localeCompare(b.name));
    return facts;
  });
}
