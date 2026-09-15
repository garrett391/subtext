/**
 * Wikidata's genres (P136) as a third opinion beside subjects and shelves.
 *
 * A library heading is whatever a cataloguer typed; Wikidata's genre is a
 * controlled vocabulary, one item per genre, so "planetary romance" is the
 * same thing on Solaris and on Dune. But it only reaches about half a map —
 * four books in ten resolve to an item, and five in six of those carry a
 * genre — so everything here is additive: a pair that shares a genre is
 * pulled closer, and a pair that can't be checked is left exactly as the
 * catalogue scored it.
 */

// Genres that describe the form of the thing rather than what kind of story it
// is. Nearly every novel on Wikidata is filed as "novel", which makes it worth
// nothing as evidence that two novels resemble each other.
const FORM_ONLY = new Set([
  'novel',
  'fiction',
  'non-fiction',
  'nonfiction',
  'literature',
  'literary work',
  'written work',
  'book',
  'prose',
  'short story',
  'novella',
  'poetry',
  'essay',
  'comics',
  'graphic novel',
  'manga',
]);

export const genreKey = (label) => String(label || '').trim().toLowerCase();

export const isFormOnly = (label) => FORM_ONLY.has(genreKey(label));

/**
 * How much each genre says, judged by how many things on this map carry it.
 * A genre on two books out of thirty is the interesting kind; one on twenty
 * says little more than the subject heading that built the map. Mirrors the
 * rarity weighting subjects get, but within the map rather than the catalogue,
 * because Wikidata doesn't report how many works carry a genre.
 */
export function genreWeights(genreLists) {
  const carriers = new Map();
  let resolved = 0;
  for (const list of genreLists) {
    const keys = new Set((list || []).map((g) => genreKey(g.label ?? g)).filter((k) => k && !FORM_ONLY.has(k)));
    if (!keys.size) continue;
    resolved += 1;
    for (const key of keys) carriers.set(key, (carriers.get(key) || 0) + 1);
  }
  const weights = new Map();
  for (const [key, count] of carriers) {
    // One carrier is unmatchable and gets full weight by default; from two
    // upward the weight falls as the genre becomes the map's common ground.
    const share = resolved > 1 ? (count - 1) / (resolved - 1) : 0;
    weights.set(key, Math.max(0.15, 1 - share));
  }
  return weights;
}

/**
 * Weighted overlap of two genre lists, from 0 to 1, or null when either side
 * has nothing usable — "couldn't check" rather than "checked and different".
 * The union is floored at one full genre's worth, so two books that share only
 * the map's commonest genre agree a little, and two that share a rare one
 * agree completely.
 */
export function genreAgreement(a, b, weights = new Map()) {
  const keysOf = (list) =>
    new Set((list || []).map((g) => genreKey(g.label ?? g)).filter((k) => k && !FORM_ONLY.has(k)));
  const left = keysOf(a);
  const right = keysOf(b);
  if (!left.size || !right.size) return null;
  const weightOf = (key) => weights.get(key) ?? 1;
  let shared = 0;
  let union = 0;
  for (const key of new Set([...left, ...right])) {
    const w = weightOf(key);
    union += w;
    if (left.has(key) && right.has(key)) shared += w;
  }
  return shared / Math.max(1, union);
}

/** The genres two lists have in common, most telling first, for the panel. */
export function sharedGenres(a, b, weights = new Map(), limit = 3) {
  const right = new Map((b || []).map((g) => [genreKey(g.label ?? g), g.label ?? g]));
  return (a || [])
    .map((g) => g.label ?? g)
    .filter((label) => right.has(genreKey(label)) && !isFormOnly(label))
    .sort((x, y) => (weights.get(genreKey(y)) ?? 1) - (weights.get(genreKey(x)) ?? 1))
    .slice(0, limit);
}
