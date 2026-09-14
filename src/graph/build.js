import Graph from 'graphology';
import * as ol from '../api/openlibrary.js';
import * as wd from '../api/wikidata.js';
import { smoothestPath } from './analysis.js';
import {
  vectorOf,
  normOf,
  similarity,
  sharedFacets,
  distinctiveSubjects,
  normalizeSubject,
  facetWeight,
} from './subjects.js';
import { parseShelf, shelfAgreement, lengthFactor } from './classification.js';

// Thrown when a newer search replaces the one in progress.
export class StaleError extends Error {}
// Thrown when there's too little data to draw a map.
export class EmptyMapError extends Error {}

export const bookId = (key) => 'w:' + key;
export const authorId = (key) => 'p:' + key;

const rethrowStale = (err) => {
  if (err instanceof StaleError) throw err;
};

/**
 * How common each subject is, learned as the session goes. Every subject search
 * reports how many books carry that heading, and a heading on ten books is a
 * far stronger signal than one on ten thousand. Later maps are sharper than
 * earlier ones because of what earlier ones turned up.
 */
const subjectCounts = new Map();

function rememberCount(subject, workCount) {
  const facet = normalizeSubject(subject);
  if (facet && workCount > 0) subjectCounts.set(facet, workCount);
}

// ---------- Graph helpers ----------

const MAX_LINKS_PER_NODE = 6;
const MIN_LINK = 0.15;
const SAME_AUTHOR_LINK = 0.42;

// Kept modest: cataloguing is uneven enough that a call number is a second
// opinion, not a verdict.
const SHELF_WEIGHT = 0.22;

/**
 * Folds shelf and length into a score already computed from subjects. When a
 * book has no call number — about one in ten, and everything from the subjects
 * endpoint — the shelf term is dropped rather than zeroed, leaving the subject
 * score on its own scale. Zeroing would push exactly the books with the
 * thinnest metadata off the map.
 */
function withShelf(base, a, b) {
  const agreement = shelfAgreement(a?.shelf, b?.shelf);
  const blended = agreement == null ? base : (1 - SHELF_WEIGHT) * base + SHELF_WEIGHT * agreement;
  return blended * lengthFactor(a?.pages, b?.pages);
}

function bookNode(book, score, hop, extra = {}) {
  const vector = vectorOf(book.subjects, subjectCounts);
  return {
    kind: 'book',
    key: book.key,
    label: book.title,
    byline: ol.byline(book),
    authors: book.authors || [],
    year: book.year ?? null,
    coverId: book.coverId ?? null,
    editions: book.editions ?? 0,
    rating: book.rating ?? null,
    subjects: book.subjects || [],
    shelf: parseShelf(book.lcc, book.ddc),
    pages: book.pages ?? null,
    vector,
    norm: normOf(vector),
    score,
    hop,
    ...extra,
  };
}

function authorNode(author, score, hop, extra = {}) {
  const vector = author.vector || vectorOf(author.subjects, subjectCounts);
  return {
    kind: 'author',
    key: author.key,
    label: author.name,
    byline: '',
    qid: author.qid || null,
    subjects: author.subjects || [],
    works: author.works || [],
    vector,
    norm: normOf(vector),
    score,
    hop,
    ...extra,
  };
}

function upsertNode(g, id, attrs) {
  if (!g.hasNode(id)) {
    g.addNode(id, attrs);
    return true;
  }
  const current = g.getNodeAttributes(id);
  g.mergeNodeAttributes(id, {
    score: Math.max(current.score ?? 0, attrs.score ?? 0),
    hop: Math.min(current.hop ?? 9, attrs.hop ?? 9),
    // A record built from a fuller source replaces a thinner one.
    subjects: (attrs.subjects?.length ?? 0) > (current.subjects?.length ?? 0) ? attrs.subjects : current.subjects,
    vector: (attrs.vector?.size ?? 0) > (current.vector?.size ?? 0) ? attrs.vector : current.vector,
    norm: (attrs.vector?.size ?? 0) > (current.vector?.size ?? 0) ? attrs.norm : current.norm,
    coverId: current.coverId ?? attrs.coverId ?? null,
    byline: current.byline || attrs.byline || '',
    // A book first seen through the subjects endpoint arrives unshelved; if it
    // turns up again from search, that's where the call numbers come from.
    shelf: current.shelf ?? attrs.shelf ?? null,
    pages: current.pages ?? attrs.pages ?? null,
  });
  return false;
}

function upsertEdge(g, a, b, weight, extra = null) {
  if (a === b || !g.hasNode(a) || !g.hasNode(b)) return;
  const w = Math.max(0.02, Math.min(1, weight));
  const edge = g.edge(a, b);
  if (!edge) {
    g.addEdge(a, b, { weight: w, ...(extra || {}) });
    return;
  }
  if (w > g.getEdgeAttribute(edge, 'weight')) g.setEdgeAttribute(edge, 'weight', w);
  if (extra) g.mergeEdgeAttributes(edge, extra);
}

const sharesAuthor = (a, b) => {
  const mine = new Set((a.authors || []).map((x) => x.key).filter(Boolean));
  return (b.authors || []).some((x) => x.key && mine.has(x.key));
};

/**
 * Draws the links between everything on a map. Because similarity here is
 * computed from subject lists Subtext already holds, this costs nothing —
 * unlike a recommendation API, where every connection is another request.
 *
 * Each node keeps only its strongest few links, which is what separates a map
 * you can read from a ball of yarn.
 */
