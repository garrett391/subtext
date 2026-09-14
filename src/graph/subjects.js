/**
 * Open Library has no "books like this book" endpoint. What it has instead is
 * subjects: every work carries a list of them, drawn from library cataloguing,
 * publisher metadata, and readers. Similarity here is built out of those lists.
 *
 * Three things have to happen before a subject list is usable.
 *
 * 1. Throw away the metadata. A lot of what Open Library files under "subjects"
 *    describes the scan rather than the book — "Accessible book", "Protected
 *    DAISY", "nyt:graphic_books=2010-04-25".
 *
 * 2. Split headings into facets. Library subjects arrive as compounds:
 *    "Superheroes -- Comic books, strips, etc." or the publisher's
 *    "COMICS & GRAPHIC NOVELS / Superheroes". Splitting on the separators means
 *    a book catalogued one way still matches a book catalogued the other.
 *
 * 3. Weight them. "Fiction" says almost nothing; "Autobiographical comics" says
 *    almost everything. Rarity is the real measure of that, and where a subject
 *    has been looked up its work count supplies it. Everything else is scored
 *    on shape, which is a decent stand-in: the longer and more qualified a
 *    heading is, the more specific it tends to be.
 */

// Cataloguing and scanning metadata. Matched as substrings, since these turn up
// with small variations.
const NOISE_FRAGMENTS = [
  'accessible book',
  'protected daisy',
  'daisy',
  'in library',
  'internet archive',
  'overdrive',
  'lending library',
  'print disabled',
  'reading level',
  'large type',
  'wishlist',
  'staff picks',
  'nyt:',
  'award:',
  'collection:',
  'ol_',
  'bestseller',
  'open library',
  'call number',
  'accessible_book',
  'obras antes de',
  'long now manual',
];

const NOISE_EXACT = new Set([
  'texts',
  'collections',
  'general',
  'miscellanea',
  'early works to 1800',
  'specimens',
  'translations into english',
  'english language materials',
  'foreign language materials',
  'readers',
  'e-books',
  'ebook',
  'paperback',
  'hardcover',
  'reprint',
  'new york times reviewed',
]);

// Real subjects, but so broad that sharing one says little. Kept, because they
// still carry a signal when two books share several of them, but weighted low.
const GENERIC = new Set([
  'fiction',
  'nonfiction',
  'non-fiction',
  'literature',
  'literary',
  'history',
  'biography',
  'autobiography',
  'novel',
  'novels',
  'comics',
  'american literature',
  'english literature',
  'english fiction',
  'american fiction',
  'juvenile literature',
  'juvenile fiction',
  'literary criticism',
  'criticism and interpretation',
  'social life and customs',
  'history and criticism',
  'biography & autobiography',
  'literary collections',
  'social conditions',
  'politics and government',
  'description and travel',
  'study and teaching',
  'pictorial works',
  'illustrated',
  'anthologies',
  'women',
  'men',
  'families',
  'friendship',
  'love',
  'death',
  'life',
]);

const MAX_LENGTH = 58;

/**
 * Some uploaders file headings with a namespace on the front: "genre:high
 * fantasy", "form:novel", "series:Stormlight Archive". The namespaced spelling
 * is a private vocabulary \u2014 "genre:high fantasy" sits on 98 works, 36 of them
 * volumes of two Japanese series, where plain "high fantasy" sits on nearly
 * nine hundred. Dropping the prefix puts the book back under the heading
 * everyone else used.
 *
 * "series:" is kept, since sharing a series is about as strong a link as two
 * books can have, but a series heading names a handful of books at most and so
 * is never worth a search: see `distinctiveSubjects`.
 */
const STRIP_PREFIX = /^(genre|form|subject|topic):\s*/;
const SERIES_PREFIX = /^series:/;

export const isSeriesHeading = (facet) => SERIES_PREFIX.test(facet);

export function normalizeSubject(raw) {
  const text = String(raw || '')
    .replace(/[\u2018\u2019\u201c\u201d]/g, "'")
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[.,;:]+$/, '')
    .trim()
    .toLowerCase()
    .replace(STRIP_PREFIX, '')
    // "series:A_Court_of_Thorns_and_Roses" and "series:A Court of Thorns and
    // Roses" are the same series.
    .replace(/_/g, ' ');
  if (text.length < 3 || text.length > MAX_LENGTH) return '';
  if (NOISE_EXACT.has(text)) return '';
  if (NOISE_FRAGMENTS.some((fragment) => text.includes(fragment))) return '';
  if (/^\d+$/.test(text)) return '';
  if (/^[a-z]{1,3}\d/.test(text)) return ''; // Classification codes like "pz7" or "ps3563".
  return text;
}

