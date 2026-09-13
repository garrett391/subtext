import './style.css';
import * as ol from './api/openlibrary.js';
import {
  buildBookMap,
  buildAuthorMap,
  buildSubjectMap,
  buildInfluenceMap,
  buildPathMap,
  expandNode,
  attachNode,
  relatedBooks,
  connectionBetween,
  bookId,
  authorId,
  StaleError,
  EmptyMapError,
  PathNotFoundError,
  PATH_BUDGET,
} from './graph/build.js';
import { analyze, smoothestPath, farthestFrom, hopsBetween } from './graph/analysis.js';
import { createGraphView } from './ui/graphView.js';
import { createSearch } from './ui/search.js';
import { createPanel } from './ui/panel.js';
import { createStatus } from './ui/status.js';
import { createAbout } from './ui/about.js';
import { createSheet } from './ui/sheet.js';
import { icons, formatList, titleCaseSubject } from './ui/dom.js';
import { createSpectrum } from './graph/color.js';

const $ = (id) => document.getElementById(id);

const app = {
  route: null,
  graph: null,
  seedId: null,
  seedLabel: null,
  seedSubtitle: null,
  nodeKind: 'book',
  analysis: { communities: {}, sceneCount: 0, bridges: [] },
  selectedId: null,
  pathFrom: null,
  path: null,
  pathShown: false,
  converted: [],
  counts: [],
  token: 0,
  trail: [],
};

// ---------- Components ----------

const view = createGraphView($('map'), {
  onSelect: (id) => selectNode(id),
  onExpand: (id) => expand(id),
  onBackground: () => clearSelection(),
  describe,
});

const status = createStatus($('status'));

const panel = createPanel($('panel'), {
  exploreSubject: (subject) => navigate({ type: 'subject', subjects: [subject] }),
  recenter,
  expand,
  startPath,
  somethingDifferent,
  openBook,
  openAuthor,
  openInfluence,
  openPerson,
  selectNode,
  clearPath,
  locate,
  openSimilar,
  relatedTo,
  copyReadingList,
});

const search = createSearch($('search'), {
  onPickBook: (key) => openBook(key),
  onPickAuthor: (key) => openAuthor(key),
  onPickNode: (id) => selectNode(id, { focus: true }),
  onPickEnd: finishPathWith,
  findOnMap,
  onSubjectsChange: (subjects) => {
    if (subjects.length) navigate({ type: 'subject', subjects });
    else if (app.route?.type === 'subject') location.hash = '';
  },
});

const about = createAbout();

// On phones the panel is a bottom sheet. When it snaps to a new height, the
// map's usable area changes, so the insets update and the view slides by half
// the difference to keep what you were looking at centred in the new space.
const sheet = createSheet($('panel'), {
  onSnap({ from, to }) {
    updateInsets();
    if (app.graph) view.nudge(0, -(to - from) / 2);
  },
});

// ---------- Routing ----------
// Maps live in the URL, so the browser's back button works and any map can be
// bookmarked or handed to a class.
//
// Books and authors are addressed by their Open Library ID rather than by name,
// because titles collide constantly: three books called Watchmen, forty called
// Persepolis. A route can also name something instead — `#book/q/Watchmen` —
// which is what the examples on the first screen use; that gets resolved once
// and the address bar rewritten to the stable form.

const enc = encodeURIComponent;
const WORK_ID = /^OL\d+W$/;
const AUTHOR_ID = /^OL\d+A$/;

function routeToHash(route) {
  if (route.type === 'book') {
    return route.key ? `#book/${route.key}` : `#book/q/${enc(route.query.title)}${route.query.author ? `/${enc(route.query.author)}` : ''}`;
  }
  if (route.type === 'author') {
    return route.key ? `#author/${route.key}` : `#author/q/${enc(route.query)}`;
  }
  if (route.type === 'influence') {
    return route.key ? `#influence/${route.key}` : `#influence/q/${enc(route.query)}`;
  }
  if (route.type === 'path') {
    return `#path/${route.from.kind}/${route.from.key}/to/${route.to.kind}/${route.to.key}`;
  }
  return `#subject/${route.subjects.map(enc).join('/')}`;
}

function readEndpoint(parts, i) {
  const kind = parts[i];
  const key = parts[i + 1];
  if (kind === 'book' && WORK_ID.test(key || '')) return [{ kind: 'book', key }, i + 2];
  if (kind === 'author' && AUTHOR_ID.test(key || '')) return [{ kind: 'author', key }, i + 2];
  return [null, i];
}

