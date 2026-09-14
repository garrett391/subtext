/**
 * Two classification schemes ride along with every Open Library search result:
 * the Library of Congress call number and the Dewey Decimal number. They say
 * something subject headings can't, because they are hierarchies. A heading is
 * a flat label — "feminism" is filed on the theory and on the novel alike —
 * where a call number puts the theory at HQ1154 and the novel at PS3523, on
 * different floors of the building.
 *
 * What a call number means, though, depends on where in the scheme it sits, and
 * reading it wrong is worse than not reading it at all.
 *
 * In most classes the number is the topic. HQ1154 and HQ1190 are both women's
 * studies; PN6727 and PN6737 are both comics. Numbers that sit near each other
 * are about things that sit near each other, which is the whole idea of a shelf.
 *
 * Class P — Language and Literature — is the exception, and it is the class
 * most fiction lands in. Inside its national literatures the big ranges are
 * "individual authors", where the number comes from the author's period and the
 * first letter of their surname rather than from anything about the book.
 * Mistborn is PS3619.A533: PS is American literature, 3619 is "began publishing
 * in 2001 or later, surname begins with S", and .A533 is the cutter for
 * "anderson". Nothing in it is a subject, and the next number along is the next
 * letter of the alphabet. Asimov is A, so he sits at PS3501 and PS3551; Simmons
 * is S and lands on PS3569; Sanderson, publishing forty years later, on PS3619.
 *
 * So proximity has to be switched off in those ranges. What survives is worth
 * having on its own: the range itself dates the author, which puts
 * contemporaries together — something neither subject headings nor a
 * publication year can do, since a year is contaminated by every reprint.
 */

// Open Library hands these over in a sortable normal form: one to three class
// letters padded out to three with dashes, a zero-padded number, then the
// cutters. "PS-3619.00000000.A533 M57 2006", "D--0769.800000", "HQ-1154.000000".
const LCC_PATTERN = /^([A-Z]{1,3})-*(\d+)(?:\.(\d+))?(?:\.(.+))?$/;

/**
 * The "individual authors" ranges, where the number is a person rather than a
 * subject. Erring wide here is safe: marking a topical range biographical costs
 * a little precision, where the reverse invents a resemblance out of two
 * surnames happening to start with the same letter.
 *
 * Periods are recorded only for the two schedules this was checked against.
 * Elsewhere the range still suppresses proximity but claims no date.
 */
const AUTHOR_RANGES = {
  PS: [
    [1300, 3499, '19th century'],
    [3500, 3549, '1900-1960'],
    [3550, 3576, '1961-2000'],
    [3600, 3626, '2001-'],
  ],
  PR: [
    [3991, 5999, '19th century'],
    [6000, 6049, '1900-1960'],
    [6050, 6076, '1961-2000'],
    [6100, 6126, '2001-'],
  ],
  PQ: [[1551, 2726, ''], [4001, 4926, ''], [6001, 6726, '']],
  PT: [[1501, 2726, ''], [7581, 9999, '']],
  PG: [[3300, 3599, ''], [5001, 7599, '']],
  PL: [[700, 899, ''], [2600, 3208, '']],
  PJ: [[7500, 8000, '']],
  PK: [[2000, 2600, '']],
  PA: [[3818, 6961, '']],
};

function authorRange(subclass, number) {
  for (const [low, high, period] of AUTHOR_RANGES[subclass] || []) {
    if (number >= low && number <= high) return { biographical: true, period };
  }
  return { biographical: false, period: '' };
}

/** One call number, read into the parts that mean something. */
export function parseLcc(raw) {
  const match = LCC_PATTERN.exec(String(raw || '').trim().toUpperCase());
  if (!match) return null;
  const [, subclass, whole, decimals, cutters] = match;
  const number = Number(whole) + (decimals ? Number(`0.${decimals}`) : 0);
  // "LC-0000.000000" and friends stand in for a number nobody assigned.
  if (!number) return null;
  const { biographical, period } = authorRange(subclass, number);
  return {
    subclass,
    root: subclass[0], // P, H, Q — the floor of the library.
    number,
    // The first cutter is the author. Two books agreeing all the way down to it
    // are by the same hand, whatever the catalogue says about the author's ID.
    cutter: (cutters || '').trim().split(/\s+/)[0] || '',
    biographical,
    period,
  };
}

/** Dewey, kept as its digits so shared prefixes can be counted. */
export function parseDdc(raw) {
  // Open Library carries oddities like "[Fic]" and "813.54 B" alongside numbers.
  const match = /^(\d{1,3})(?:\.(\d+))?/.exec(String(raw || '').trim());
  if (!match) return null;
  return { digits: match[1] + (match[2] || ''), base: match[1] };
}

/**
 * A book carries a call number for every edition anyone catalogued, and they
 * disagree. Watchmen has fourteen, most of them PN6737 and a couple that
 * wandered. Taking the commonest class, then the commonest number inside it,
 * drops the strays without dropping the specificity.
 */
