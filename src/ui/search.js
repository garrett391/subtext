import * as ol from '../api/openlibrary.js';
import { h, icons, formatCount, lifespan, titleCaseSubject } from './dom.js';

const MAX_SUBJECTS = 4;

/**
 * Library subjects are phrased in ways nobody guesses — "Comic books, strips,
 * etc." is the heading half of comics history sits under. This is a starting
 * vocabulary of headings that do reliably return books, weighted toward what a
 * writing class is likely to be researching. Anything not here can still be
 * typed in; this is a way in, not a limit.
 */
const VOCABULARY = [
  // Comics and graphic narrative
  'graphic novels',
  'comic books, strips, etc',
  'superheroes',
  'manga',
  'cartoons and comics',
  'comic strips',
  'caricatures and cartoons',
  'wit and humor, pictorial',
  // Kinds of story
  'science fiction',
  'fantasy fiction',
  'detective and mystery stories',
  'horror tales',
  'ghost stories',
  'historical fiction',
  'dystopias',
  'utopias',
  'adventure stories',
  'love stories',
  'war stories',
  'short stories',
  'fairy tales',
  'folklore',
  'mythology',
  'satire',
  'fables',
  'epic literature',
  'tragedy',
  'comedy',
  // Form and craft
  'authorship',
  'creative writing',
  'fiction technique',
  'narration (rhetoric)',
  'plots (drama, novel, etc)',
  'characters and characteristics in literature',
  'dialogue',
  'poetics',
  'storytelling',
  'screenwriting',
  'playwriting',
  'editing',
  // Mode and register
  'magic realism (literature)',
  'stream of consciousness fiction',
  'experimental fiction',
  'noir fiction',
  'gothic fiction',
  'bildungsromans',
  'picaresque literature',
  'psychological fiction',
  'domestic fiction',
  'road fiction',
  'campus fiction',
  'alternative histories (fiction)',
  'time travel',
  'apocalyptic literature',
  'space warfare',
  'cyberpunk',
  'steampunk',
  // Subject matter
  'coming of age',
  'grief',
  'memory',
  'immigrants',
  'exiles',
  'war',
  'refugees',
  'race relations',
  'identity',
  'sexuality',
  'mental illness',
  'addiction',
  'work',
  'rural life',
  'city and town life',
  'wilderness',
  'travel',
  'islands',
  'prisons',
  'orphans',
  'sisters',
  'brothers',
  'fathers and sons',
  'mothers and daughters',
  'artists',
  'musicians',
  'teachers',
  'detectives',
  'spies',
  'ghosts',
  'vampires',
  'monsters',
  'robots',
  'artificial intelligence',
  'animals',
  'food',
  'gardens',
  'the sea',
  'winter',
  // Nonfiction shapes
  'biography',
  'autobiography',
  'essays',
  'diaries',
  'letters',
  'journalism',
  'travel writing',
  'nature writing',
  'true crime',
  'oral history',
  'philosophy',
  'psychology',
  'anthropology',
];

const STARTERS = [
  'graphic novels',
  'comic books, strips, etc',
  'superheroes',
  'dystopias',
  'magic realism (literature)',
  'authorship',
  'bildungsromans',
  'noir fiction',
];

