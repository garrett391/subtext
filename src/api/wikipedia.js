import { cached } from './cache.js';

/**
 * Wikipedia, for the one thing neither catalogue supplies reliably: a plain
 * paragraph saying what a book is, or who a writer was. Open Library's
 * descriptions are whatever a contributor pasted in, and most works have none.
 * Wikipedia's lead paragraph is edited prose, and the REST summary endpoint
 * hands it over in one small response that sits in a cache at the edge.
 *
 * It's only ever asked about an article Wikidata has already named for the
 * item in hand, so there's no guessing at titles, and it only fills gaps: a
 * description Open Library does have is kept. The text arrives under
 * CC BY-SA, so wherever an extract is shown it's credited and linked back.
 *
 * No key, and like Wikidata it's allowed to fail: a null here means the panel
 * goes without a paragraph, and nothing else changes.
 */

const SUMMARY = 'https://en.wikipedia.org/api/rest_v1/page/summary/';
const TIMEOUT_MS = 10000;

/** "https://en.wikipedia.org/wiki/Dune_(novel)" comes back as "Dune_(novel)". */
export function articleTitle(url) {
  const match = /^https?:\/\/en\.wikipedia\.org\/wiki\/([^#?]+)/.exec(String(url || ''));
  if (!match) return '';
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return match[1];
  }
}

/**
 * The lead of one article: `{ title, description, extract, thumbnail, url }`,
 * or null when there's nothing usable. Redirects are followed by the endpoint,
 * so an old article name still lands on the current page.
 */
export function summaryFor(articleUrl) {
  const title = articleTitle(articleUrl);
  if (!title) return Promise.resolve(null);

  return cached(`wp:summary:${title}`, async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(`${SUMMARY}${encodeURIComponent(title)}`, {
        signal: controller.signal,
        headers: { Accept: 'application/json' },
      });
      if (!res.ok) return null;
      const data = await res.json();
      // A disambiguation page has an extract too, and it isn't about the book.
      if (data?.type && data.type !== 'standard') return null;
      const extract = String(data.extract || '').trim();
      if (!extract) return null;
      return {
        title: String(data.title || title.replace(/_/g, ' ')),
        description: String(data.description || ''),
        extract,
        thumbnail: data.thumbnail?.source || null,
        url: data.content_urls?.desktop?.page || `https://en.wikipedia.org/wiki/${encodeURIComponent(title)}`,
      };
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  });
}
