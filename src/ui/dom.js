export function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props || {})) {
    if (value == null || value === false) continue;
    if (key === 'class') el.className = value;
    else if (key === 'text') el.textContent = value;
    else if (key === 'html') el.innerHTML = value; // Only ever used with the static icons below.
    else if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2).toLowerCase(), value);
    else el.setAttribute(key, value === true ? '' : value);
  }
  for (const child of children.flat()) {
    if (child == null || child === false) continue;
    el.append(child instanceof Node ? child : String(child));
  }
  return el;
}

const svg = (paths, size = 18) =>
  `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;

export const icons = {
  search: svg('<circle cx="11" cy="11" r="6.5"/><path d="m20 20-4.2-4.2"/>'),
  close: svg('<path d="M6 6l12 12M18 6 6 18"/>'),
  back: svg('<path d="M15 5l-7 7 7 7"/>'),
  plus: svg('<path d="M12 5v14M5 12h14"/>'),
  minus: svg('<path d="M5 12h14"/>'),
  fit: svg('<path d="M4 9V5h4M20 9V5h-4M4 15v4h4M20 15v4h-4"/>'),
  about: svg('<circle cx="12" cy="12" r="8.5"/><path d="M12 11v5"/><path d="M12 8.2v.1"/>'),
  external: svg('<path d="M14 5h5v5M19 5l-8 8M17 14v5H5V7h5"/>'),
  copy: svg('<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M15 5.5A1.5 1.5 0 0 0 13.5 4H6a2 2 0 0 0-2 2v7.5A1.5 1.5 0 0 0 5.5 15"/>'),
  // A spine and a fore edge: a book seen from the side.
  book: svg('<path d="M5 4.5h11a2 2 0 0 1 2 2V20H7a2 2 0 0 1-2-2z"/><path d="M5 17.5h13"/>'),
  person: svg('<circle cx="12" cy="8.5" r="3.6"/><path d="M5.5 20a6.5 6.5 0 0 1 13 0"/>'),
  subject: svg('<path d="M4 7h16M4 12h11M4 17h7"/>'),
  // The arrow of descent, which is what an influence claim is.
  influence: svg('<path d="M4 12h13"/><path d="m13 7.5 4.5 4.5-4.5 4.5"/>'),
};

export const formatCount = (n) =>
  new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }).format(n);

export const formatList = (items) => new Intl.ListFormat('en', { type: 'conjunction' }).format(items);

/** "1953" and "20 April 1953" both become "1953". Open Library dates vary wildly. */
export function yearOf(date) {
  const match = /\d{4}/.exec(String(date || ''));
  return match ? match[0] : '';
}

export function lifespan(birth, death) {
  const from = yearOf(birth);
  const to = yearOf(death);
  if (!from && !to) return '';
  if (from && to) return `${from}–${to}`;
  return from ? `born ${from}` : `died ${to}`;
}

/** Sentence case for library subjects, which arrive shouting or lowercase at random. */
export function titleCaseSubject(subject) {
  const text = String(subject || '').trim();
  if (!text) return '';
  if (text === text.toUpperCase() && text.length > 3) {
    return text.charAt(0) + text.slice(1).toLowerCase();
  }
  return text.charAt(0).toUpperCase() + text.slice(1);
}