function hashToRoute(hash) {
  let parts;
  try {
    parts = hash.replace(/^#/, '').split('/').map(decodeURIComponent).filter((p, i) => p !== '' || i === 0);
  } catch {
    return null;
  }

  if (parts[0] === 'book') {
    if (parts[1] === 'q' && parts[2]) return { type: 'book', query: { title: parts[2], author: parts[3] || '' } };
    if (WORK_ID.test(parts[1] || '')) return { type: 'book', key: parts[1] };
    return null;
  }
  if (parts[0] === 'author' || parts[0] === 'influence') {
    const type = parts[0];
    if (parts[1] === 'q' && parts[2]) return { type, query: parts[2] };
    if (AUTHOR_ID.test(parts[1] || '')) return { type, key: parts[1] };
    return null;
  }
  if (parts[0] === 'path') {
    const [from, next] = readEndpoint(parts, 1);
    if (from && parts[next] === 'to') {
      const [to] = readEndpoint(parts, next + 1);
      if (to) return { type: 'path', from, to };
    }
    return null;
  }
  if (parts[0] === 'subject') {
    const subjects = parts.slice(1).filter(Boolean);
    if (subjects.length) return { type: 'subject', subjects };
  }
  return null;
}

function navigate(route) {
  const hash = routeToHash(route);
  if (location.hash === hash) load(route);
  else location.hash = hash;
}

window.addEventListener('hashchange', () => {
  const { trail } = app;
  if (trail.length >= 2 && trail[trail.length - 2] === location.hash) trail.pop();
  else trail.push(location.hash);
  const route = hashToRoute(location.hash);
  if (route) load(route);
  else showEmpty();
});

$('back').addEventListener('click', () => history.back());

function openBook(key, title) {
  if (WORK_ID.test(key || '')) navigate({ type: 'book', key });
  else if (title) navigate({ type: 'book', query: { title } });
}

function openAuthor(key, name) {
  if (AUTHOR_ID.test(key || '')) navigate({ type: 'author', key });
  else if (name) navigate({ type: 'author', query: name });
}

function openInfluence(key, name) {
  if (AUTHOR_ID.test(key || '')) navigate({ type: 'influence', key });
  else if (name) navigate({ type: 'influence', query: name });
}

/**
 * A writer named in Wikidata's influence lists. If they're already drawn, go to
 * them; if Wikidata knows their Open Library ID, open their map; otherwise look
 * the name up, which is what the ID would have saved.
 */
async function openPerson(person) {
  const existing = locate({ kind: 'author', key: person.openLibrary || person.qid, qid: person.qid });
  if (existing) {
    selectNode(existing, { focus: true });
    return;
  }
  if (AUTHOR_ID.test(person.openLibrary || '')) {
    openAuthor(person.openLibrary);
    return;
  }
  status.loading(`Looking up ${person.name} on Open Library`);
  try {
    const author = await ol.findAuthor(person.name);
    if (author) {
      status.hide();
      openAuthor(author.key);
    } else {
      status.info(`Open Library has no record for ${person.name}, so there are no books to map.`);
    }
  } catch (err) {
    status.error(err.message);
  }
}

function recenter(id) {
  const node = app.graph.getNodeAttributes(id);
  if (node.kind === 'author') openAuthor(node.key, node.label);
  else openBook(node.key, node.label);
}

// ---------- Loading maps ----------

const kindPlural = () => (app.nodeKind === 'author' ? 'writers' : 'books');

function titlesFor(route, result = {}) {
  if (route.type === 'book') {
    return {
      title: `Books beside ${result.seedLabel || route.query?.title || 'this one'}`,
      subtitle: result.seedSubtitle ? `by ${result.seedSubtitle}` : null,
    };
  }
  if (route.type === 'author') return { title: `Writers near ${result.seedLabel || route.query || 'this one'}` };
  if (route.type === 'influence') return { title: `Influence around ${result.seedLabel || route.query || 'this writer'}` };
  if (route.type === 'path') return { title: `From ${result.fromLabel || 'one book'} to ${result.toLabel || 'another'}` };
  return { title: `Books filed under ${formatList(route.subjects.map(titleCaseSubject))}` };
}

function setTitles({ title }) {
  $('map-title').textContent = title;
  document.title = `${title} | Subtext`;
}

/** Routes that name something instead of identifying it get resolved once, here. */
async function resolveRoute(route) {
  if (route.type === 'book' && route.query) {
    const book = await ol.findBook(route.query.title, route.query.author);
    if (!book) {
      throw new EmptyMapError(
        `Open Library has nothing called “${route.query.title}”. Search for it in the box above — the catalogue often files a book under a longer title.`,
      );
    }
    return { type: 'book', key: book.key };
  }
  if ((route.type === 'author' || route.type === 'influence') && route.query) {
    const author = await ol.findAuthor(route.query);
    if (!author) {
      throw new EmptyMapError(`Open Library has no author called “${route.query}”. Search for the name in the box above.`);
    }
    return { type: route.type, key: author.key };
  }
  return route;
}

async function load(incoming) {
  const token = ++app.token;
  Object.assign(app, {
    route: incoming,
    graph: null,
    seedId: null,
    seedLabel: null,
    seedSubtitle: null,
    selectedId: null,
    pathFrom: null,
    path: null,
    pathShown: false,
    converted: [],
    counts: [],
    nodeKind: incoming.type === 'author' || incoming.type === 'influence' ? 'author' : 'book',
  });
  app.analysis = { communities: {}, sceneCount: 0, bridges: [] };

  $('empty').hidden = true;
  $('controls').hidden = false;
  $('crumb').hidden = false;
  $('back').hidden = app.trail.length < 2;
  $('legend-text').textContent =
    incoming.type === 'influence' ? 'Arrows run from influence to influenced' : 'Closer colours, closer subjects';
  view.setPickMode(false);
  view.clear();
  search.setSubjects(incoming.type === 'subject' ? incoming.subjects : []);
  search.clearText();

  const titles = titlesFor(incoming);
  setTitles(titles);
  panel.showLoading(titles.title, titles.subtitle);
  sheet.reveal();
  updateInsets();

  const ctx = {
    check() {
      if (token !== app.token) throw new StaleError();
    },
    update(graph, options = {}) {
      if (token !== app.token) return;
      app.graph = graph;
      if ('centerId' in options) app.seedId = options.centerId;
      view.setGraph(graph, options);
    },
    progress(message) {
      if (token === app.token) status.loading(message);
    },
  };

  try {
    const route = await resolveRoute(incoming);
    ctx.check();
    if (route !== incoming) {
      // Swap the address bar to the stable form without adding a history entry
      // or firing another load.
      history.replaceState(null, '', routeToHash(route));
      app.trail[app.trail.length - 1] = location.hash;
      app.route = route;
    }

    let result;
    if (route.type === 'book') result = await buildBookMap(route.key, ctx);
    else if (route.type === 'author') result = await buildAuthorMap(route.key, ctx);
    else if (route.type === 'influence') result = await buildInfluenceMap(route.key, ctx);
    else if (route.type === 'path') {
      result = await buildPathMap(route.from, route.to, ctx, { budget: route.budget || PATH_BUDGET.default });
    } else result = await buildSubjectMap(route.subjects, ctx);
    ctx.check();

    Object.assign(app, {
      graph: result.graph,
      seedId: result.seedId ?? null,
      seedLabel: result.seedLabel ?? null,
      seedSubtitle: result.seedSubtitle ?? null,
      counts: result.counts || [],
      converted: result.converted || [],
    });
    setTitles(titlesFor(app.route, result));

    if (app.route.type === 'path') {
      view.setGraph(result.graph, { fresh: false, centerId: null });
      app.path = result.path;
      view.fit(true);
      refreshAnalysis();
      status.hide();
      showPathPanel();
      return;
    }

    refreshAnalysis();
    status.hide();
    if (!app.selectedId) showOverview();
  } catch (err) {
    if (err instanceof StaleError) return;
    handleLoadError(err, incoming);
  }
}

function handleLoadError(err, route) {
  if (err instanceof EmptyMapError || !app.graph) showEmpty({ keepStatus: true });

  if (err instanceof PathNotFoundError) {
    app.path = null;
    view.setPath(null);
    if (app.graph) showOverview();
    const current = route.budget || PATH_BUDGET.default;
    const atCeiling = current >= PATH_BUDGET.max;
    // Searching wider only helps if the search stopped early, and there's a ceiling.
    const canWiden = !err.exhausted && !atCeiling;
    status.error(
      canWiden || err.exhausted
        ? err.message
        : `${err.message} That's as far as this search goes: ${PATH_BUDGET.max} books, each opened for the subjects that lead out of it.`,
      canWiden
        ? { label: 'Keep looking', onClick: () => load({ ...route, budget: Math.min(PATH_BUDGET.max, current * 2) }) }
        : null,
    );
    return;
  }

  if (err instanceof EmptyMapError) {
    status.error(err.message);
    return;
  }

  status.error(err.message || 'Something went wrong while building the map.', {
    label: 'Try again',
    onClick: () => navigate(route),
  });
}

function refreshAnalysis() {
  if (!app.graph) return;
  app.analysis = analyze(app.graph, app.seedId);
  view.setBridges(app.analysis.bridges);
}

function showEmpty({ keepStatus = false } = {}) {
  app.token++;
  Object.assign(app, { route: null, graph: null, seedId: null, selectedId: null, pathFrom: null, path: null });
  view.clear();
  view.setPickMode(false);
  panel.hide();
  search.setSubjects([]);
  $('empty').hidden = false;
  $('controls').hidden = true;
  $('crumb').hidden = true;
  document.title = 'Subtext';
  if (!keepStatus) status.hide();
}

// ---------- Describing nodes ----------

const labelOf = (id) => app.graph.getNodeAttribute(id, 'label');
const subOf = (id) => {
  const node = app.graph.getNodeAttributes(id);
  return node.kind === 'book' ? node.byline || (node.year ? String(node.year) : '') : '';
};
const percent = (w) => `${Math.round(w * 100)}%`;

function seedWeight(id) {
  if (!app.seedId || id === app.seedId || !app.graph.hasNode(app.seedId)) return null;
  const edge = app.graph.edge(id, app.seedId);
  return edge ? app.graph.getEdgeAttribute(edge, 'weight') : null;
}

function subjectMatch(node) {
  const total = app.route.subjects.length;
  if (!node.matches) return 'Turned up beside the others';
  return total > 1
    ? `Filed under ${node.matches} of your ${total} subjects`
    : `Filed under “${app.route.subjects[0]}”`;
}

/**
 * On an influence map, position is a claim about descent rather than a
 * resemblance, so it's described that way.
 */
function influenceRelation(id, node) {
  if (node.seed) return 'This map starts here.';
  const edge = app.seedId && app.graph.hasNode(app.seedId) ? app.graph.edge(id, app.seedId) : null;
  if (edge) {
    const attrs = app.graph.getEdgeAttributes(edge);
    if (attrs.influence) {
      return attrs.from === id
        ? `Wikidata records ${node.label} as an influence on ${app.seedLabel}.`
        : `Wikidata records ${app.seedLabel} as an influence on ${node.label}.`;
    }
  }
  const gen = node.gen ?? 0;
  if (gen < 0) return `Further back up the line from ${app.seedLabel}.`;
  if (gen > 0) return `Further down the line from ${app.seedLabel}.`;
  return `Connected to ${app.seedLabel} through the writers between them.`;
}

// On a path map there's no single seed, so position is described by the route:
// either which step a node is, or which step it sits closest to.
function pathRelation(id, node) {
  if (node.anchor) return node.anchor === 'start' ? 'The start of this path.' : 'The end of this path.';
  const step = app.path?.indexOf(id) ?? -1;
  if (step > 0) return `Step ${step} of ${app.path.length - 1} along the path.`;

  let best = null;
  app.graph.forEachNeighbor(id, (nb) => {
    if (!app.path?.includes(nb)) return;
    const w = app.graph.getEdgeAttribute(app.graph.edge(id, nb), 'weight');
    if (!best || w > best.w) best = { id: nb, w };
  });
  return best ? `${percent(best.w)} subject overlap with ${labelOf(best.id)}, on the path.` : 'Near the path.';
}

/** The subjects two things have in common, which is the whole reason they're linked. */
function sharedLine(id) {
  if (!app.seedId || id === app.seedId) return '';
  const shared = connectionBetween(app.graph, id, app.seedId);
  return shared.length ? ` Both filed under ${formatList(shared.slice(0, 3).map(titleCaseSubject))}.` : '';
}

function relationText(id, node) {
  if (app.route.type === 'path') return pathRelation(id, node);
  if (app.route.type === 'influence') return influenceRelation(id, node);
  if (node.seed) {
    return app.route.type === 'book' ? 'This map starts from this book.' : 'This map starts from this writer.';
  }
  if (app.route.type === 'subject') return subjectMatch(node);
  const w = seedWeight(id);
  if (w != null) return `${percent(w)} subject overlap with ${app.seedLabel}.${sharedLine(id)}`;
  const hops = app.seedId ? hopsBetween(app.graph, app.seedId, id) : null;
  return hops ? `${hops} steps from ${app.seedLabel}.` : null;
}

function describe(d) {
  let note = null;
  if (app.route?.type === 'path') note = pathRelation(d.id, d);
  else if (app.route?.type === 'influence') note = d.seed ? 'Start of this map' : influenceRelation(d.id, d);
  else if (d.seed) note = 'Start of this map';
  else if (app.route?.type === 'subject') note = subjectMatch(d);
  else {
    const w = seedWeight(d.id);
    if (w != null) note = `${percent(w)} subject overlap with ${app.seedLabel}`;
  }
  return { title: d.label, subtitle: d.kind === 'book' ? d.byline : null, note };
}

// ---------- Panel states ----------

function overviewNote() {
  if (app.route.type === 'subject') {
    const counted = app.counts.filter((c) => c.workCount);
    const sizes = counted.length
      ? `${formatList(counted.map((c) => `${c.workCount.toLocaleString('en')} under ${titleCaseSubject(c.subject).toLowerCase()}`))}. `
      : '';
    return `${sizes}Bigger dots answer to more of your subjects. Lines join books catalogued alike.`;
  }
  if (app.route.type === 'influence') {
    return 'Arrows run from the writer who influenced to the writer who was influenced. Earlier generations sit to the left. These are editorial claims on Wikidata, not measurements — read them as arguments.';
  }
  if (app.route.type === 'path') {
    return app.path
      ? 'The books around each step, so you can see what the route travels through.'
      : 'No route connected these two. The map shows both ends and their nearest neighbours.';
  }
  return 'Lines join things catalogued under the same specific subjects. The more unusual the subject, the stronger the line.';
}

function showOverview() {
  if (!app.graph || !app.route) return;
  const count = app.graph.order;
  const scenes = app.analysis.sceneCount;
  const titles = titlesFor(app.route, app);
  const action = app.path && !app.pathShown ? { label: 'Show the path again', onClick: showPathPanel } : null;

  panel.showOverview({
    graph: app.graph,
    title: titles.title,
    subtitle: titles.subtitle,
    stats: `${count} ${kindPlural()}${scenes > 1 ? ` in ${scenes} clusters` : ''}`,
    note: overviewNote(),
    action,
    copyLabel: app.nodeKind === 'author' ? 'Copy as a list of writers' : 'Copy as a reading list',
    kindPlural: kindPlural(),
    bridges: app.analysis.bridges.map((id) => ({ id, label: labelOf(id), sub: subOf(id) })),
    ...rankedList(),
  });
}

// The whole map as a ranked list, for reading it without tapping every dot.
// Path maps skip this: their route list is already the reading order.
function rankedList() {
  if (app.route.type === 'path') return {};
  const rows = [];
  app.graph.forEachNode((id, attrs) => {
    if (attrs.seed) return;
    let sub = subOf(id);
    if (app.route.type === 'subject') {
      sub = app.route.subjects.length > 1 && attrs.matches ? `${attrs.matches} of ${app.route.subjects.length}` : sub;
    } else if (app.route.type !== 'influence') {
      const w = seedWeight(id);
      if (w != null) sub = percent(w);
    }
    rows.push({ id, label: attrs.label, sub, score: attrs.score ?? 0 });
  });
  rows.sort((a, b) => b.score - a.score);

  const hints = {
    subject: 'Strongest answers to your subjects first.',
    influence: 'The writers the most lines run through, first.',
  };
  return {
    everyone: rows,
    everyoneHint: hints[app.route.type] || `Closest to ${app.seedLabel} first. Tap one to go to it.`,
  };
}

function showPathPanel() {
  if (!app.path) return;
  app.selectedId = null;
  app.pathShown = true;
  sheet.reveal();
  view.select(null);
  view.setPath(app.path);
  panel.showPath({
    from: labelOf(app.path[0]),
    to: labelOf(app.path[app.path.length - 1]),
    note: app.converted.length
      ? `${formatList(app.converted.map((c) => `${c.from} isn't a book, so that end is ${c.to}`))}.`
      : '',
    steps: app.path.map((id) => ({ id, label: labelOf(id), sub: subOf(id) })),
  });
}

const flatten = (text) =>
  text
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '');

