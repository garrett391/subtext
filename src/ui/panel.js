import * as ol from '../api/openlibrary.js';
import * as wd from '../api/wikidata.js';
import * as wp from '../api/wikipedia.js';
import { h, icons, formatCount, formatYear, lifespan, titleCaseSubject, formatList } from './dom.js';
import { distinctiveSubjects } from '../graph/subjects.js';
import { isFormOnly } from '../graph/genres.js';

/**
 * The panel has four states: an overview of the current map, details for a
 * selected book, details for a selected author, and the result of a path
 * search. `actions` are callbacks supplied by main.js.
 */
export function createPanel(root, actions) {
  let detailToken = 0;
  const touch = window.matchMedia('(pointer: coarse)').matches;

  const body = h('div', { class: 'panel-body' });
  root.append(body);

  function show(...children) {
    body.replaceChildren(...children.filter(Boolean));
    root.hidden = false;
    body.scrollTop = 0;
  }

  const button = (label, onClick, extra = {}) =>
    h('button', { type: 'button', class: 'button', onClick, ...extra }, label);

  const skeletonList = () => h('div', { class: 'skeleton', 'aria-hidden': 'true' }, h('span'), h('span'), h('span'));

  /**
   * A row of pills under a small heading. Subjects and genres are the same
   * kind of thing — labels a book can be mapped by — so they share one shape,
   * with the heading saying whose labels they are.
   */
  const tagGroup = (heading, pills, className = '') =>
    pills.length
      ? h(
          'div',
          { class: `tag-group ${className}`.trim() },
          h('h3', { text: heading }),
          h('div', { class: 'tag-list' }, pills),
        )
      : null;

  const subjectList = (subjects) => {
    const picks = distinctiveSubjects(subjects, null, 8);
    return tagGroup(
      'Open Library subjects',
      picks.map((pick) =>
        h(
          'button',
          {
            type: 'button',
            class: 'tag',
            title: `Map everything filed under “${pick.subject}”`,
            onClick: () => actions.exploreSubject(pick.subject),
          },
          titleCaseSubject(pick.subject),
        ),
      ),
    );
  };

  const externalLink = (url, label) =>
    url
      ? h(
          'a',
          { class: 'text-link', href: url, target: '_blank', rel: 'noopener noreferrer' },
          label,
          h('span', { class: 'link-icon', html: icons.external }),
        )
      : null;

  /** A cover, which quietly disappears when Open Library hasn't got one. */
  function coverImage(url, alt, className = 'cover') {
    if (!url) return null;
    const figure = h('div', { class: className });
    const img = h('img', { src: url, alt, loading: 'lazy', decoding: 'async' });
    img.addEventListener('error', () => figure.remove());
    figure.append(img);
    return figure;
  }

  /**
   * One row in a list of things that may or may not already be drawn. Rows on
   * the map take you there; rows that aren't get added right where you are,
   * which makes "show me more like this" one at a time rather than ten.
   */
  function pickableRow(item, { sub } = {}) {
    const onMap = Boolean(actions.locate(item));
    const label = item.kind === 'book' && item.detail ? `${item.name}, by ${item.detail}` : item.name;
    return h(
      'li',
      {},
      h(
        'button',
        {
          type: 'button',
          class: 'list-button',
          'aria-label': onMap ? `Go to ${label}` : `Add ${label} to the map`,
          onClick: () => actions.openSimilar(item),
        },
        h('span', { class: 'list-main', text: item.name }),
        sub ? h('span', { class: 'list-sub', text: sub }) : null,
        // Kept on every row so the column to its left stays in line.
        h('span', { class: 'list-add', html: onMap ? '' : icons.plus }),
      ),
    );
  }

  const jumpRow = (id, label, sub) =>
    h(
      'li',
      {},
      h(
        'button',
        { type: 'button', class: 'list-button', onClick: () => actions.selectNode(id, { focus: true }) },
        h('span', { class: 'list-main', text: label }),
        sub ? h('span', { class: 'list-sub', text: sub }) : null,
      ),
    );

  // ---------- Overview ----------

  function showOverview(map) {
    detailToken++;
    const bridges = map.bridges.filter((b) => map.graph.hasNode(b.id));

    show(
      h('h2', { class: 'panel-title', text: map.title }),
      map.subtitle ? h('p', { class: 'panel-sub', text: map.subtitle }) : null,
      h('p', { class: 'meta', text: map.stats }),
      map.note ? h('p', { class: 'note', text: map.note }) : null,
      h(
        'div',
        { class: 'actions' },
        map.action ? button(map.action.label, map.action.onClick) : null,
        button(map.copyLabel || 'Copy as a reading list', actions.copyReadingList),
      ),
      bridges.length
        ? h(
            'section',
            { class: 'section' },
            h('h3', { text: 'Bridges' }),
            h('p', {
              class: 'hint',
              text: `${map.kindPlural[0].toUpperCase()}${map.kindPlural.slice(1)} that hold two parts of this map together. Often the most interesting thing on it.`,
            }),
            h('ul', { class: 'link-list' }, bridges.map((b) => jumpRow(b.id, b.label, b.sub))),
          )
        : null,
      map.everyone?.length
        ? h(
            'section',
            { class: 'section' },
            h('h3', { text: 'Everything on this map' }),
            h('p', { class: 'hint', text: map.everyoneHint }),
            h('ul', { class: 'link-list' }, map.everyone.map((n) => jumpRow(n.id, n.label, n.sub))),
          )
        : null,
      h(
        'p',
        { class: 'hint help' },
        touch
          ? 'Tap a dot for details, and double-tap one to grow the map from it. Drag dots to rearrange, and pinch to zoom.'
          : 'Select a dot for details. Double-click one to grow the map from it. Drag dots to rearrange, and scroll to zoom.',
      ),
    );
  }

  function showLoading(title, subtitle) {
    detailToken++;
    show(
      h('h2', { class: 'panel-title', text: title }),
      subtitle ? h('p', { class: 'panel-sub', text: subtitle }) : null,
      h('div', { class: 'skeleton', 'aria-hidden': 'true' }, h('span'), h('span'), h('span')),
    );
  }

  // ---------- Shared pieces ----------

  function nodeActions(id, node, extra = []) {
    return h(
      'div',
      { class: 'actions' },
      node.seed ? null : button('Centre the map here', () => actions.recenter(id)),
      button('Show more like this', () => actions.expand(id)),
      ...extra,
      button('Find a path from here', () => actions.startPath(id)),
      button('Show me something different', () => actions.somethingDifferent(id)),
    );
  }

  /**
   * The full ranked list of what else sits under this book's subjects, not only
   * what the map had room to draw. On a phone, where few labels fit, this is how
   * a map gets read without tapping every dot.
   */
  function relatedSection(node, token) {
    const slot = h('section', { class: 'section' }, h('h3', { text: 'Shares subjects with' }), skeletonList());

    actions
      .relatedTo(node)
      .then((items) => {
        if (token !== detailToken) return;
        if (!items?.length) {
          slot.remove();
          return;
        }
        slot.replaceChildren(
          h('h3', { text: 'Shares subjects with' }),
          h('p', { class: 'hint', text: 'Tap one to go to it, or to add it if it isn’t on the map yet.' }),
          h(
            'ul',
            { class: 'link-list' },
            items.slice(0, 10).map(({ book, score }) =>
              pickableRow(
                {
                  kind: 'book',
                  key: book.key,
                  name: book.title,
                  detail: ol.byline(book),
                  book,
                  score,
                },
                { sub: ol.byline(book) || (book.year ? String(book.year) : '') },
              ),
            ),
          ),
        );
      })
      .catch(() => {
        if (token === detailToken) slot.remove();
      });

    return slot;
  }

  // ---------- Book ----------

  function showBook(id, node, relation) {
    const token = ++detailToken;
    const meta = h('p', { class: 'meta', text: 'Loading details…' });
    const subjectsSlot = h('div');
    const genresSlot = h('div');
    const themesSlot = h('div');
    const awardsSlot = h('div');
    const seriesSlot = h('div');
    const alsoSlot = h('div');
    const descriptionSlot = h('div');
    const catalogueLink = h('div');
    const articleLink = h('div');

    // When the book appeared, from two sources that land in either order.
    // Open Library's year is the earliest edition it has catalogued, which is
    // often a reprint; Wikidata's is the first publication, so it wins.
    const known = { year: node.year ?? null, fromWikidata: false, language: '', editions: 0, rating: null, error: '' };
    const renderMeta = () => {
      const parts = [];
      if (known.year) parts.push(`First published ${formatYear(known.year)}${known.language ? ` in ${known.language}` : ''}`);
      if (known.editions) parts.push(`${formatCount(known.editions)} editions`);
      if (known.rating) parts.push(`rated ${known.rating} of 5`);
      meta.textContent = parts.join(' · ') || known.error;
    };
    const prose = proseFor(descriptionSlot, token);

    const authorButtons = (node.authors || []).filter((a) => a.name);
    const byline = authorButtons.length
      ? h(
          'p',
          { class: 'panel-sub' },
          'by ',
          ...authorButtons.flatMap((author, index) => [
            index ? h('span', { text: ', ' }) : null,
            author.key
              ? h(
                  'button',
                  { type: 'button', class: 'inline-link', onClick: () => actions.openAuthor(author.key, author.name) },
                  author.name,
                )
              : h('span', { text: author.name }),
          ]),
        )
      : node.byline
        ? h('p', { class: 'panel-sub', text: `by ${node.byline}` })
        : null;

    const mapAuthor = authorButtons.find((a) => a.key);

    const head = h(
      'div',
      { class: 'detail-head' },
      coverImage(ol.coverUrl(node.coverId, 'M'), `Cover of ${node.label}`),
      h(
        'div',
        { class: 'detail-headings' },
        h('p', { class: 'kind', text: 'Book' }),
        h('h2', { class: 'panel-title', text: node.label }),
        byline,
      ),
    );

    show(
      head,
      relation ? h('p', { class: 'relation', text: relation }) : null,
      meta,
      // What the book is about comes before where it sits on the map.
      descriptionSlot,
      subjectsSlot,
      genresSlot,
      themesSlot,
      awardsSlot,
      seriesSlot,
      nodeActions(
        id,
        node,
        mapAuthor ? [button(`Map ${mapAuthor.name}`, () => actions.openAuthor(mapAuthor.key, mapAuthor.name))] : [],
      ),
      relatedSection(node, token),
      alsoSlot,
      h('div', { class: 'section' }, catalogueLink, articleLink),
    );

    ol.bookByKey(node.key)
      .then((book) => {
        if (token !== detailToken) return;
        if (book.year && !known.fromWikidata) known.year = book.year;
        known.editions = book.editions;
        known.rating = book.rating;
        renderMeta();

        const subjects = subjectList(book.subjects.length ? book.subjects : node.subjects);
        if (subjects) subjectsSlot.replaceWith(subjects);

        prose.catalogue(book.description);
        catalogueLink.replaceWith(externalLink(ol.workUrl(book.key), 'Open on Open Library'));
      })
      .catch((err) => {
        if (token !== detailToken) return;
        known.error = err.message || '';
        renderMeta();
        prose.catalogue('');
      });

    loadFacts(node, token, {
      known,
      renderMeta,
      prose,
      head,
      slots: { genres: genresSlot, themes: themesSlot, awards: awardsSlot, series: seriesSlot, article: articleLink },
    });

    if (mapAuthor) {
      ol.authorWorks(mapAuthor.key, 12)
        .then((works) => {
          if (token !== detailToken) return;
          const others = works.filter((w) => w.key !== node.key).slice(0, 6);
          if (!others.length) return;
          alsoSlot.replaceWith(
            h(
              'section',
              { class: 'section' },
              h('h3', { text: `More by ${mapAuthor.name}` }),
              h('p', { class: 'hint', text: 'Most republished first.' }),
              h(
                'ul',
                { class: 'link-list' },
                others.map((work) =>
                  pickableRow(
                    { kind: 'book', key: work.key, name: work.title, detail: mapAuthor.name, book: work, score: 0.5 },
                    { sub: work.year ? String(work.year) : '' },
                  ),
                ),
              ),
            ),
          );
        })
        .catch(() => {});
    }
  }

  /**
   * One paragraph about the thing selected. Open Library's own description is
   * preferred, and Wikipedia's lead fills in when there is none. The two arrive
   * in either order, so nothing is shown until it's clear which it will be.
   */
  function proseFor(slot, token) {
    const state = { catalogue: undefined, wikipedia: undefined, shown: false };
    const settle = () => {
      if (state.shown || token !== detailToken) return;
      if (state.catalogue) {
        state.shown = true;
        slot.replaceWith(h('p', { class: 'bio', text: state.catalogue }));
        return;
      }
      if (state.catalogue === undefined || state.wikipedia === undefined) return;
      state.shown = true;
      if (state.wikipedia) slot.replaceWith(wikipediaProse(state.wikipedia));
      else slot.remove();
    };
    return {
      catalogue(text) {
        state.catalogue = text || '';
        settle();
      },
      wikipedia(summary) {
        state.wikipedia = summary || null;
        settle();
      },
    };
  }

  /** Wikipedia's opening paragraph, credited: the text is theirs, under CC BY-SA. */
  const wikipediaProse = (summary) =>
    h(
      'div',
      {},
      h('p', { class: 'bio', text: summary.extract }),
      h('p', { class: 'credit' }, 'From ', externalLink(summary.url, 'Wikipedia'), '.'),
    );

  /**
   * A row of pills from one of Wikidata's vocabularies, each the way into a
   * map of everything filed under it — a subject map from a vocabulary no
   * library has. One without an ID is still worth showing, just not a click.
   */
  function renderPills(slot, heading, items, kind, className) {
    if (!items.length) {
      slot.remove();
      return;
    }
    const verb = {
      genre: 'Map everything Wikidata files as',
      theme: 'Map everything Wikidata says is about',
      award: 'Map everything that won',
    }[kind];
    const pills = items.map((item) =>
      item.qid
        ? h(
            'button',
            { type: 'button', class: 'tag', title: `${verb} “${item.label}”`, onClick: () => actions.exploreCollection(kind, item) },
            item.label,
            item.year ? h('span', { class: 'tag-year', text: formatYear(item.year) }) : null,
          )
        : h('span', { class: 'tag tag-static', text: item.label }),
    );
    slot.replaceWith(tagGroup(heading, pills, className));
  }

  /** What a writer won, as quiet pills. These aren't maps: most prizes for a career go to a person, not a book. */
  function renderAwards(slot, awards) {
    if (!awards.length) {
      slot.remove();
      return;
    }
    const pills = awards.map((award) =>
      h(
        'span',
        { class: 'tag tag-static' },
        award.label,
        award.years?.length ? h('span', { class: 'tag-year', text: award.years.map(formatYear).join(', ') }) : null,
      ),
    );
    slot.replaceWith(tagGroup('Awards', pills, 'awards'));
  }

  /**
   * Wikidata's account of a book, laid over the catalogue's: its genres as
   * pills under the subject headings, what it's about in Wikidata's own terms,
   * what it won, the series it belongs to, the year and language it first
   * appeared in, and — by way of Wikidata's link to the article — Wikipedia's
   * opening paragraph when Open Library has no description. Absent quietly for
   * the half of books Wikidata doesn't know.
   */
  function loadFacts(node, token, { known, renderMeta, prose, head, slots }) {
    const done = (facts) => {
      if (token !== detailToken) return;
      const genres = node.genres?.length ? node.genres : facts?.genres || [];
      renderPills(slots.genres, 'Wikidata genres', genres.filter((g) => g.label && !isFormOnly(g.label)).slice(0, 4), 'genre', 'genres');
      renderPills(slots.themes, 'Wikidata themes', (facts?.themes || []).slice(0, 5), 'theme', 'themes');
      renderPills(slots.awards, 'Awards', (facts?.awards || []).slice(0, 4), 'award', 'awards');

      if (facts?.series) {
        const { label, ordinal } = facts.series;
        slots.series.replaceWith(
          h('p', { class: 'hint series', text: ordinal ? `Book ${ordinal} in the ${label} series.` : `Part of the ${label} series.` }),
        );
      } else {
        slots.series.remove();
      }

      if (facts?.year) {
        known.year = facts.year;
        known.fromWikidata = true;
        // Only a language other than English is worth a word: that a book was
        // written in Polish is the fact; that it was written in English isn't.
        known.language = facts.language && !/english/i.test(facts.language.label) ? facts.language.label : '';
        renderMeta();
      }

      if (!facts?.article) {
        slots.article.remove();
        prose.wikipedia(null);
        return;
      }
      slots.article.replaceWith(externalLink(facts.article, 'Read on Wikipedia'));
      wp.summaryFor(facts.article)
        .then((summary) => {
          if (token !== detailToken) return;
          prose.wikipedia(summary);
          // Wikipedia's picture stands in when Open Library has no cover.
          if (summary?.thumbnail && !node.coverId && !head.querySelector('.cover')) {
            const figure = coverImage(summary.thumbnail, `Cover of ${node.label}`);
            if (figure) head.prepend(figure);
          }
        })
        .catch(() => prose.wikipedia(null));
    };

    if (!/^OL\d+W$/.test(node.key || '')) {
      done(null);
      return;
    }
    wd.workFacts(node.key)
      .then(done)
      .catch(() => done(null));
  }

  // ---------- Author ----------

  function showAuthor(id, node, relation) {
    const token = ++detailToken;
    const meta = h('p', { class: 'meta', text: 'Loading details…' });
    const subjectsSlot = h('div');
    const awardsSlot = h('div');
    const influenceSlot = h('div');
    const worksSlot = h('section', { class: 'section' }, h('h3', { text: 'Best known for' }), skeletonList());
    const bioSlot = h('div');
    const linkSlot = h('div');
    const headingSlot = h('div', { class: 'detail-head' });
    const prose = proseFor(bioSlot, token);

    // Once Wikidata has answered: the prizes, and Wikipedia's paragraph when
    // Open Library had no biography, with its portrait when there was no photo.
    const onFacts = (facts) => {
      renderAwards(awardsSlot, facts?.awards || []);
      if (!facts?.article) {
        prose.wikipedia(null);
        return;
      }
      wp.summaryFor(facts.article)
        .then((summary) => {
          if (token !== detailToken) return;
          prose.wikipedia(summary);
          if (summary?.thumbnail && !headingSlot.querySelector('.portrait')) {
            const photo = coverImage(summary.thumbnail, `Photograph of ${node.label}`, 'portrait');
            if (photo) headingSlot.prepend(photo);
          }
        })
        .catch(() => prose.wikipedia(null));
    };

    headingSlot.append(
      h(
        'div',
        { class: 'detail-headings' },
        h('p', { class: 'kind', text: 'Author' }),
        h('h2', { class: 'panel-title', text: node.label }),
      ),
    );

    show(
      headingSlot,
      relation ? h('p', { class: 'relation', text: relation }) : null,
      meta,
      // Who the writer is comes before what they're filed under.
      bioSlot,
      subjectsSlot,
      awardsSlot,
      nodeActions(id, node, [button('Trace their influence', () => actions.openInfluence(node.key, node.label))]),
      influenceSlot,
      worksSlot,
      linkSlot,
    );

    // An author found only through Wikidata may have no Open Library record at
    // all, in which case there's nothing to look up here.
    const openLibraryKey = /^OL\d+A$/.test(node.key || '') ? node.key : node.openLibrary;

    if (openLibraryKey) {
      ol.authorByKey(openLibraryKey)
        .then((author) => {
          if (token !== detailToken) return;
          const span = lifespan(author.birth, author.death);
          meta.textContent = span || '';
          const photo = coverImage(ol.authorPhotoUrl(author.photoId, 'M'), `Photograph of ${author.name}`, 'portrait');
          if (photo) headingSlot.prepend(photo);
          prose.catalogue(author.bio);
          linkSlot.replaceWith(h('div', { class: 'section' }, externalLink(ol.authorUrl(author.key), 'Open on Open Library')));
          loadInfluence(author.wikidata || node.qid, node, token, influenceSlot, meta, onFacts);
        })
        .catch(() => {
          if (token === detailToken) {
            meta.textContent = '';
            prose.catalogue('');
            loadInfluence(node.qid, node, token, influenceSlot, meta, onFacts);
          }
        });

      ol.authorWorks(openLibraryKey, 12)
        .then((works) => {
          if (token !== detailToken) return;
          if (!works.length) {
            worksSlot.remove();
            return;
          }
          worksSlot.replaceChildren(
            h('h3', { text: 'Best known for' }),
            h('p', { class: 'hint', text: 'Most republished first. Pick one to map books like it.' }),
            h(
              'ul',
              { class: 'link-list' },
              works.slice(0, 7).map((work) =>
                h(
                  'li',
                  {},
                  h(
                    'button',
                    { type: 'button', class: 'list-button', onClick: () => actions.openBook(work.key, work.title) },
                    h('span', { class: 'list-main', text: work.title }),
                    h('span', {
                      class: 'list-sub',
                      text: work.editions ? `${formatCount(work.editions)} editions` : work.year ? String(work.year) : '',
                    }),
                  ),
                ),
              ),
            ),
          );
        })
        .catch(() => {
          if (token === detailToken) worksSlot.remove();
        });
    } else {
      meta.textContent = 'Not on Open Library, so there are no books to show here.';
      worksSlot.remove();
      prose.catalogue('');
      linkSlot.remove();
      loadInfluence(node.qid, node, token, influenceSlot, meta, onFacts);
    }
  }

  /**
   * Wikidata's account of a writer: the one-line description, what they're
   * filed under, and the two lists that are the reason this app talks to
   * Wikidata at all.
   */
  function loadInfluence(qid, node, token, slot, meta, onFacts = () => {}) {
    if (!qid) {
      slot.remove();
      onFacts(null);
      return;
    }
    slot.replaceWith(
      (slot = h('section', { class: 'section' }, h('h3', { text: 'Influence' }), skeletonList())),
    );

    wd.authorFacts(qid)
      .then((facts) => {
        if (token !== detailToken) return;
        onFacts(facts);
        if (!facts) {
          slot.replaceChildren(
            h('h3', { text: 'Influence' }),
            h('p', {
              class: 'hint',
              text: "Wikidata didn't answer. It's free and sometimes busy — everything else on this map works without it.",
            }),
          );
          return;
        }

        if (facts.description && meta && !meta.textContent) meta.textContent = facts.description;

        const lines = [];
        if (facts.genres.length) lines.push(`Works in ${formatList(facts.genres.slice(0, 3))}.`);
        if (facts.movements.length) lines.push(`Associated with ${formatList(facts.movements.slice(0, 2))}.`);

        const peopleList = (people, heading, hint) =>
          people.length
            ? h(
                'div',
                { class: 'subsection' },
                h('h4', { text: heading }),
                h('p', { class: 'hint', text: hint }),
                h(
                  'ul',
                  { class: 'link-list' },
                  people.slice(0, 12).map((person) =>
                    h(
                      'li',
                      {},
                      h(
                        'button',
                        {
                          type: 'button',
                          class: 'list-button',
                          onClick: () => actions.openPerson(person),
                        },
                        h('span', { class: 'list-main', text: person.name }),
                        h('span', { class: 'list-add', html: icons.influence }),
                      ),
                    ),
                  ),
                ),
              )
            : null;

        const anything = facts.influencedBy.length || facts.influenced.length;
        // replaceChildren is the native call, which turns a null into the
        // text "null", so anything conditional has to be filtered out first.
        const parts = [
          h('h3', { text: 'Influence' }),
          lines.length ? h('p', { class: 'hint', text: lines.join(' ') }) : null,
          anything
            ? null
            : h('p', {
                class: 'hint',
                text: `Wikidata records no influence either way for ${node.label}. Its coverage runs deep for some writers and stops dead for others.`,
              }),
          peopleList(facts.influencedBy, 'Read and absorbed', `Writers Wikidata records as shaping ${node.label}.`),
          peopleList(facts.influenced, 'Went on to shape', `Writers who name ${node.label} as an influence.`),
          anything
            ? h(
                'div',
                { class: 'actions' },
                button('Map this as a network', () => actions.openInfluence(node.key, node.label)),
              )
            : null,
          facts.article ? h('div', { class: 'subsection' }, externalLink(facts.article, 'Read on Wikipedia')) : null,
        ];
        slot.replaceChildren(...parts.filter(Boolean));
      })
      .catch(() => {
        if (token !== detailToken) return;
        onFacts(null);
        slot.remove();
      });
  }

  // ---------- Paths ----------

  function showPath({ from, to, steps, note }) {
    detailToken++;
    show(
      h('h2', { class: 'panel-title', text: `From ${from} to ${to}` }),
      h('p', {
        class: 'meta',
        text: `${steps.length} books, each one the closest thing on the shelf to the last.`,
      }),
      note ? h('p', { class: 'note', text: note }) : null,
      h(
        'ol',
        { class: 'path-list' },
        steps.map((step) =>
          h(
            'li',
            {},
            h(
              'button',
              {
                type: 'button',
                class: 'list-button',
                onClick: () => actions.selectNode(step.id, { focus: true, keepPath: true }),
              },
              h('span', { class: 'list-main', text: step.label }),
              step.sub ? h('span', { class: 'list-sub', text: step.sub }) : null,
            ),
          ),
        ),
      ),
      h(
        'div',
        { class: 'actions' },
        button('Copy as a reading list', actions.copyReadingList),
        button('Clear the path', actions.clearPath),
      ),
    );
  }

  return {
    showOverview,
    showLoading,
    showBook,
    showAuthor,
    showPath,
    hide() {
      detailToken++;
      root.hidden = true;
    },
  };
}
