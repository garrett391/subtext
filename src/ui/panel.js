import * as ol from '../api/openlibrary.js';
import * as wd from '../api/wikidata.js';
import { h, icons, formatCount, lifespan, titleCaseSubject, formatList } from './dom.js';
import { distinctiveSubjects } from '../graph/subjects.js';

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

  const subjectList = (subjects) => {
    const picks = distinctiveSubjects(subjects, null, 8);
    return picks.length
      ? h(
          'div',
          { class: 'tag-list' },
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
        )
      : null;
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
    const alsoSlot = h('div');
    const descriptionSlot = h('div');

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

    show(
      h(
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
      ),
      relation ? h('p', { class: 'relation', text: relation }) : null,
      meta,
      subjectsSlot,
      nodeActions(
        id,
        node,
        mapAuthor ? [button(`Map ${mapAuthor.name}`, () => actions.openAuthor(mapAuthor.key, mapAuthor.name))] : [],
      ),
      relatedSection(node, token),
      alsoSlot,
      descriptionSlot,
    );

    ol.bookByKey(node.key)
      .then((book) => {
        if (token !== detailToken) return;
        const parts = [];
        if (book.year) parts.push(`First published ${book.year}`);
        if (book.editions) parts.push(`${formatCount(book.editions)} editions`);
        if (book.rating) parts.push(`rated ${book.rating} of 5`);
        meta.textContent = parts.join(' · ') || '';

        const subjects = subjectList(book.subjects.length ? book.subjects : node.subjects);
        if (subjects) subjectsSlot.replaceWith(subjects);

        descriptionSlot.replaceWith(
          h(
            'div',
            { class: 'section' },
            book.description ? h('p', { class: 'bio', text: book.description }) : null,
            externalLink(ol.workUrl(book.key), 'Open on Open Library'),
          ),
        );
      })
      .catch((err) => {
        if (token === detailToken) meta.textContent = err.message || '';
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

  // ---------- Author ----------

  function showAuthor(id, node, relation) {
    const token = ++detailToken;
    const meta = h('p', { class: 'meta', text: 'Loading details…' });
    const subjectsSlot = h('div');
    const influenceSlot = h('div');
    const worksSlot = h('section', { class: 'section' }, h('h3', { text: 'Best known for' }), skeletonList());
    const bioSlot = h('div');
    const headingSlot = h('div', { class: 'detail-head' });

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
      subjectsSlot,
      nodeActions(id, node, [button('Trace their influence', () => actions.openInfluence(node.key, node.label))]),
      influenceSlot,
      worksSlot,
      bioSlot,
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
          bioSlot.replaceWith(
            h(
              'div',
              { class: 'section' },
              author.bio ? h('p', { class: 'bio', text: author.bio }) : null,
              externalLink(ol.authorUrl(author.key), 'Open on Open Library'),
            ),
          );
          loadInfluence(author.wikidata || node.qid, node, token, influenceSlot, meta);
        })
        .catch(() => {
          if (token === detailToken) {
            meta.textContent = '';
            loadInfluence(node.qid, node, token, influenceSlot, meta);
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
      bioSlot.remove();
      loadInfluence(node.qid, node, token, influenceSlot, meta);
    }
  }

  /**
   * Wikidata's account of a writer: the one-line description, what they're
   * filed under, and the two lists that are the reason this app talks to
   * Wikidata at all.
   */
  function loadInfluence(qid, node, token, slot, meta) {
    if (!qid) {
      slot.remove();
      return;
    }
    slot.replaceWith(
      (slot = h('section', { class: 'section' }, h('h3', { text: 'Influence' }), skeletonList())),
    );

    wd.authorFacts(qid)
      .then((facts) => {
        if (token !== detailToken) return;
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
        if (token === detailToken) slot.remove();
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