/**
 * Turns one heading into the set of things it claims. The whole heading counts
 * for most; its parts count for less, since a book about "Superheroes --
 * Juvenile fiction" is more about superheroes than the full heading suggests,
 * but not entirely.
 */
export function facetsOf(raw) {
  const full = normalizeSubject(raw);
  if (!full) return [];
  const out = [{ facet: full, share: 1 }];
  const parts = full.split(/\s+--\s+|\s*\/\s*|\s+\|\s+/);
  if (parts.length > 1) {
    for (const part of parts) {
      const facet = normalizeSubject(part);
      if (facet && facet !== full && !out.some((o) => o.facet === facet)) {
        out.push({ facet, share: 0.65 });
      }
    }
  }
  return out;
}

/**
 * How much a facet is worth when two books share it. `counts` maps a facet to
 * the number of works Open Library files under it; where it's known, rarity
 * decides. Where it isn't, shape stands in.
 */
export function facetWeight(facet, counts) {
  const known = counts?.get(facet);
  if (known != null && known > 0) {
    // Roughly inverse document frequency, flattened so a subject with a
    // thousand books isn't worthless next to one with ten.
    const idf = Math.log(400000 / Math.max(30, known)) / Math.log(400000 / 30);
    return Math.max(0.15, Math.min(1, 0.25 + 0.85 * idf));
  }
  if (GENERIC.has(facet)) return 0.22;
  const words = facet.split(' ').length;
  let weight = words === 1 ? 0.55 : words === 2 ? 0.8 : 0.95;
  // A comma usually means a library heading rather than a bare word, and those
  // are consistently the specific ones: "comic books, strips, etc".
  if (facet.includes(',')) weight = Math.max(weight, 0.9);
  return Math.min(1, weight);
}

/**
 * A book's subject list as a weighted vector, ready to compare. Duplicated
 * facets keep their highest share, so a heading that appears both whole and as
 * part of a longer one isn't counted twice.
 */
export function vectorOf(subjects, counts) {
  const vector = new Map();
  for (const raw of subjects || []) {
    for (const { facet, share } of facetsOf(raw)) {
      const value = facetWeight(facet, counts) * share;
      if (value > (vector.get(facet) ?? 0)) vector.set(facet, value);
    }
  }
  return vector;
}

export function normOf(vector) {
  let total = 0;
  for (const value of vector.values()) total += value * value;
  return Math.sqrt(total) || 1;
}

/** Cosine similarity, 0 to 1. Iterates the smaller vector. */
export function similarity(a, b, normA = normOf(a), normB = normOf(b)) {
  if (!a.size || !b.size) return 0;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  let dot = 0;
  for (const [facet, value] of small) {
    const other = large.get(facet);
    if (other) dot += value * other;
  }
  return Math.min(1, dot / (normA * normB));
}

/** The facets two books actually share, strongest first. Used to explain a link. */
export function sharedFacets(a, b, limit = 4) {
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  const shared = [];
  for (const [facet, value] of small) {
    const other = large.get(facet);
    if (other) shared.push({ facet, weight: value * other });
  }
  return shared
    .sort((x, y) => y.weight - x.weight)
    .slice(0, limit)
    .map((s) => s.facet);
}

/**
 * The subjects worth showing, and worth searching on. Ranked by weight, then
 * de-duplicated against each other so "Superheroes" and "Superheroes -- Comic
 * books" don't both take a slot.
 */
export function distinctiveSubjects(subjects, counts, limit = 8) {
  const seen = new Map();
  for (const raw of subjects || []) {
    const full = normalizeSubject(raw);
    if (!full) continue;
    // A series heading returns the series and nothing else: one or two books
    // for a whole search. It still counts towards similarity, just not here.
    if (isSeriesHeading(full)) continue;
    const weight = facetWeight(full, counts);
    if (!seen.has(full) || seen.get(full).weight < weight) {
      // What gets searched is the heading as everyone else spelled it, with the
      // uploader's namespace gone but the original casing kept for display.
      const subject = String(raw).trim().replace(/^(genre|form|subject|topic):\s*/i, '').replace(/_/g, ' ');
      seen.set(full, { subject, key: full, weight });
    }
  }
  const ranked = [...seen.values()].sort((a, b) => b.weight - a.weight);
  const kept = [];
  for (const candidate of ranked) {
    // Skip anything that's a restatement of something already kept.
    const overlaps = kept.some(
      (k) => k.key.includes(candidate.key) || candidate.key.includes(k.key),
    );
    if (overlaps) continue;
    kept.push(candidate);
    if (kept.length >= limit) break;
  }
  return kept;
}