function weave(g, { maxLinks = MAX_LINKS_PER_NODE, minLink = MIN_LINK, skipSeedPairs = true } = {}) {
  const nodes = g.mapNodes((id, attrs) => ({
    id,
    vector: attrs.vector,
    norm: attrs.norm,
    authors: attrs.authors,
    shelf: attrs.shelf,
    pages: attrs.pages,
    seed: attrs.seed,
  }));

  for (const node of nodes) {
    const scored = [];
    for (const other of nodes) {
      if (other.id === node.id) continue;
      if (skipSeedPairs && other.seed) continue; // The seed is already linked to everything.
      // Author nodes carry no shelf, so this falls through to the subject
      // score untouched on author and influence maps.
      let weight = withShelf(similarity(node.vector, other.vector, node.norm, other.norm), node, other);
      if (sharesAuthor(node, other)) weight = Math.max(weight, SAME_AUTHOR_LINK);
      if (weight >= minLink) scored.push({ id: other.id, weight });
    }
    scored.sort((a, b) => b.weight - a.weight);
    for (const link of scored.slice(0, maxLinks)) upsertEdge(g, node.id, link.id, link.weight);
  }
}

/** What two nodes have in common, in words, for the details panel. */
export function connectionBetween(g, a, b) {
  if (!g.hasNode(a) || !g.hasNode(b)) return [];
  const left = g.getNodeAttributes(a);
  const right = g.getNodeAttributes(b);
  return sharedFacets(left.vector, right.vector, 4);
}

// ---------- Fetching by subject ----------

/**
 * Asks Open Library for the books under each of a set of subjects. A subject
 * with no results through the search index is tried again through the subjects
 * endpoint, which spells some headings differently.
 */
async function gatherBySubjects(picks, ctx, { perSubject = 40, verb = 'Reading' } = {}) {
  const lists = [];
  let done = 0;

  await Promise.all(
    picks.map(async (pick) => {
      const subject = pick.subject ?? pick;
      let result = null;
      try {
        result = await ol.booksBySubject(subject, perSubject);
      } catch (err) {
        rethrowStale(err);
      }
      ctx.check();
      if (!result || !result.books.length) {
        try {
          result = await ol.subjectWorks(subject, perSubject);
        } catch (err) {
          rethrowStale(err);
          return;
        }
      }
      ctx.check();
      if (!result?.books.length) return;

      rememberCount(subject, result.workCount);
      lists.push({
        subject,
        weight: pick.weight ?? facetWeight(normalizeSubject(subject), subjectCounts),
        workCount: result.workCount,
        books: result.books,
      });
      done += 1;
      ctx.progress(`${verb} ${done} of ${picks.length} subjects`);
    }),
  );

  return lists.sort((a, b) => b.weight - a.weight);
}

/** Books near the top of a subject list count for more than books near the bottom. */
const rankFactor = (index, length) => 0.55 + 0.45 * (1 - index / Math.max(1, length));

/**
 * A long series is catalogued a volume at a time with the same headings on
 * each, so one manga can take twenty-eight of the forty places under a heading.
 * A writer's first two count in full, then each counts for less than the last.
 * Only within one list: turning up under five of the seed's subjects is earned.
 */
export const authorDamping = (nth) => (nth <= 2 ? 1 : 2 / nth);

/** Counts how many times each writer has appeared so far in one list. */
function dampingFor(book, seenAuthors) {
  let factor = 1;
  for (const author of book.authors || []) {
    if (!author.key) continue;
    const nth = (seenAuthors.get(author.key) || 0) + 1;
    seenAuthors.set(author.key, nth);
    factor = Math.min(factor, authorDamping(nth));
  }
  return factor;
}

/**
 * Collects every book that turned up under any of the subjects searched, and
 * scores it on how many of them it appeared under and how high.
 */
function tallyBooks(lists, { exclude = new Set() } = {}) {
  const tally = new Map();
  for (const list of lists) {
    const seenAuthors = new Map();
    list.books.forEach((book, index) => {
      if (exclude.has(book.key)) return;
      const entry = tally.get(book.key) || { book, weight: 0, matches: 0, subjects: [] };
      entry.weight += list.weight * rankFactor(index, list.books.length) * dampingFor(book, seenAuthors);
      entry.matches += 1;
      entry.subjects.push(list.subject);
      // A fuller record wins: search results vary in how much they carry.
      if ((book.subjects?.length ?? 0) > (entry.book.subjects?.length ?? 0)) entry.book = book;
      tally.set(book.key, entry);
    });
  }
  return tally;
}

// ---------- Book maps ----------

const BOOK_SUBJECTS = 7;
const BOOK_NEIGHBOURS = 26;

/**
 * Books like this book. Open Library has no "similar" endpoint, so the map is
 * built the long way round: take the subjects that make this book specific,
 * read what else is filed under each, and rank what comes back by how much of
 * the book's subject profile it shares.
 */