function pickLcc(list) {
  const parsed = (list || []).map(parseLcc).filter(Boolean);
  if (!parsed.length) return null;

  const bySubclass = new Map();
  for (const entry of parsed) bySubclass.set(entry.subclass, (bySubclass.get(entry.subclass) || 0) + 1);
  const subclass = [...bySubclass.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0][0];

  const inClass = parsed.filter((entry) => entry.subclass === subclass);
  const byNumber = new Map();
  for (const entry of inClass) byNumber.set(entry.number, (byNumber.get(entry.number) || 0) + 1);
  const number = [...byNumber.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0][0];
  return inClass.find((entry) => entry.number === number) || inClass[0];
}

/**
 * Dewey the same way, with two differences.
 *
 * Where two bases are equally popular the more specific one wins. The Stepford
 * Wives is filed at both "813.54" and "810" — American fiction of a period, and
 * American literature at large — and the cataloguer who wrote the longer number
 * said more than the one who wrote the shorter.
 *
 * Within a base the shorter number wins instead, because there the numbers are
 * refinements of each other and the short one is what they agree on. Watchmen
 * is 741.5941, 741.5942, 741.5973 and 741.5 depending on who catalogued it —
 * French comics, Belgian, American — and 741.5 is the part that isn't a guess.
 */
function pickDdc(list) {
  const parsed = (list || []).map(parseDdc).filter(Boolean);
  if (!parsed.length) return null;

  const byBase = new Map();
  for (const entry of parsed) {
    const seen = byBase.get(entry.base) || { count: 0, longest: 0 };
    byBase.set(entry.base, { count: seen.count + 1, longest: Math.max(seen.longest, entry.digits.length) });
  }
  const base = [...byBase.entries()].sort(
    (a, b) => b[1].count - a[1].count || b[1].longest - a[1].longest || a[0].localeCompare(b[0]),
  )[0][0];
  return parsed.filter((entry) => entry.base === base).sort((a, b) => a.digits.length - b.digits.length)[0];
}

/** Everything shelf-related about one book, read once and carried on its node. */
export function parseShelf(lcc, ddc) {
  const left = pickLcc(lcc);
  const right = pickDdc(ddc);
  return left || right ? { lcc: left, ddc: right } : null;
}

// Sharing a subclass earns this much before the number is looked at; the number
// carries it the rest of the way.
const SAME_SUBCLASS = 0.35;

function lccAgreement(a, b) {
  if (!a || !b) return null;
  // PS against HQ: a novel and a work of theory about the same thing. This is
  // the distinction subject headings cannot make, so it is made sharply.
  if (a.root !== b.root) return 0;
  // PS against PR: both literature, different national tradition.
  if (a.subclass !== b.subclass) return SAME_SUBCLASS;
  if (a.cutter && a.cutter === b.cutter && a.number === b.number) return 0.95;

  if (a.biographical || b.biographical) {
    // One of the pair sits in an author range and the other doesn't, so the
    // numbers aren't measuring the same thing and can't be compared.
    if (!a.biographical || !b.biographical) return 0.55;
    // Same literature, and the same generation of it.
    return a.period && a.period === b.period ? 0.72 : 0.55;
  }
  // A topical range, where distance along the shelf is distance between subjects.
  return SAME_SUBCLASS + 0.6 * Math.exp(-Math.abs(a.number - b.number) / 250);
}

const SHARED_PREFIX = [0, 0.3, 0.5, 0.7, 0.85, 0.95];

function ddcAgreement(a, b) {
  if (!a || !b) return null;
  let shared = 0;
  while (shared < a.digits.length && shared < b.digits.length && a.digits[shared] === b.digits[shared]) shared += 1;
  return SHARED_PREFIX[Math.min(shared, SHARED_PREFIX.length - 1)];
}

/**
 * How much two books agree about where they belong, 0 to 1, or null when
 * neither was classified. Null matters: a book Open Library never filed must
 * not be scored as though it had been filed somewhere else.
 */
export function shelfAgreement(a, b) {
  const left = lccAgreement(a?.lcc, b?.lcc);
  const right = ddcAgreement(a?.ddc, b?.ddc);
  if (left == null && right == null) return null;
  if (left == null) return right;
  if (right == null) return left;
  // Congress leads, because its class letters carry the form of the thing where
  // Dewey's leading digit is a broader bucket.
  return 0.6 * left + 0.4 * right;
}

// Length is a poor measure of resemblance — two three-hundred-page books have
// nothing in common by virtue of it — so it only ever holds back a pairing that
// is obviously the wrong size, and never creates one. Nothing at all until one
// book is twice the other, and never more than this however far apart they are.
const MAX_LENGTH_PENALTY = 0.15;
const FREE_RATIO = Math.log(2);
const FULL_RATIO = Math.log(6);

/**
 * A multiplier for a pair of page counts. A ninety-six-page mini-comic and a
 * five-hundred-page graphic novel can share every heading they have and still
 * be different objects to a reader deciding what to pick up.
 */
export function lengthFactor(a, b) {
  if (!(a > 0) || !(b > 0)) return 1;
  const ratio = Math.abs(Math.log(a / b));
  if (ratio <= FREE_RATIO) return 1;
  return 1 - MAX_LENGTH_PENALTY * Math.min(1, (ratio - FREE_RATIO) / (FULL_RATIO - FREE_RATIO));
}
