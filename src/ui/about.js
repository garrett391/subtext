import { clearCache } from '../api/cache.js';
import { h, icons } from './dom.js';

/**
 * Undertone opened with a dialog asking for an API key. Subtext has nothing to
 * ask for: Open Library and Wikidata are both open, so this is only here to say
 * where the data comes from and to let someone clear what's been saved.
 */
export function createAbout() {
  const dialog = h('dialog', { class: 'settings', 'aria-labelledby': 'about-title' });
  document.body.append(dialog);

  const link = (href, label) =>
    h('a', { class: 'text-link', href, target: '_blank', rel: 'noopener noreferrer' }, label, h('span', { class: 'link-icon', html: icons.external }));

  function render() {
    const clearButton = h(
      'button',
      {
        type: 'button',
        class: 'button',
        onClick: async () => {
          clearButton.disabled = true;
          await clearCache();
          clearButton.textContent = 'Saved results cleared';
          clearButton.disabled = false;
        },
      },
      'Clear saved results',
    );

    dialog.replaceChildren(
      h('h2', { id: 'about-title', text: 'Where this comes from' }),
      h('p', {
        class: 'dialog-lead',
        text: 'Subtext draws maps of books from two open sources. Neither needs an account or an API key, which is why there is nothing to set up here.',
      }),
      h(
        'section',
        { class: 'section' },
        h('h3', { text: 'Open Library' }),
        h('p', {
          class: 'hint',
          text: 'The Internet Archive’s catalogue: titles, authors, covers, and the subject headings every map is built from. Similarity here means two books are catalogued under the same specific subjects — which is a real signal, and a different one from what readers think goes together.',
        }),
        link('https://openlibrary.org', 'openlibrary.org'),
      ),
      h(
        'section',
        { class: 'section' },
        h('h3', { text: 'Wikidata' }),
        h('p', {
          class: 'hint',
          text: 'Supplies the influence arrows, from claims editors have recorded that one writer shaped another. Coverage is deep for well-documented writers and empty for many others, and it is an argument rather than a measurement. When Wikidata is busy, the arrows are missing and nothing else changes.',
        }),
        link('https://www.wikidata.org', 'wikidata.org'),
      ),
      h(
        'section',
        { class: 'section' },
        h('h3', { text: 'Saved results' }),
        h('p', {
          class: 'hint',
          text: 'Answers are kept in this browser for a week, so maps you have already opened come back instantly and two free services aren’t asked the same question twice. Nothing leaves your machine.',
        }),
        clearButton,
      ),
      h('div', { class: 'dialog-actions' }, h('button', { type: 'button', class: 'button primary', onClick: () => dialog.close() }, 'Close')),
    );
  }

  return {
    open() {
      render();
      dialog.showModal();
    },
  };
}