// Matches against what's already drawn, so it can answer while you type.
function findOnMap(query) {
  if (!app.graph || query.length < 2) return [];
  const matches = [];
  app.graph.forEachNode((id, attrs) => {
    const at = flatten(`${attrs.label} ${attrs.byline || ''}`).indexOf(query);
    if (at >= 0) matches.push({ id, label: attrs.label, byline: attrs.byline, kind: attrs.kind, at, score: attrs.score ?? 0 });
  });
  return matches.sort((a, b) => a.at - b.at || b.score - a.score).slice(0, 5);
}

function selectNode(id, { focus = false, keepPath = false } = {}) {
  if (!app.graph?.hasNode(id)) return;
  if (app.pathFrom) {
    finishPath(id);
    return;
  }
  if (keepPath) {
    view.select(id);
    view.focusNode(id);
    return;
  }
  if (app.pathShown) {
    app.pathShown = false;
    view.setPath(null);
  }
  app.selectedId = id;
  view.select(id);
  sheet.reveal();
  if (focus) view.focusNode(id);
  const node = app.graph.getNodeAttributes(id);
  const relation = relationText(id, node);
  if (node.kind === 'author') panel.showAuthor(id, node, relation);
  else panel.showBook(id, node, relation);
}

function clearSelection() {
  if (app.pathFrom) return cancelPath();
  if (app.pathShown) return clearPath();
  if (!app.selectedId) return;
  app.selectedId = null;
  view.select(null);
  showOverview();
}

