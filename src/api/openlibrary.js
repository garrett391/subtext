import { cached } from './cache.js';

/**
 * Open Library, run by the Internet Archive. No account, no key, no quota:
 * anyone who opens Subtext can use it.
 *
 * Two habits keep it that way. Requests are paced, and everything is cached for
 * a week, so a classroom exploring the same map doesn't hammer a free service.
 */

const BASE = 'https://openlibrary.org';
const COVERS = 'https://covers.openlibrary.org';

// Open Library asks for restraint rather than publishing a hard number. Four a
// second, with the cache in front, is quiet.
const MIN_GAP_MS = 250;
const TIMEOUT_MS = 20000;

// Search results carry every subject a work has ever been filed under, which
// for a popular novel runs past a thousand. Past the first few dozen they're
// long-tail noise, and keeping them all would bloat the cache for nothing.
const MAX_SUBJECTS = 48;

const SEARCH_FIELDS = [
  'key',
  'title',
  'author_name',
  'author_key',
  'first_publish_year',
  'cover_i',
  'edition_count',
  'subject',
  'ratings_average',
  'ratings_count',
].join(',');

export class OpenLibraryError extends Error {
  constructor(message, { status = 0, notFound = false } = {}) {
    super(message);
    this.status = status;
    this.notFound = notFound;
  }
}

// ---------- Request plumbing ----------

let lastStart = 0;
let queue = Promise.resolve();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function throttle(task) {
  const turn = queue.then(async () => {
    const wait = Math.max(0, lastStart + MIN_GAP_MS - Date.now());
    if (wait) await sleep(wait);
    lastStart = Date.now();
  });
  queue = turn.catch(() => {});
  return turn.then(task);
}