export async function buildBookMap(key, ctx) {
  ctx.progress('Looking up the book');
  let seed;
  try {
    seed = await ol.bookByKey(key);
  } catch (err) {
    if (err.notFound) throw new EmptyMapError(`Open Library has no work with the ID ${key}. Search for the title instead.`);
    throw err;
  }
  ctx.check();

  const picks = distinctiveSubjects(seed.subjects, subjectCounts, BOOK_SUBJECTS);
  if (!picks.length) {
    throw new EmptyMapError(
      `Open Library has no subjects on record for “${seed.title}”, so there's nothing to match it against. Try mapping ${ol.byline(seed) || 'its author'} instead.`,
    );
  }

  // Draw the seed straight away, so there's something on screen while the
  // subject searches run.
  const g = new Graph({ type: 'undirected' });
  const seedId = bookId(seed.key);
  g.addNode(seedId, bookNode(seed, 1, 0, { seed: true }));
  ctx.update(g, { fresh: true, centerId: seedId });

  ctx.progress(`Reading what else is filed under ${picks[0].subject.toLowerCase()}`);
  const lists = await gatherBySubjects(picks, ctx, { perSubject: 40 });
  ctx.check();
  if (!lists.length) {
    throw new EmptyMapError(
      `None of the subjects on “${seed.title}” returned other books. It may be catalogued with headings nothing else uses.`,
    );
  }

  const seedVector = vectorOf(seed.subjects, subjectCounts);
  const seedNorm = normOf(seedVector);
  const tally = tallyBooks(lists, { exclude: new Set([seed.key]) });
  const topWeight = Math.max(...[...tally.values()].map((e) => e.weight), 0.001);

  const seedShelf = { shelf: parseShelf(seed.lcc, seed.ddc), pages: seed.pages ?? null };

  const ranked = [...tally.values()]
    .map((entry) => {
      const vector = vectorOf(entry.book.subjects, subjectCounts);
      const overlap = similarity(seedVector, vector, seedNorm, normOf(vector));
      const spread = entry.weight / topWeight;
      const candidate = { shelf: parseShelf(entry.book.lcc, entry.book.ddc), pages: entry.book.pages ?? null };
      let score = withShelf(0.62 * overlap + 0.38 * spread, seedShelf, candidate);
      // Another book by the same hand belongs on the map even when the
      // cataloguing doesn't quite agree.
      if (sharesAuthor(seed, entry.book)) score = Math.max(score, 0.55);
      return { ...entry, score };
    })
    .sort((a, b) => b.score - a.score || b.book.editions - a.book.editions)
    .slice(0, BOOK_NEIGHBOURS);

  const best = ranked[0]?.score || 1;
  for (const entry of ranked) {
    const id = bookId(entry.book.key);
    upsertNode(g, id, bookNode(entry.book, Math.min(1, entry.score / best), 1, { matches: entry.matches }));
    upsertEdge(g, seedId, id, Math.max(0.1, entry.score));
  }

  ctx.progress('Connecting the map');
  weave(g);
  ctx.update(g, { centerId: seedId });

  return { graph: g, seedId, seed, seedLabel: seed.title, seedSubtitle: ol.byline(seed), subjects: picks };
}

// ---------- Author maps ----------

const AUTHOR_NEIGHBOURS = 24;

/** An author's subject profile, built from everything they've written. */
function subjectsOfWorks(works) {
  const counted = new Map();
  works.forEach((work, index) => {
    const weight = 0.5 + 0.5 * (1 - index / Math.max(1, works.length));
    for (const subject of work.subjects || []) {
      const facet = normalizeSubject(subject);
      if (!facet) continue;
      counted.set(facet, (counted.get(facet) || 0) + weight);
    }
  });
  return [...counted.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 40)
    .map(([facet]) => facet);
}

