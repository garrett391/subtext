import { cached } from './cache.js';

/**
 * Open Library knows what books are about. It doesn't know who read whom.
 * Wikidata does: property P737, "influenced by", is an editorially curated
 * claim that one writer shaped another, and it's the one piece of this app that
 * couldn't be reconstructed from a catalogue. Wikidata also files works under a
 * controlled vocabulary of genres (P136), which is a third opinion on what a
 * book is beside its subject headings and its call number.
 *
 * The join between the two is property P648, "Open Library ID", which Wikidata
 * records for tens of thousands of authors. That's what lets an author found on
 * Open Library be looked up here without guessing at names.
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

/** Last resort when an author has no Open Library ID recorded on Wikidata. */
export function itemForName(name) {
  return cached(`wd:name:${name.toLowerCase()}`, async () => {
    const params = new URLSearchParams({
      action: 'wbsearchentities',
      search: name,
      language: 'en',
      uselang: 'en',
      type: 'item',
      limit: '5',
      format: 'json',
      origin: '*', // Wikidata's API needs this to answer a browser at all.
    });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(`${SEARCH}?${params}`, { signal: controller.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const hits = Array.isArray(data?.search) ? data.search : [];
      // Wikidata's one-line descriptions are enough to tell a novelist from a
      // footballer of the same name.
      const person = hits.find((h) => /writer|author|novelist|poet|cartoonist|artist|journalist|screenwriter|playwright|illustrator/i.test(h.description || ''));
      const pick = person || hits[0];
      return pick?.id ? { qid: pick.id, label: pick.label || name } : null;
    } catch {
      degraded = true;
      return null;
    } finally {
      clearTimeout(timer);
    }
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
      SELECT ?type ?value ?valueLabel ?valueOl ?text WHERE {
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
      influencedBy: [],
      influenced: [],
    };
    const seen = new Set();

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
    facts.influencedBy.sort((a, b) => a.name.localeCompare(b.name));
    facts.influenced.sort((a, b) => a.name.localeCompare(b.name));
    return facts;
  });
}