// ---------- Actions ----------

/** Where a list row points, if it's already drawn. */
function locate(item) {
  if (!app.graph) return null;
  const candidates =
    item.kind === 'author' ? [authorId(item.key), item.qid && authorId(item.qid)] : [bookId(item.key)];
  return candidates.find((id) => id && app.graph.hasNode(id)) || null;
}

function relatedTo(node) {
  const token = app.token;
  return relatedBooks(node, {
    check() {
      if (token !== app.token) throw new StaleError();
    },
    progress() {},
  });
}

// Rows already on the map jump there; the rest get added next to the thing they
// came from, then selected, so you land on what you asked for either way.
async function openSimilar(item) {
  const existing = locate(item);
  if (existing) {
    selectNode(existing, { focus: true });
    return;
  }
  const hubId = app.selectedId;
  if (!app.graph || !hubId) return;

  const token = app.token;
  status.loading(`Adding ${item.name} to the map`);
  try {
    const id = await attachNode(app.graph, hubId, item, {
      check() {
        if (token !== app.token) throw new StaleError();
      },
      progress() {},
    });
    view.setGraph(app.graph);
    refreshAnalysis();
    status.info(`Added ${item.name} beside ${labelOf(hubId)}`);
    selectNode(id, { focus: true });
  } catch (err) {
    if (err instanceof StaleError) return;
    status.error(err.message);
  }
}