export function createSearch(root, handlers) {
  const {
    onPickBook,
    onPickAuthor,
    onPickNode,
    onPickEnd,
    onSubjectsChange,
    findOnMap,
  } = handlers;

  // 'browse' is the normal state. In 'pickEnd', a choice becomes the far end of
  // a path instead of a new map, so subjects are hidden and the wording changes.
  let mode = 'browse';
  let subjects = [];
  let options = [];
  let activeIndex = -1;
  let requestId = 0;
  let debounce = null;

  const input = h('input', {
    type: 'text',
    id: 'search-input',
    placeholder: 'Search books, authors, or a subject',
    autocomplete: 'off',
    spellcheck: 'false',
    role: 'combobox',
    'aria-expanded': 'false',
    'aria-controls': 'search-results',
    'aria-autocomplete': 'list',
    'aria-label': 'Search books, authors, or a subject',
  });

  const clearButton = h('button', {
    type: 'button',
    class: 'icon-button clear',
    'aria-label': 'Clear search',
    html: icons.close,
    hidden: true,
    onClick: () => {
      input.value = '';
      clearButton.hidden = true;
      input.focus();
      update();
    },
  });

  const list = h('ul', { id: 'search-results', class: 'results', role: 'listbox', hidden: true });
  const chips = h('div', { class: 'chips', 'aria-label': 'Subjects on this map' });

  root.append(
    h('div', { class: 'field' }, h('span', { class: 'field-icon', html: icons.search }), input, clearButton),
    list,
    chips,
  );

  // ---------- Results ----------

  function setOpen(open) {
    list.hidden = !open;
    input.setAttribute('aria-expanded', String(open));
    if (!open) {
      activeIndex = -1;
      input.removeAttribute('aria-activedescendant');
    }
  }

  function renderGroups(groups, message) {
    list.replaceChildren();
    options = [];
    if (message) list.append(h('li', { class: 'message', role: 'presentation', text: message }));

    for (const group of groups) {
      if (!group.items.length) continue;
      list.append(h('li', { class: 'group-label', role: 'presentation', text: group.label }));
      for (const item of group.items) {
        const index = options.length;
        options.push(item);
        list.append(
          h(
            'li',
            {
              id: `search-option-${index}`,
              class: 'option',
              role: 'option',
              'aria-selected': 'false',
              onMousedown: (event) => event.preventDefault(),
              onClick: () => pick(item),
              onMousemove: () => setActive(index),
            },
            h('span', { class: 'option-icon', html: icons[item.icon] || '' }),
            h(
              'span',
              { class: 'option-main' },
              h('span', { class: 'option-name', text: item.primary }),
              item.detail ? h('span', { class: 'option-detail', text: item.detail }) : null,
            ),
            item.secondary ? h('span', { class: 'option-sub', text: item.secondary }) : null,
          ),
        );
      }
    }
    setOpen(list.children.length > 0);
  }

  function setActive(index) {
    activeIndex = index;
    list.querySelectorAll('.option').forEach((el, i) => el.setAttribute('aria-selected', String(i === index)));
    if (index >= 0) {
      input.setAttribute('aria-activedescendant', `search-option-${index}`);
      list.querySelector(`#search-option-${index}`)?.scrollIntoView({ block: 'nearest' });
    } else {
      input.removeAttribute('aria-activedescendant');
    }
  }

  const flatten = (s) =>
    String(s)
      .toLowerCase()
      .normalize('NFD')
      .replace(/\p{Diacritic}/gu, '');

  // Nodes already drawn on the canvas. These need no request, so they can be
  // shown the moment you type — useful on a dense map, or on touch where
  // there's no hover to read a label with.
  function mapOptions(query) {
    return (findOnMap?.(flatten(query)) || []).map((node) => ({
      type: 'node',
      id: node.id,
      icon: node.kind === 'author' ? 'person' : 'book',
      name: node.label,
      primary: node.label,
      detail: node.byline || '',
      secondary: '',
    }));
  }

  function subjectOptions(query) {
    const available = (name) => !subjects.some((s) => s.toLowerCase() === name.toLowerCase());
    if (!query) {
      return STARTERS.filter(available).map((name) => ({
        type: 'subject',
        icon: 'subject',
        name,
        primary: titleCaseSubject(name),
      }));
    }
    const q = query.toLowerCase();
    const starts = VOCABULARY.filter((s) => s.startsWith(q) && available(s));
    const contains = VOCABULARY.filter((s) => !s.startsWith(q) && s.includes(q) && available(s));
    return [...starts, ...contains].slice(0, 5).map((name) => ({
      type: 'subject',
      icon: 'subject',
      name,
      primary: titleCaseSubject(name),
    }));
  }

  async function update() {
    const query = input.value.trim();
    clearButton.hidden = !input.value;
    const id = ++requestId;

    if (query.length < 2) {
      const starters = mode === 'browse' && subjects.length < MAX_SUBJECTS ? subjectOptions('') : [];
      if (document.activeElement === input && starters.length) {
        renderGroups([
          { label: subjects.length ? 'Add another subject' : 'Start with a subject', items: starters },
        ]);
      } else {
        setOpen(false);
      }
      return;
    }

    const onMap = { label: 'On this map', items: mapOptions(query) };
    const guessed = {
      label: 'Subjects',
      items: mode === 'browse' && subjects.length < MAX_SUBJECTS ? subjectOptions(query) : [],
    };
    renderGroups([onMap, guessed], 'Searching…');

    try {
      const [books, authors, cataloguedSubjects] = await Promise.all([
        ol.searchBooks(query, 5),
        ol.searchAuthors(query, 4),
        mode === 'browse' && subjects.length < MAX_SUBJECTS ? ol.searchSubjects(query, 5) : Promise.resolve([]),
      ]);
      if (id !== requestId) return;

      const drawn = new Set(onMap.items.map((i) => flatten(i.name)));

      const bookGroup = {
        label: 'Books',
        items: books
          .filter((book) => !drawn.has(flatten(book.title)))
          .map((book) => ({
            type: 'book',
            icon: 'book',
            key: book.key,
            name: book.title,
            book,
            primary: book.title,
            detail: ol.byline(book),
            // Edition count tells a canonical work from a reissue, a tie-in, and
            // a study guide with the same title.
            secondary: book.editions ? `${formatCount(book.editions)} editions` : book.year ? String(book.year) : '',
          })),
      };

      const authorGroup = {
        label: 'Authors',
        items: authors
          .filter((author) => !drawn.has(flatten(author.name)))
          .map((author) => ({
            type: 'author',
            icon: 'person',
            key: author.key,
            name: author.name,
            author,
            primary: author.name,
            detail: lifespan(author.birth, author.death),
            secondary: author.workCount ? `${formatCount(author.workCount)} books` : '',
          })),
      };

      // Subjects Open Library actually recognises, with the number of books
      // behind each, merged into the guesses from the built-in vocabulary.
      const known = new Set(guessed.items.map((i) => i.name.toLowerCase()));
      for (const subject of cataloguedSubjects) {
        const name = subject.name.toLowerCase();
        if (known.has(name) || subjects.some((s) => s.toLowerCase() === name)) continue;
        known.add(name);
        guessed.items.push({
          type: 'subject',
          icon: 'subject',
          name: subject.name,
          primary: titleCaseSubject(subject.name),
          secondary: subject.workCount ? `${formatCount(subject.workCount)} books` : '',
        });
      }
      guessed.items = guessed.items.slice(0, 6);

      if (mode === 'browse' && subjects.length < MAX_SUBJECTS && !known.has(query.toLowerCase())) {
        guessed.items.push({
          type: 'subject',
          icon: 'subject',
          name: query,
          primary: `Use “${query}” as a subject`,
        });
      }

      // An exact subject match is almost certainly what was meant.
      const exact = VOCABULARY.includes(query.toLowerCase());
      const rest = exact ? [guessed, bookGroup, authorGroup] : [bookGroup, authorGroup, guessed];
      const groups = [onMap, ...rest];
      const empty = groups.every((g) => !g.items.length);
      renderGroups(groups, empty ? `Open Library has nothing matching “${query}”.` : null);
    } catch (err) {
      if (id !== requestId) return;
      renderGroups([guessed], err.message);
    }
  }

  function pick(item) {
    if (item.type === 'subject') {
      input.value = '';
      clearButton.hidden = true;
      setSubjects([...subjects, item.name]);
      onSubjectsChange(subjects);
      update();
      return;
    }

    input.value = '';
    clearButton.hidden = true;
    setOpen(false);
    input.blur();

    if (mode === 'pickEnd') {
      onPickEnd(
        item.type === 'node'
          ? { node: item.id }
          : { kind: item.type, key: item.key, name: item.name },
      );
      return;
    }
    if (item.type === 'node') onPickNode(item.id);
    if (item.type === 'book') onPickBook(item.key, item.name);
    if (item.type === 'author') onPickAuthor(item.key, item.name);
  }

  // ---------- Chips ----------

  function setSubjects(next) {
    const seen = new Set();
    subjects = next
      .filter((s) => {
        const key = s.toLowerCase();
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .slice(0, MAX_SUBJECTS);

    chips.replaceChildren(
      ...subjects.map((subject) =>
        h(
          'button',
          {
            type: 'button',
            class: 'chip',
            'aria-label': `Remove ${subject}`,
            onClick: () => {
              setSubjects(subjects.filter((s) => s !== subject));
              onSubjectsChange(subjects);
            },
          },
          h('span', { text: titleCaseSubject(subject) }),
          h('span', { class: 'chip-x', html: icons.close }),
        ),
      ),
    );
    chips.hidden = subjects.length === 0;
  }
  setSubjects([]);

  // ---------- Events ----------

  input.addEventListener('input', () => {
    clearTimeout(debounce);
    debounce = setTimeout(update, 280);
  });
  input.addEventListener('focus', update);
  input.addEventListener('blur', () => setTimeout(() => setOpen(false), 120));
  input.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowDown' && options.length) {
      event.preventDefault();
      if (list.hidden) setOpen(true);
      setActive((activeIndex + 1) % options.length);
    } else if (event.key === 'ArrowUp' && options.length) {
      event.preventDefault();
      setActive(activeIndex <= 0 ? options.length - 1 : activeIndex - 1);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      const choice = options[activeIndex] || options[0];
      if (choice && !list.hidden) pick(choice);
    } else if (event.key === 'Escape') {
      if (!list.hidden) setOpen(false);
      else input.blur();
    } else if (event.key === 'Backspace' && !input.value && subjects.length) {
      setSubjects(subjects.slice(0, -1));
      onSubjectsChange(subjects);
    }
  });

  return {
    setSubjects,
    setMode(next) {
      mode = next;
      input.placeholder =
        next === 'pickEnd' ? 'Search for the other end of the path' : 'Search books, authors, or a subject';
      input.setAttribute('aria-label', input.placeholder);
      // Switching modes changes what a search means, so any half-typed query goes.
      input.value = '';
      clearButton.hidden = true;
      setOpen(false);
      // On touch, focusing would raise the keyboard over the map the person is
      // about to tap, so the search bar waits to be reached for.
      if (next === 'pickEnd' && !window.matchMedia('(pointer: coarse)').matches) input.focus();
    },
    clearText() {
      input.value = '';
      clearButton.hidden = true;
      setOpen(false);
    },
    focus: () => input.focus(),
    getSubjects: () => [...subjects],
  };
}