async function getJson(path, params = {}) {
  return throttle(async () => {
    const qs = new URLSearchParams(params).toString();
    const url = `${BASE}${path}${qs ? `?${qs}` : ''}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    let res;
    try {
      res = await fetch(url, { signal: controller.signal, headers: { Accept: 'application/json' } });
    } catch (err) {
      throw new OpenLibraryError(
        err?.name === 'AbortError'
          ? 'Open Library took too long to answer. It gets slow under load — try again in a moment.'
          : "Couldn't reach Open Library. Check your internet connection and try again.",
      );
    } finally {
      clearTimeout(timer);
    }

    if (res.status === 404) {
      throw new OpenLibraryError('Open Library has no record with that ID.', { status: 404, notFound: true });
    }
    if (res.status === 429) {
      throw new OpenLibraryError('Open Library is limiting requests right now. Wait a minute, then try again.', {
        status: 429,
      });
    }
    if (!res.ok) {
      throw new OpenLibraryError(`Open Library returned an error (HTTP ${res.status}). Try again in a moment.`, {
        status: res.status,
      });
    }
    try {
      return await res.json();
    } catch {
      throw new OpenLibraryError('Open Library sent a response Subtext could not read. Try again in a moment.', {
        status: res.status,
      });
    }
  });
}

// ---------- Normalizers ----------

const asArray = (x) => (x == null ? [] : Array.isArray(x) ? x : [x]);

const num = (x) => {
  const n = typeof x === 'number' ? x : parseFloat(x);
  return Number.isFinite(n) ? n : 0;
};

/** "/works/OL45883W" and "OL45883W" both come back as "OL45883W". */
export const stripKey = (key) => String(key || '').split('/').filter(Boolean).pop() || '';

/** Open Library descriptions are sometimes a string and sometimes a typed object. */
function textOf(value) {
  const raw = typeof value === 'string' ? value : value?.value || '';
  return raw
    .replace(/\r\n/g, '\n')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1') // Markdown links, which turn up in descriptions.
    .replace(/-{4,}.*$/s, '') // Trailing source credits after a rule.
    .replace(/\(\[source\]\[\d+\]\)/gi, '')
    .trim();
}

const subjectsOf = (list) =>
  asArray(list)
    .map((s) => String(s || '').trim())
    .filter(Boolean)
    .slice(0, MAX_SUBJECTS);

function bookFromSearchDoc(doc) {
  const authorKeys = asArray(doc.author_key);
  const authorNames = asArray(doc.author_name);
  return {
    key: stripKey(doc.key),
    title: String(doc.title || 'Untitled').trim(),
    authors: authorNames.map((name, i) => ({ key: authorKeys[i] || '', name })),
    year: num(doc.first_publish_year) || null,
    coverId: doc.cover_i ? num(doc.cover_i) : null,
    editions: num(doc.edition_count),
    rating: doc.ratings_average ? Math.round(num(doc.ratings_average) * 10) / 10 : null,
    ratingCount: num(doc.ratings_count),
    subjects: subjectsOf(doc.subject),
  };
}

/**
 * The subjects endpoint returns works in a slightly different shape from
 * search. Same book, different envelope.
 */
function bookFromSubjectWork(work) {
  return {
    key: stripKey(work.key),
    title: String(work.title || 'Untitled').trim(),
    authors: asArray(work.authors).map((a) => ({ key: stripKey(a.key), name: String(a.name || '').trim() })),
    year: num(work.first_publish_year) || null,
    coverId: work.cover_id ? num(work.cover_id) : null,
    editions: num(work.edition_count),
    rating: null,
    ratingCount: 0,
    subjects: subjectsOf(work.subject),
  };
}

export const byline = (book) =>
  book?.authors?.length ? book.authors.map((a) => a.name).filter(Boolean).join(', ') : '';

// ---------- Covers ----------

/**
 * Covers are addressed by numeric ID rather than by ISBN or OLID. Open Library
 * rate-limits the ID-free forms and asks callers to prefer IDs, and the IDs
 * come free with every search result anyway.
 */
// `default=false` makes a missing cover a 404 rather than a grey placeholder,
// which lets the interface drop the image instead of showing a blank rectangle.
export const coverUrl = (coverId, size = 'M') =>
  coverId ? `${COVERS}/b/id/${coverId}-${size}.jpg?default=false` : null;

export const authorPhotoUrl = (photoId, size = 'M') =>
  photoId ? `${COVERS}/a/id/${photoId}-${size}.jpg?default=false` : null;

export const workUrl = (key) => `${BASE}/works/${key}`;
export const authorUrl = (key) => `${BASE}/authors/${key}`;

// ---------- Searching ----------

export function searchBooks(query, limit = 6) {
  return cached(`ol:searchBooks:${query.toLowerCase()}:${limit}`, async () => {
    const data = await getJson('/search.json', { q: query, limit, fields: SEARCH_FIELDS });
    return asArray(data.docs).map(bookFromSearchDoc).filter((b) => b.key);
  });
}

/** Used when a route names a book by title rather than by ID. */
export function findBook(title, author = '') {
  return cached(`ol:findBook:${title.toLowerCase()}|${author.toLowerCase()}`, async () => {
    const params = { title, limit: 4, fields: SEARCH_FIELDS };
    if (author) params.author = author;
    const data = await getJson('/search.json', params);
    const docs = asArray(data.docs).map(bookFromSearchDoc).filter((b) => b.key);
    if (docs.length) return docs[0];
    // Falling back to a plain query catches titles the structured search misses,
    // usually because the title field holds a subtitle or a series name.
    const loose = await getJson('/search.json', {
      q: [title, author].filter(Boolean).join(' '),
      limit: 4,
      fields: SEARCH_FIELDS,
    });
    return asArray(loose.docs).map(bookFromSearchDoc).filter((b) => b.key)[0] || null;
  });
}

export function searchAuthors(query, limit = 6) {
  return cached(`ol:searchAuthors:${query.toLowerCase()}:${limit}`, async () => {
    const data = await getJson('/search/authors.json', { q: query, limit });
    return asArray(data.docs)
      .map((doc) => ({
        key: stripKey(doc.key),
        name: String(doc.name || '').trim(),
        birth: doc.birth_date || null,
        death: doc.death_date || null,
        topWork: doc.top_work || null,
        workCount: num(doc.work_count),
        subjects: subjectsOf(doc.top_subjects),
      }))
      .filter((a) => a.key && a.name);
  });
}

/**
 * Subject autocomplete. This endpoint is less travelled than the rest, so a
 * failure is treated as "no suggestions" rather than an error — the curated
 * list in the search box covers the common ground either way.
 */
export function searchSubjects(query, limit = 6) {
  return cached(`ol:searchSubjects:${query.toLowerCase()}:${limit}`, async () => {
    try {
      const data = await getJson('/search/subjects.json', { q: query, limit });
      return asArray(data.docs)
        .map((doc) => ({
          name: String(doc.name || '').trim(),
          key: stripKey(doc.key),
          type: doc.subject_type || 'subject',
          workCount: num(doc.work_count),
        }))
        .filter((s) => s.name && s.type === 'subject');
    } catch {
      return [];
    }
  });
}

// ---------- Books ----------

/**
 * Everything about one work, in one place. Search carries most of it already,
 * but a work opened from a URL has nothing behind it yet, so this fills in from
 * the works endpoint and then borrows author names and edition counts from a
 * search on the same key.
 */
export function bookByKey(key) {
  return cached(`ol:book:${key}`, async () => {
    const [work, search] = await Promise.all([
      getJson(`/works/${key}.json`),
      getJson('/search.json', { q: `key:/works/${key}`, limit: 1, fields: SEARCH_FIELDS }).catch(() => null),
    ]);
    const fromSearch = search ? asArray(search.docs).map(bookFromSearchDoc)[0] : null;

    // The works endpoint files people, places and periods separately from plain
    // subjects. For finding related books they all count.
    const subjects = subjectsOf([
      ...asArray(work.subjects),
      ...asArray(work.subject_people),
      ...asArray(work.subject_places),
      ...asArray(work.subject_times),
    ]);

    return {
      key,
      title: String(work.title || fromSearch?.title || 'Untitled').trim(),
      authors: fromSearch?.authors?.length
        ? fromSearch.authors
        : asArray(work.authors)
            .map((a) => ({ key: stripKey(a?.author?.key || a?.key), name: '' }))
            .filter((a) => a.key),
      year: fromSearch?.year ?? (work.first_publish_date ? num(String(work.first_publish_date).slice(-4)) || null : null),
      coverId: asArray(work.covers).find((c) => num(c) > 0) ?? fromSearch?.coverId ?? null,
      editions: fromSearch?.editions ?? 0,
      rating: fromSearch?.rating ?? null,
      ratingCount: fromSearch?.ratingCount ?? 0,
      subjects: subjects.length ? subjects : fromSearch?.subjects || [],
      description: textOf(work.description),
      links: asArray(work.links)
        .map((l) => ({ title: String(l.title || 'Link'), url: String(l.url || '') }))
        .filter((l) => /^https?:/.test(l.url))
        .slice(0, 4),
    };
  });
}

/**
 * Books filed under a subject. The dedicated `subject` parameter is the direct
 * route; when it comes back empty the same question is asked through the plain
 * query field, which is more forgiving about how a heading is spelled.
 */
export function booksBySubject(subject, limit = 40) {
  return cached(`ol:subject:${subject.toLowerCase()}:${limit}`, async () => {
    const data = await getJson('/search.json', { subject, limit, fields: SEARCH_FIELDS });
    let docs = asArray(data.docs);
    let found = num(data.numFound ?? data.num_found);
    if (!docs.length) {
      const loose = await getJson('/search.json', {
        q: `subject:"${subject.replace(/"/g, '')}"`,
        limit,
        fields: SEARCH_FIELDS,
      });
      docs = asArray(loose.docs);
      found = num(loose.numFound ?? loose.num_found);
    }
    return { subject, workCount: found, books: docs.map(bookFromSearchDoc).filter((b) => b.key) };
  });
}