async function expand(id) {
  if (!app.graph?.hasNode(id)) return;
  const token = app.token;
  const node = app.graph.getNodeAttributes(id);
  const noun = node.kind === 'author' ? 'writers' : 'books';
  status.loading(`Finding more ${noun} like ${node.label}`);
  try {
    const added = await expandNode(app.graph, id, {
      check() {
        if (token !== app.token) throw new StaleError();
      },
      progress: (message) => ctxProgress(token, message),
    });
    view.setGraph(app.graph);
    refreshAnalysis();
    status.info(
      added
        ? `Added ${added} ${added === 1 ? noun.slice(0, -1) : noun} near ${node.label}`
        : `Everything beside ${node.label} is already on the map`,
    );
    if (!app.selectedId && !app.pathShown) showOverview();
  } catch (err) {
    if (err instanceof StaleError) return;
    status.error(err.message);
  }
}

function ctxProgress(token, message) {
  if (token === app.token) status.loading(message);
}

const endpointFor = (id) => {
  const node = app.graph.getNodeAttributes(id);
  return { kind: node.kind, key: node.key, name: node.label };
};

function startPath(id) {
  const node = app.graph.getNodeAttributes(id);
  const usable = node.kind === 'book' ? WORK_ID.test(node.key || '') : AUTHOR_ID.test(node.key || '');
  if (!usable) {
    status.info(`${node.label} isn't on Open Library, so a path can't start there.`);
    return;
  }
  app.pathFrom = id;
  view.select(id);
  view.setPickMode(true);
  search.setMode('pickEnd');
  status.info(`Choose the other end of the path from ${labelOf(id)}: pick something on the map, or search for anything.`, {
    duration: 0,
    action: { label: 'Cancel', onClick: cancelPath },
  });
}