export async function buildAuthorMap(key, ctx) {
  ctx.progress('Looking up the author');
  let author;
  try {
    author = await ol.authorByKey(key);
  } catch (err) {
    if (err.notFound) throw new EmptyMapError(`Open Library has no author with the ID ${key}. Search for the name instead.`);
    throw err;
  }
  ctx.check();

  const works = await ol.authorWorks(key, 50);
  ctx.check();
  if (!works.length) {
    throw new EmptyMapError(`Open Library lists no books for ${author.name}, so there's nothing to map them against.`);
  }

  const profile = subjectsOfWorks(works);
  const picks = distinctiveSubjects(profile, subjectCounts, BOOK_SUBJECTS);
  if (!picks.length) {
    throw new EmptyMapError(
      `Open Library has no subjects on record for ${author.name}'s books, so there's nothing to match them against.`,
    );
  }

  const g = new Graph({ type: 'undirected' });
  const seedId = authorId(author.key);
  g.addNode(
    seedId,
    authorNode({ ...author, subjects: profile, works: works.slice(0, 12) }, 1, 0, { seed: true }),
  );
  ctx.update(g, { fresh: true, centerId: seedId });

  ctx.progress(`Reading who else writes about ${picks[0].subject.toLowerCase()}`);
  const lists = await gatherBySubjects(picks, ctx, { perSubject: 50 });
  ctx.check();
  if (!lists.length) {
    throw new EmptyMapError(`None of the subjects on ${author.name}'s books returned other writers.`);
  }

  // Gather the authors behind everything that came back, and remember which of
  // their books put them on this map.
  const tally = new Map();
  for (const list of lists) {
    // A writer's twenty-eighth volume under a heading says no more about them
    // than their second did.
    const seenAuthors = new Map();
    list.books.forEach((book, index) => {
      const factor = list.weight * rankFactor(index, list.books.length) * dampingFor(book, seenAuthors);
      for (const person of book.authors || []) {
        if (!person.key || person.key === author.key || !person.name) continue;
        const entry = tally.get(person.key) || {
          key: person.key,
          name: person.name,
          weight: 0,
          matches: new Set(),
          works: [],
          subjects: new Map(),
        };
        entry.weight += factor;
        entry.matches.add(list.subject);
        if (entry.works.length < 8 && !entry.works.some((w) => w.key === book.key)) entry.works.push(book);
        for (const subject of book.subjects || []) {
          const facet = normalizeSubject(subject);
          if (facet) entry.subjects.set(facet, (entry.subjects.get(facet) || 0) + 1);
        }
        tally.set(person.key, entry);
      }
    });
  }

  if (!tally.size) {
    throw new EmptyMapError(`No other writers turned up under the subjects on ${author.name}'s books.`);
  }

  const seedVector = vectorOf(profile, subjectCounts);
  const seedNorm = normOf(seedVector);
  const topWeight = Math.max(...[...tally.values()].map((e) => e.weight), 0.001);

  const ranked = [...tally.values()]
    .map((entry) => {
      const subjects = [...entry.subjects.entries()].sort((a, b) => b[1] - a[1]).slice(0, 36).map(([f]) => f);
      const vector = vectorOf(subjects, subjectCounts);
      const overlap = similarity(seedVector, vector, seedNorm, normOf(vector));
      const spread = entry.weight / topWeight;
      return { ...entry, subjects, vector, score: 0.55 * overlap + 0.45 * spread };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, AUTHOR_NEIGHBOURS);

  const best = ranked[0]?.score || 1;
  for (const entry of ranked) {
    const id = authorId(entry.key);
    upsertNode(
      g,
      id,
      authorNode(
        { key: entry.key, name: entry.name, subjects: entry.subjects, works: entry.works, vector: entry.vector },
        Math.min(1, entry.score / best),
        1,
        { matches: entry.matches.size },
      ),
    );
    upsertEdge(g, seedId, id, Math.max(0.1, entry.score));
  }

  ctx.progress('Connecting the map');
  weave(g);
  ctx.update(g, { centerId: seedId });

  // Influence is a different kind of claim from shared subject matter, and it
  // arrives from a different place. The map is already usable without it, so
  // it's added once it turns up rather than waited for.
  addInfluenceOverlay(g, ctx).catch(() => {});

  return { graph: g, seedId, author, seedLabel: author.name, subjects: picks };
}

/**
 * Lays Wikidata's influence claims over a map of authors. Returns how many
 * links were drawn, or null if Wikidata couldn't be reached.
 */
async function addInfluenceOverlay(g, ctx) {
  const keys = g
    .filterNodes((_id, attrs) => attrs.kind === 'author' && /^OL\d+A$/.test(attrs.key || ''))
    .map((id) => g.getNodeAttribute(id, 'key'));
  if (keys.length < 2) return 0;

  const result = await wd.influenceAmong(keys);
  if (!result) return null;
  ctx.check();

  for (const [key, qid] of result.items) {
    const id = authorId(key);
    if (g.hasNode(id)) g.setNodeAttribute(id, 'qid', qid);
  }

  let drawn = 0;
  for (const edge of result.edges) {
    const from = authorId(edge.from);
    const to = authorId(edge.to);
    if (!g.hasNode(from) || !g.hasNode(to)) continue;
    // An influence link is a stronger statement than a shared shelf, so it
    // outranks whatever the subject overlap said.
    upsertEdge(g, from, to, 0.85, { influence: true, from, to });
    drawn += 1;
  }
  if (drawn) ctx.update(g);
  return drawn;
}

// ---------- Subject maps ----------

const SUBJECT_BOOKS = 30;

export async function buildSubjectMap(subjects, ctx) {
  const listFormat = new Intl.ListFormat('en', { type: 'conjunction' });
  ctx.progress(`Reading what's filed under ${listFormat.format(subjects)}`);

  const picks = subjects.map((subject) => ({
    subject,
    weight: facetWeight(normalizeSubject(subject), subjectCounts),
  }));
  const lists = await gatherBySubjects(picks, ctx, { perSubject: 50, verb: 'Read' });
  ctx.check();

  if (!lists.length) {
    throw new EmptyMapError(
      `Open Library has nothing filed under ${listFormat.format(subjects.map((s) => `“${s}”`))}. Library subjects are often phrased oddly — try “graphic novels” or “comic books, strips, etc”.`,
    );
  }

  const tally = tallyBooks(lists);
  const topWeight = Math.max(...[...tally.values()].map((e) => e.weight), 0.001);

  const ranked = [...tally.values()]
    .map((entry) => ({
      ...entry,
      // Books that answer to several of the subjects asked for rank above books
      // that answer to one of them loudly.
      score: (entry.matches / subjects.length) * (0.45 + 0.55 * (entry.weight / topWeight)),
    }))
    .sort((a, b) => b.score - a.score || b.book.editions - a.book.editions)
    .slice(0, SUBJECT_BOOKS);

  const g = new Graph({ type: 'undirected' });
  const best = ranked[0]?.score || 1;
  for (const entry of ranked) {
    upsertNode(
      g,
      bookId(entry.book.key),
      bookNode(entry.book, Math.min(1, entry.score / best), 1, { matches: entry.matches }),
    );
  }
  ctx.update(g, { fresh: true, centerId: null });

  ctx.progress('Connecting the map');
  weave(g, { skipSeedPairs: false, maxLinks: 7 });
  ctx.update(g, { centerId: null });

  return {
    graph: g,
    seedId: null,
    seedLabel: null,
    counts: lists.map((l) => ({ subject: l.subject, workCount: l.workCount })),
  };
}

// ---------- Influence maps ----------

const INFLUENCE_MAX_NODES = 70;
const INFLUENCE_EXPAND = 16;

/** Finds the Wikidata item for an Open Library author, trying the cheapest route first. */
async function itemForAuthor(author) {
  if (author.wikidata) return { qid: author.wikidata, label: author.name };
  const mapped = await wd.itemsForAuthors([author.key]);
  if (mapped?.get(author.key)) return mapped.get(author.key);
  return wd.itemForName(author.name);
}

/**
 * Who shaped this writer, and whom they shaped in turn. This is the one map
 * here that isn't built from what books are about: Wikidata's P737 is an
 * editorial claim that one writer read another and it shows, which is a
 * different and more arguable kind of statement. It's drawn with arrows for
 * that reason — every other line on every other map is a symmetric resemblance.
 *
 * Nodes carry a generation: writers who came before sit left of the seed,
 * writers who came after sit right, so a map reads as a line of descent.
 */
export async function buildInfluenceMap(key, ctx) {
  ctx.progress('Looking up the author');
  let author;
  try {
    author = await ol.authorByKey(key);
  } catch (err) {
    if (err.notFound) throw new EmptyMapError(`Open Library has no author with the ID ${key}.`);
    throw err;
  }
  ctx.check();

  ctx.progress(`Finding ${author.name} on Wikidata`);
  const item = await itemForAuthor(author);
  ctx.check();
  if (!item?.qid) {
    throw new EmptyMapError(
      `Wikidata has no entry linked to ${author.name}, and influence comes from Wikidata. Map their subjects instead, or try a better-documented writer.`,
    );
  }

  ctx.progress(`Tracing influence around ${author.name}`);
  const firstHop = await wd.influenceNeighbours([item.qid]);
  ctx.check();
  if (firstHop === null) {
    throw new EmptyMapError(
      "Wikidata's query service didn't answer. It's free and sometimes busy — wait a moment and try again. Subject maps don't depend on it.",
    );
  }
  if (!firstHop.length) {
    throw new EmptyMapError(
      `Wikidata records no influence either way for ${author.name}. Its coverage is deep for some writers and empty for others. Map their subjects instead.`,
    );
  }

  const g = new Graph({ type: 'undirected' });
  const byQid = new Map();

  const place = (person, generation) => {
    const nodeKey = person.openLibrary || person.qid;
    const id = authorId(nodeKey);
    if (!g.hasNode(id)) {
      g.addNode(id, {
        kind: 'author',
        key: nodeKey,
        qid: person.qid,
        openLibrary: person.openLibrary || null,
        label: person.label || person.name,
        byline: '',
        subjects: [],
        vector: new Map(),
        norm: 1,
        score: 0.5,
        hop: Math.abs(generation),
        gen: Math.max(-2, Math.min(2, generation)),
      });
      byQid.set(person.qid, id);
    }
    return id;
  };

  const seedId = place({ qid: item.qid, label: item.label || author.name, openLibrary: author.key }, 0);
  g.mergeNodeAttributes(seedId, { seed: true, score: 1, gen: 0, hop: 0 });
  byQid.set(item.qid, seedId);

  const absorb = (edges, generationOf) => {
    for (const edge of edges) {
      if (g.order >= INFLUENCE_MAX_NODES && !byQid.has(edge.from.qid) && !byQid.has(edge.to.qid)) continue;
      const fromId = place(edge.from, generationOf(edge.from.qid, edge.to.qid, 'from'));
      const toId = place(edge.to, generationOf(edge.from.qid, edge.to.qid, 'to'));
      if (fromId === toId) continue;
      upsertEdge(g, fromId, toId, 0.85, { influence: true, from: fromId, to: toId });
    }
  };

  // Around the seed, an influencer is one generation back and someone the seed
  // influenced is one forward.
  absorb(firstHop, (fromQid, toQid, side) => {
    if (side === 'from') return fromQid === item.qid ? 0 : -1;
    return toQid === item.qid ? 0 : 1;
  });
  ctx.update(g, { fresh: true, centerId: seedId });

  // A second hop, which is where a map stops being a list and starts being a
  // lineage: the writers your writer read, and what they read in turn.
  const frontier = g
    .filterNodes((id, attrs) => id !== seedId && attrs.qid)
    .slice(0, INFLUENCE_EXPAND)
    .map((id) => g.getNodeAttribute(id, 'qid'));

  if (frontier.length && g.order < INFLUENCE_MAX_NODES) {
    ctx.progress('Following the line back another generation');
    const secondHop = await wd.influenceNeighbours(frontier);
    ctx.check();
    if (secondHop?.length) {
      const generationAt = (qid) => {
        const id = byQid.get(qid);
        return id ? g.getNodeAttribute(id, 'gen') ?? 0 : null;
      };
      absorb(secondHop, (fromQid, toQid, side) => {
        const known = side === 'from' ? generationAt(fromQid) : generationAt(toQid);
        if (known != null) return known;
        // An unplaced writer sits one step beyond the one they connect to.
        const anchor = side === 'from' ? generationAt(toQid) : generationAt(fromQid);
        return (anchor ?? 0) + (side === 'from' ? -1 : 1);
      });
    }
  }

  // Size by how much of the network runs through a writer. On an influence map
  // the hubs are the point: these are the writers everyone read.
  let maxDegree = 1;
  g.forEachNode((id) => {
    if (id !== seedId) maxDegree = Math.max(maxDegree, g.degree(id));
  });
  g.forEachNode((id) => {
    if (id === seedId) return;
    g.setNodeAttribute(id, 'score', Math.min(1, 0.3 + 0.7 * (g.degree(id) / maxDegree)));
  });

  ctx.update(g, { centerId: seedId });
  return { graph: g, seedId, author, seedLabel: author.name, qid: item.qid, directed: true };
}

// ---------- Growing a map ----------

const EXPAND_SUBJECTS = 3;

/** Books filed under a book's own most distinctive subjects. Shared with the details panel. */
export async function relatedBooks(book, ctx, { subjects = 3, perSubject = 30, limit = 12 } = {}) {
  const picks = distinctiveSubjects(book.subjects, subjectCounts, subjects);
  if (!picks.length) return [];
  const lists = await gatherBySubjects(picks, ctx, { perSubject });
  ctx.check();

  const vector = book.vector || vectorOf(book.subjects, subjectCounts);
  const norm = book.norm || normOf(vector);
  // A node on the map already carries its shelf; a book handed in from
  // elsewhere still has the raw call numbers.
  const from = { shelf: book.shelf ?? parseShelf(book.lcc, book.ddc), pages: book.pages ?? null };
  const tally = tallyBooks(lists, { exclude: new Set([book.key]) });
  const topWeight = Math.max(...[...tally.values()].map((e) => e.weight), 0.001);

  return [...tally.values()]
    .map((entry) => {
      const other = vectorOf(entry.book.subjects, subjectCounts);
      const overlap = similarity(vector, other, norm, normOf(other));
      const to = { shelf: parseShelf(entry.book.lcc, entry.book.ddc), pages: entry.book.pages ?? null };
      return { book: entry.book, score: withShelf(0.62 * overlap + 0.38 * (entry.weight / topWeight), from, to) };
    })
    .sort((a, b) => b.score - a.score || b.book.editions - a.book.editions)
    .slice(0, limit);
}

export async function expandNode(g, id, ctx, limit = 10) {
  const node = g.getNodeAttributes(id);

  if (node.kind === 'book') {
    const found = await relatedBooks(node, ctx, { subjects: EXPAND_SUBJECTS, perSubject: 30, limit: 40 });
    let added = 0;
    for (const { book, score } of found) {
      const otherId = bookId(book.key);
      if (g.hasNode(otherId)) {
        upsertEdge(g, id, otherId, Math.max(0.12, score));
      } else if (added < limit) {
        upsertNode(g, otherId, bookNode(book, Math.max(0.15, (node.score ?? 0.5) * score), (node.hop ?? 1) + 1));
        upsertEdge(g, id, otherId, Math.max(0.12, score));
        added += 1;
      }
    }
    weave(g, { skipSeedPairs: false });
    g.setNodeAttribute(id, 'expanded', true);
    return added;
  }

  // An author grows by their colleagues: whoever else writes about what they
  // write about, found the same way an author map is built.
  const picks = distinctiveSubjects(node.subjects, subjectCounts, EXPAND_SUBJECTS);
  if (!picks.length) return 0;
  const lists = await gatherBySubjects(picks, ctx, { perSubject: 40 });
  ctx.check();

  const tally = new Map();
  for (const list of lists) {
    list.books.forEach((book, index) => {
      const factor = list.weight * rankFactor(index, list.books.length);
      for (const person of book.authors || []) {
        if (!person.key || !person.name || person.key === node.key) continue;
        const entry = tally.get(person.key) || { key: person.key, name: person.name, weight: 0, works: [], subjects: new Set() };
        entry.weight += factor;
        if (entry.works.length < 6) entry.works.push(book);
        for (const subject of book.subjects || []) entry.subjects.add(subject);
        tally.set(person.key, entry);
      }
    });
  }

  const top = Math.max(...[...tally.values()].map((e) => e.weight), 0.001);
  const ranked = [...tally.values()].sort((a, b) => b.weight - a.weight);
  let added = 0;
  for (const entry of ranked) {
    const otherId = authorId(entry.key);
    const weight = Math.max(0.12, entry.weight / top);
    if (g.hasNode(otherId)) {
      upsertEdge(g, id, otherId, weight);
    } else if (added < limit) {
      upsertNode(
        g,
        otherId,
        authorNode(
          { key: entry.key, name: entry.name, subjects: [...entry.subjects].slice(0, 36), works: entry.works },
          Math.max(0.15, (node.score ?? 0.5) * weight),
          (node.hop ?? 1) + 1,
        ),
      );
      upsertEdge(g, id, otherId, weight);
      added += 1;
    }
  }
  weave(g, { skipSeedPairs: false });
  addInfluenceOverlay(g, ctx).catch(() => {});
  g.setNodeAttribute(id, 'expanded', true);
  return added;
}

/**
 * Adds one specific thing to the map and wires it into everything already
 * there, without pulling in anything else. Used by the lists in the details
 * panel, where the point is to add the one you picked.
 */
export async function attachNode(g, hubId, item, ctx) {
  const hub = g.getNodeAttributes(hubId);
  const id = item.kind === 'author' ? authorId(item.key) : bookId(item.key);

  if (!g.hasNode(id)) {
    if (item.kind === 'author') {
      let subjects = item.subjects || [];
      let works = item.works || [];
      if (!subjects.length) {
        try {
          works = await ol.authorWorks(item.key, 30);
          subjects = subjectsOfWorks(works);
        } catch (err) {
          rethrowStale(err);
        }
      }
      ctx.check();
      upsertNode(
        g,
        id,
        authorNode({ key: item.key, name: item.name, subjects, works: works.slice(0, 8) }, Math.max(0.2, (hub.score ?? 0.5) * 0.8), (hub.hop ?? 1) + 1),
      );
    } else {
      let book = item.book;
      if (!book?.subjects?.length) {
        try {
          book = await ol.bookByKey(item.key);
        } catch (err) {
          rethrowStale(err);
        }
      }
      ctx.check();
      if (!book) throw new EmptyMapError(`Open Library couldn't return ${item.name}.`);
      upsertNode(g, id, bookNode(book, Math.max(0.2, (hub.score ?? 0.5) * 0.8), (hub.hop ?? 1) + 1));
    }
  }

  upsertEdge(g, hubId, id, Math.max(0.2, item.score ?? 0.4));
  weave(g, { skipSeedPairs: false });
  return id;
}

// ---------- Paths ----------

export class PathNotFoundError extends Error {
  // `exhausted` means there was nowhere left to look, not that the budget ran
  // out — searching harder would return the same answer.
  constructor(message, { checked, exhausted = false } = {}) {
    super(message);
    this.checked = checked;
    this.exhausted = exhausted;
  }
}

// Budgets count books opened, not requests. Opening one book means reading the
// two subjects that make it specific, and since subjects repeat heavily between
// neighbouring books, most of those reads come back from the cache.
export const PATH_BUDGET = { default: 12, max: 30 };
const PATH_SUBJECTS = 2;
const PATH_PER_SUBJECT = 30;
const PATH_KEEP_PER_SUBJECT = 12;

/**
 * Both ends of a path have to be the same kind of thing. Subtext routes between
 * books, so an author at either end becomes the book of theirs that stayed in
 * print longest — which is usually the one a route through them would go via
 * anyway.
 */
async function asBook(endpoint) {
  if (endpoint.kind === 'book') {
    const book = await ol.bookByKey(endpoint.key);
    return { book, convertedFrom: null };
  }
  // The endpoint carries an ID, not a name, so the name is looked up here —
  // the panel has to be able to say which writer became which book.
  const [author, works] = await Promise.all([
    ol.authorByKey(endpoint.key).catch(() => null),
    ol.authorWorks(endpoint.key, 20),
  ]);
  const name = author?.name || endpoint.name || 'That writer';
  if (!works.length) {
    throw new EmptyMapError(`Open Library lists no books for ${name}, so they can't be one end of a path.`);
  }
  const book = await ol.bookByKey(works[0].key).catch(() => works[0]);
  return { book, convertedFrom: name };
}

/** One step of the search: everything filed beside a book, under its own subjects. */
async function neighboursOf(book, ctx) {
  const picks = distinctiveSubjects(book.subjects, subjectCounts, PATH_SUBJECTS);
  if (!picks.length) return [];
  const lists = await gatherBySubjects(picks, ctx, { perSubject: PATH_PER_SUBJECT, verb: 'Read' });
  ctx.check();

  const vector = book.vector || vectorOf(book.subjects, subjectCounts);
  const norm = book.norm || normOf(vector);
  // A route is only as smooth as the links it follows, so a step is measured
  // the same way a link on a map is: a path shouldn't cross from a graphic
  // novel to a work of theory on the strength of one shared heading.
  const from = { shelf: book.shelf ?? parseShelf(book.lcc, book.ddc), pages: book.pages ?? null };
  const seen = new Map();

  for (const list of lists) {
    let kept = 0;
    for (const candidate of list.books) {
      if (candidate.key === book.key || kept >= PATH_KEEP_PER_SUBJECT) continue;
      const other = vectorOf(candidate.subjects, subjectCounts);
      const to = { shelf: parseShelf(candidate.lcc, candidate.ddc), pages: candidate.pages ?? null };
      const weight = withShelf(similarity(vector, other, norm, normOf(other)), from, to);
      const existing = seen.get(candidate.key);
      if (!existing || weight > existing.weight) seen.set(candidate.key, { book: candidate, weight });
      kept += 1;
    }
  }
  return [...seen.values()].sort((a, b) => b.weight - a.weight);
}

/**
 * Grows outward from both ends at once, strongest links first, until the sides
 * meet. Every step also links back to books already found, so by the time the
 * two sides touch there's a real weighted graph to route through rather than a
 * single thread.
 */
async function searchBothEnds(g, ends, ctx, { budget }) {
  const seen = { a: new Set([ends.a]), b: new Set([ends.b]) };
  const frontier = { a: [], b: [] };
  const opened = new Set([ends.a, ends.b]);
  let meeting = null;

  function absorb(side, hubId, items, hop) {
    const hub = g.getNodeAttributes(hubId);
    const other = side === 'a' ? 'b' : 'a';
    let hit = null;

    for (const { book, weight } of items) {
      const id = bookId(book.key);
      if (id === hubId) continue;
      upsertNode(g, id, bookNode(book, Math.max(0.1, (hub.score ?? 1) * Math.max(0.2, weight)), hop));
      upsertEdge(g, hubId, id, Math.max(0.08, weight));

      if (!hit && seen[other].has(id)) hit = id;
      if (!seen[side].has(id)) {
        seen[side].add(id);
        frontier[side].push({ id, hop, weight });
      }
    }
    return hit;
  }

  ctx.progress('Reading out from both ends');
  const [ringA, ringB] = await Promise.all([
    neighboursOf(g.getNodeAttributes(ends.a), ctx),
    neighboursOf(g.getNodeAttributes(ends.b), ctx),
  ]);
  ctx.check();
  if (!ringA.length && !ringB.length) {
    return { meeting: null, checked: 2, exhausted: true, opened };
  }
  // Both sides absorb before either short-circuits, so each end's neighbourhood
  // is on the map whatever happens next.
  const hitA = absorb('a', ends.a, ringA, 1);
  const hitB = absorb('b', ends.b, ringB, 1);
  meeting = hitA || hitB;

  const nextUp = (side) => {
    frontier[side].sort((x, y) => x.hop - y.hop || y.weight - x.weight);
    while (frontier[side].length) {
      const candidate = frontier[side].shift();
      if (!opened.has(candidate.id)) return candidate;
    }
    return null;
  };

  let checked = 2;
  let exhausted = false;

  while (!meeting && checked < budget) {
    const batch = [];
    for (const side of ['a', 'b']) {
      if (checked + batch.length >= budget) break;
      const next = nextUp(side);
      if (!next) continue;
      opened.add(next.id);
      batch.push({ side, ...next });
    }
    if (!batch.length) {
      exhausted = true;
      break;
    }

    checked += batch.length;
    ctx.progress(`Opened ${checked} books from both ends`);

    const results = await Promise.all(
      batch.map((entry) =>
        neighboursOf(g.getNodeAttributes(entry.id), ctx)
          .then((items) => ({ ...entry, items }))
          .catch((err) => {
            rethrowStale(err);
            return { ...entry, items: [] };
          }),
      ),
    );
    ctx.check();

    for (const result of results) {
      const hit = absorb(result.side, result.id, result.items, result.hop + 1);
      if (hit && !meeting) meeting = hit;
    }
  }

  return { meeting, checked, exhausted, opened };
}

/**
 * The books worth showing once a route is found: every step, plus each step's
 * closest neighbours, so the route sits inside the reading it travels through
 * rather than floating alone. Links among the survivors are then recomputed in
 * full, which is affordable here and isn't while the search is running.
 */
function corridorGraph(g, path, ends, { perStep = 6, max = 64 } = {}) {
  const keep = new Map(path.map((id, i) => [id, { score: 0.92, hop: 0, step: i }]));

  for (const id of path) {
    const neighbours = g
      .mapNeighbors(id, (nb) => ({ id: nb, weight: g.getEdgeAttribute(g.edge(id, nb), 'weight') }))
      .filter((n) => !keep.has(n.id))
      .sort((a, b) => b.weight - a.weight)
      .slice(0, perStep);
    for (const neighbour of neighbours) {
      if (keep.size >= max) break;
      const current = keep.get(neighbour.id);
      if (!current || neighbour.weight * 0.55 > current.score) {
        keep.set(neighbour.id, { score: neighbour.weight * 0.55, hop: 1 });
      }
    }
  }

  const out = new Graph({ type: 'undirected' });
  for (const [id, meta] of keep) {
    out.addNode(id, { ...g.getNodeAttributes(id), score: meta.score, hop: meta.hop });
  }
  g.forEachEdge((_edge, attrs, source, target) => {
    if (keep.has(source) && keep.has(target)) upsertEdge(out, source, target, attrs.weight);
  });
  weave(out, { skipSeedPairs: false, maxLinks: 5 });

  out.mergeNodeAttributes(ends.a, { seed: true, anchor: 'start', score: 1 });
  out.mergeNodeAttributes(ends.b, { seed: true, anchor: 'end', score: 1 });
  return out;
}

/** Both ends and their nearest neighbours, shown while the search between them runs. */
function previewGraph(g, ends) {
  const out = new Graph({ type: 'undirected' });
  for (const side of ['a', 'b']) {
    const id = ends[side];
    if (!g.hasNode(id)) continue;
    const anchor = { ...g.getNodeAttributes(id), seed: true, anchor: side === 'a' ? 'start' : 'end', score: 1 };
    // Two books close enough to sit in each other's neighbourhood will already
    // have been drawn as a neighbour by the time the second end is placed.
    if (out.hasNode(id)) out.mergeNodeAttributes(id, anchor);
    else out.addNode(id, anchor);
    const neighbours = g
      .mapNeighbors(id, (nb) => ({ id: nb, weight: g.getEdgeAttribute(g.edge(id, nb), 'weight') }))
      .sort((a, b) => b.weight - a.weight)
      .slice(0, 8);
    for (const neighbour of neighbours) {
      if (out.hasNode(neighbour.id)) continue;
      out.addNode(neighbour.id, { ...g.getNodeAttributes(neighbour.id), score: neighbour.weight * 0.5, hop: 1 });
      out.addEdge(id, neighbour.id, { weight: neighbour.weight });
    }
  }
  return out;
}

export async function buildPathMap(fromEndpoint, toEndpoint, ctx, { budget = PATH_BUDGET.default } = {}) {
  ctx.progress('Looking up both ends');
  const [start, end] = await Promise.all([asBook(fromEndpoint), asBook(toEndpoint)]);
  ctx.check();

  const g = new Graph({ type: 'undirected' });
  const ends = { a: bookId(start.book.key), b: bookId(end.book.key) };
  if (ends.a === ends.b) {
    throw new EmptyMapError('Both ends of the path are the same book. Pick two different starting points.');
  }
  g.addNode(ends.a, bookNode(start.book, 1, 0));
  g.addNode(ends.b, bookNode(end.book, 1, 0));
  ctx.update(previewGraph(g, ends), { fresh: true, centerId: null });

  const search = await searchBothEnds(g, ends, ctx, { budget });
  ctx.check();
  ctx.update(previewGraph(g, ends), { centerId: null });

  if (!search.meeting) {
    throw new PathNotFoundError(
      search.exhausted
        ? `No route connects “${start.book.title}” and “${end.book.title}”. Every subject leading out of both was followed and the two sides never met.`
        : `No route turned up between “${start.book.title}” and “${end.book.title}” after opening ${search.checked} books.`,
      { checked: search.checked, exhausted: search.exhausted },
    );
  }

  ctx.progress('Looking for a smoother route');
  const rough = smoothestPath(g, ends.a, ends.b);
  // Filling in around the route means the path returned is the smoothest one
  // available rather than the first one that happened to close the gap.
  const toOpen = (rough || []).filter((id) => !search.opened.has(id)).slice(0, 5);
  if (toOpen.length) {
    const extra = await Promise.all(
      toOpen.map((id) =>
        neighboursOf(g.getNodeAttributes(id), ctx)
          .then((items) => ({ id, items }))
          .catch((err) => {
            rethrowStale(err);
            return { id, items: [] };
          }),
      ),
    );
    ctx.check();
    for (const result of extra) {
      for (const { book, weight } of result.items) {
        const otherId = bookId(book.key);
        if (g.hasNode(otherId)) upsertEdge(g, result.id, otherId, Math.max(0.08, weight));
      }
    }
  }

  const path = smoothestPath(g, ends.a, ends.b) || rough;
  if (!path) {
    throw new PathNotFoundError(
      `The two sides met, but no continuous route survived between “${start.book.title}” and “${end.book.title}”.`,
      { checked: search.checked, exhausted: search.exhausted },
    );
  }

  return {
    graph: corridorGraph(g, path, ends),
    path,
    ends,
    fromLabel: start.book.title,
    toLabel: end.book.title,
    converted: [start.convertedFrom && { from: start.convertedFrom, to: start.book.title }, end.convertedFrom && { from: end.convertedFrom, to: end.book.title }].filter(Boolean),
    checked: search.checked,
  };
}