/** A fallback route to a subject's works, for headings the search index spells differently. */
export function subjectWorks(subject, limit = 40) {
  const slug = subject
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '_');
  return cached(`ol:subjectWorks:${slug}:${limit}`, async () => {
    if (!slug) return { subject, workCount: 0, books: [] };
    try {
      const data = await getJson(`/subjects/${slug}.json`, { limit });
      return {
        subject: String(data.name || subject),
        workCount: num(data.work_count),
        books: asArray(data.works).map(bookFromSubjectWork).filter((b) => b.key),
      };
    } catch {
      return { subject, workCount: 0, books: [] };
    }
  });
}

// ---------- Authors ----------

export function authorByKey(key) {
  return cached(`ol:author:${key}`, async () => {
    const data = await getJson(`/authors/${key}.json`);
    return {
      key,
      name: String(data.name || data.personal_name || 'Unknown').trim(),
      birth: data.birth_date || null,
      death: data.death_date || null,
      bio: textOf(data.bio),
      photoId: asArray(data.photos).find((p) => num(p) > 0) ?? null,
      // Open Library records the Wikidata item for many authors, which saves
      // guessing at it by name when looking up who influenced whom.
      wikidata: data.remote_ids?.wikidata || null,
      links: asArray(data.links)
        .map((l) => ({ title: String(l.title || 'Link'), url: String(l.url || '') }))
        .filter((l) => /^https?:/.test(l.url))
        .slice(0, 4),
      alternateNames: asArray(data.alternate_names).slice(0, 4),
    };
  });
}

/**
 * An author's works, most republished first. Edition count is a rough proxy for
 * which of an author's books matter: the ones that stayed in print.
 */
export function authorWorks(key, limit = 50) {
  return cached(`ol:authorWorks:${key}:${limit}`, async () => {
    const data = await getJson('/search.json', {
      q: `author_key:${key}`,
      limit,
      fields: SEARCH_FIELDS,
    });
    let books = asArray(data.docs).map(bookFromSearchDoc).filter((b) => b.key);

    if (!books.length) {
      // The author endpoint lists works directly, without edition counts. It's
      // the backstop for authors the search index hasn't linked to this key.
      const fallback = await getJson(`/authors/${key}/works.json`, { limit });
      books = asArray(fallback.entries)
        .map((entry) => ({
          key: stripKey(entry.key),
          title: String(entry.title || 'Untitled').trim(),
          authors: [{ key, name: '' }],
          year: entry.first_publish_date ? num(String(entry.first_publish_date).slice(-4)) || null : null,
          coverId: asArray(entry.covers).find((c) => num(c) > 0) ?? null,
          editions: 0,
          rating: null,
          ratingCount: 0,
          subjects: subjectsOf(entry.subjects),
        }))
        .filter((b) => b.key);
    }
    return books.sort((a, b) => b.editions - a.editions || (b.year ?? 0) - (a.year ?? 0));
  });
}

/** Resolves an author named in a URL or picked from a list to a real record. */
export function findAuthor(name) {
  return cached(`ol:findAuthor:${name.toLowerCase()}`, async () => {
    const results = await searchAuthors(name, 5);
    if (!results.length) return null;
    const exact = results.find((a) => a.name.toLowerCase() === name.toLowerCase());
    // Otherwise the most published match, which is nearly always the one meant.
    return exact || results.slice().sort((a, b) => b.workCount - a.workCount)[0];
  });
}