function cancelPath() {
  app.pathFrom = null;
  view.setPickMode(false);
  search.setMode('browse');
  status.hide();
}

// Picking an end that's on the current map: if a route already exists here,
// draw it straight away rather than rebuilding the map.
function finishPath(id) {
  const from = app.pathFrom;
  if (id === from) {
    cancelPath();
    return;
  }
  const steps = smoothestPath(app.graph, from, id);
  if (!steps) {
    finishPathWith({ node: id });
    return;
  }
  cancelPath();
  app.path = steps;
  showPathPanel();
}

// Picking an end that isn't on the map, or isn't reachable on it. The map gets
// rebuilt by reading outward from both ends until they meet.
function finishPathWith(choice) {
  const from = app.pathFrom;
  if (!from) return;
  if (choice.node) {
    finishPath(choice.node);
    return;
  }
  const fromEndpoint = endpointFor(from);
  cancelPath();
  if (!choice.key) return;
  navigate({ type: 'path', from: { kind: fromEndpoint.kind, key: fromEndpoint.key }, to: { kind: choice.kind, key: choice.key } });
}

function clearPath() {
  app.pathShown = false;
  view.setPath(null);
  showOverview();
}

function somethingDifferent(id) {
  const far = farthestFrom(app.graph, id);
  if (!far) {
    status.info(`Nothing on this map is far from ${labelOf(id)} yet. Grow the map first.`);
    return;
  }
  selectNode(far, { focus: true });
  status.info(`${labelOf(far)} is about as far from ${labelOf(id)} as this map reaches.`);
}

/**
 * A map is already a ranked list of things to read; this hands it over in a
 * form that can go into a syllabus or a handout.
 */
async function copyReadingList() {
  if (!app.graph || !app.route) return;
  const titles = titlesFor(app.route, app);
  const ids = app.pathShown && app.path ? app.path : orderedIds();

  const lines = [titles.title, `Mapped with Subtext. Catalogue data from Open Library.`, ''];
  ids.forEach((id, index) => {
    const node = app.graph.getNodeAttributes(id);
    const named = node.byline ? `${node.label} — ${node.byline}` : node.label;
    lines.push(`${index + 1}. ${node.year ? `${named} (${node.year})` : named}`);
    if (node.kind === 'book' && WORK_ID.test(node.key || '')) lines.push(`   ${ol.workUrl(node.key)}`);
    else if (node.kind === 'author' && AUTHOR_ID.test(node.key || '')) lines.push(`   ${ol.authorUrl(node.key)}`);
  });

  try {
    await navigator.clipboard.writeText(lines.join('\n'));
    status.info(`Copied ${ids.length} ${kindPlural()} to the clipboard.`);
  } catch {
    status.error('Your browser blocked the clipboard. Select the list in the panel and copy it by hand.');
  }
}

function orderedIds() {
  const rows = [];
  app.graph.forEachNode((id, attrs) => rows.push({ id, score: attrs.seed ? 2 : attrs.score ?? 0 }));
  return rows.sort((a, b) => b.score - a.score).map((r) => r.id);
}

// ---------- Layout ----------

function updateInsets() {
  const wide = window.matchMedia('(min-width: 760px)').matches;
  const header = document.querySelector('.topbar').getBoundingClientRect();
  const panelEl = $('panel');
  const panelBox = panelEl.hidden ? null : panelEl.getBoundingClientRect();
  view.setInset(
    wide
      ? { top: header.bottom + 8, right: panelBox ? window.innerWidth - panelBox.left : 0, bottom: 40, left: 0 }
      : // The sheet's target height, not its rect, which is stale mid-animation.
        { top: header.bottom, right: 0, bottom: sheet.heightPx(), left: 0 },
  );
}
window.addEventListener('resize', updateInsets);

// ---------- Static UI ----------

function initChrome() {
  $('about-button').innerHTML = icons.about;
  $('about-button').addEventListener('click', () => about.open());
  $('back').innerHTML = icons.back;
  $('zoom-in').innerHTML = icons.plus;
  $('zoom-out').innerHTML = icons.minus;
  $('zoom-fit').innerHTML = icons.fit;
  $('zoom-in').addEventListener('click', () => view.zoomBy(1.35));
  $('zoom-out').addEventListener('click', () => view.zoomBy(1 / 1.35));
  $('zoom-fit').addEventListener('click', () => view.fit(true));

  document.querySelectorAll('[data-example]').forEach((button) => {
    button.addEventListener('click', () => {
      const [type, a, b] = button.dataset.example.split('|');
      if (type === 'book') navigate({ type: 'book', query: { title: a, author: b || '' } });
      if (type === 'author') navigate({ type: 'author', query: a });
      if (type === 'influence') navigate({ type: 'influence', query: a });
      if (type === 'subject') navigate({ type: 'subject', subjects: a.split(',') });
    });
  });

  document.addEventListener('keydown', (event) => {
    const typing = /INPUT|TEXTAREA/.test(document.activeElement?.tagName);
    if (event.key === '/' && !typing) {
      event.preventDefault();
      search.focus();
    } else if (event.key === 'Escape' && !typing && !document.querySelector('dialog[open]')) {
      clearSelection();
    }
  });
}

/**
 * The first screen shows a line of descent rather than a decorative cluster:
 * generations left to right, arrows between them, coloured the way a real map
 * is coloured. It previews the one thing here that a catalogue can't give you.
 */
function drawEmptyArt() {
  const svgEl = $('empty-art');
  const NS = 'http://www.w3.org/2000/svg';
  const size = 400;
  svgEl.setAttribute('viewBox', `${-size / 2} ${-size / 2} ${size} ${size}`);

  let seed = 7;
  const rand = () => (seed = (seed * 16807) % 2147483647) / 2147483647;

  // Five generations, narrowing to one writer in the middle and widening again:
  // the shape of the thing the map is for. `reach` is how many of the next
  // generation each dot points at, which is what keeps the two halves balanced —
  // the middle has to fan out as hard as the left fans in.
  const columns = [
    { x: -158, count: 4, spread: 128, reach: 2 },
    { x: -80, count: 5, spread: 148, reach: 1 },
    { x: 0, count: 1, spread: 0, reach: 3 },
    { x: 80, count: 3, spread: 120, reach: 1 },
    { x: 158, count: 3, spread: 138, reach: 0 },
  ];

  const points = [];
  columns.forEach((column, gen) => {
    for (let i = 0; i < column.count; i++) {
      const offset =
        column.count === 1 ? 0 : -column.spread + (i * (column.spread * 2)) / (column.count - 1);
      points.push({
        id: `${gen}-${i}`,
        gen,
        x: column.x + (rand() - 0.5) * 22,
        y: offset + (rand() - 0.5) * 30,
        r: gen === 2 ? 8.5 : 3 + rand() * 3.6,
      });
    }
  });

  const centre = points.find((p) => p.gen === 2);
  const colorAt = createSpectrum(points, centre.id);
  const el = (tag, attrs) => {
    const node = document.createElementNS(NS, tag);
    for (const key in attrs) node.setAttribute(key, attrs[key]);
    return node;
  };

  const defs = el('defs', {});
  const blur = el('filter', { id: 'art-blur', x: '-100%', y: '-100%', width: '300%', height: '300%' });
  blur.append(el('feGaussianBlur', { stdDeviation: 5 }));
  defs.append(blur);
  svgEl.append(defs);

  // Each dot reaches forward to the nearest one or two in the next generation.
  // Past the middle, only dots the centre actually reached may reach on, so the
  // right-hand side is a line of descent rather than loose pairs floating in it.
  const reached = new Set(['2-0']);
  for (let gen = 0; gen < columns.length - 1; gen++) {
    const from = points.filter((p) => p.gen === gen);
    const to = points.filter((p) => p.gen === gen + 1);
    for (const a of from) {
      if (gen >= 2 && !reached.has(a.id)) continue;
      const nearest = to
        .map((b) => [b, Math.abs(b.y - a.y)])
        .sort((x, y) => x[1] - y[1])
        .slice(0, columns[gen].reach);
      for (const [b] of nearest) {
        reached.add(b.id);
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const length = Math.hypot(dx, dy) || 1;
        const ux = dx / length;
        const uy = dy / length;
        const x1 = a.x + ux * (a.r + 2);
        const y1 = a.y + uy * (a.r + 2);
        const x2 = b.x - ux * (b.r + 6);
        const y2 = b.y - uy * (b.r + 6);
        const color = colorAt((a.x + b.x) / 2, (a.y + b.y) / 2);
        svgEl.append(el('line', { x1, y1, x2, y2, stroke: color, 'stroke-opacity': 0.55, 'stroke-width': 1.1, 'stroke-linecap': 'round' }));
        svgEl.append(
          el('path', {
            d: 'M0,0 L-8,-3.2 L-6.6,0 L-8,3.2 Z',
            fill: color,
            'fill-opacity': 0.75,
            transform: `translate(${x2},${y2}) rotate(${(Math.atan2(dy, dx) * 180) / Math.PI})`,
          }),
        );
      }
    }
  }

  const halos = el('g', { filter: 'url(#art-blur)', opacity: 0.32 });
  for (const p of points) halos.append(el('circle', { cx: p.x, cy: p.y, r: p.r * 2, fill: colorAt(p.x, p.y) }));
  svgEl.append(halos);
  for (const p of points) {
    svgEl.append(el('circle', { cx: p.x, cy: p.y, r: p.r, fill: colorAt(p.x, p.y), stroke: '#100e15', 'stroke-width': 1.5 }));
  }
}

// ---------- Start ----------

function start() {
  const route = hashToRoute(location.hash);
  app.trail = [location.hash];
  if (route) load(route);
  else showEmpty();
}

initChrome();
drawEmptyArt();
start();
