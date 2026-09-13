import * as d3 from 'd3';
import { createSpectrum } from '../graph/color.js';

const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

const truncate = (s, n) => (s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s);

/**
 * Book titles carry their subtitles, which are useful in a list and ruinous on
 * a map: "Maus: A Survivor's Tale: My Father Bleeds History" over a five-pixel
 * dot. The part before the colon is what anyone calls it.
 */
function mapLabel(label) {
  const text = String(label || '');
  if (text.length <= 24) return text;
  const head = text.split(/\s*[:;(]\s*/)[0].trim();
  return truncate(head.length >= 4 ? head : text, 30);
}

export function createGraphView(container, handlers = {}) {
  const svg = d3
    .select(container)
    .append('svg')
    .attr('class', 'map')
    .attr('role', 'group')
    .attr('aria-label', 'Map of books and authors');

  svg
    .append('defs')
    .append('filter')
    .attr('id', 'halo-blur')
    .attr('x', '-100%')
    .attr('y', '-100%')
    .attr('width', '300%')
    .attr('height', '300%')
    .append('feGaussianBlur')
    .attr('stdDeviation', 6);

  const root = svg.append('g');
  const edgeLayer = root.append('g').attr('class', 'edges');
  const arrowLayer = root.append('g').attr('class', 'arrows');
  const haloLayer = root.append('g').attr('class', 'halos').attr('filter', 'url(#halo-blur)');
  const nodeLayer = root.append('g').attr('class', 'nodes');

  const tooltip = d3.select(container).append('div').attr('class', 'tooltip').attr('aria-hidden', 'true');

  let nodes = [];
  let links = [];
  let byId = new Map();
  let degree = new Map();
  let centerId = null;
  let bridges = new Set();
  let selectedId = null;
  let hoverId = null;
  let path = null;
  let active = null;
  let needsFit = false;
  let tickCount = 0;
  let transform = d3.zoomIdentity;
  let inset = { top: 0, right: 0, bottom: 0, left: 0 };

  let edgeSel = edgeLayer.selectAll('line');
  let arrowSel = arrowLayer.selectAll('path');
  let haloSel = haloLayer.selectAll('circle');
  let nodeSel = nodeLayer.selectAll('g.node');

  // ---------- Zoom and pan ----------

  const zoom = d3
    .zoom()
    .scaleExtent([0.2, 5])
    .on('zoom', (event) => {
      transform = event.transform;
      root.attr('transform', transform);
      updateLabels();
    });

  svg.call(zoom).on('dblclick.zoom', null);
  svg.on('click', (event) => {
    if (event.target === svg.node()) handlers.onBackground?.();
  });

  function viewport() {
    const { width, height } = container.getBoundingClientRect();
    const w = Math.max(80, width - inset.left - inset.right);
    const h = Math.max(80, height - inset.top - inset.bottom);
    return { w, h, cx: inset.left + w / 2, cy: inset.top + h / 2 };
  }

  function centerView() {
    const { cx, cy } = viewport();
    svg.call(zoom.transform, d3.zoomIdentity.translate(cx, cy));
  }
  centerView();

  // ---------- Force simulation ----------

  // Most maps pull toward the middle. Influence maps carry a generation on every
  // node — writers who came before on one side, writers who came after on the
  // other — and that becomes a horizontal pull, so a line of descent reads left
  // to right instead of tangling around its subject.
  const GENERATION_SPAN = 215;

  const sim = d3
    .forceSimulation()
    .force(
      'link',
      d3
        .forceLink()
        .id((d) => d.id)
        .distance((l) => 36 + (1 - l.weight) * 130)
        .strength((l) => {
          const lesser = Math.min(degree.get(l.source.id) || 1, degree.get(l.target.id) || 1);
          return (0.3 + 0.7 * l.weight) / Math.max(1, lesser);
        }),
    )
    .force('charge', d3.forceManyBody().strength((d) => -80 - d.r * 9).distanceMax(420))
    .force(
      'x',
      d3
        .forceX((d) => (d.gen == null ? 0 : d.gen * GENERATION_SPAN))
        .strength((d) => (d.gen == null ? 0.045 : 0.17)),
    )
    // Generations are held to their column; pulling them to the middle line as
    // hard would stack a whole generation into a single row.
    .force('y', d3.forceY(0).strength((d) => (d.gen == null ? 0.045 : 0.018)))
    .force('collide', d3.forceCollide((d) => d.r + 6))
    .alphaDecay(0.035)
    .on('tick', render);
  sim.stop();

  const drag = d3
    .drag()
    .on('start', (event, d) => {
      if (!event.active && !reduceMotion) sim.alphaTarget(0.2).restart();
      d.fx = d.x;
      d.fy = d.y;
    })
    .on('drag', (event, d) => {
      d.fx = event.x;
      d.fy = event.y;
      if (reduceMotion) {
        d.x = event.x;
        d.y = event.y;
        render();
      }
    })
    .on('end', (event, d) => {
      if (!event.active) sim.alphaTarget(0);
      if (d.pinned) return; // Anchored ends stay where they're dropped.
      d.fx = null;
      d.fy = null;
    });

  // ---------- Data ----------

  function setGraph(graph, options = {}) {
    if ('centerId' in options) centerId = options.centerId;
    if (options.bridges) bridges = new Set(options.bridges);
    if (options.fresh) {
      byId = new Map();
      path = null;
      selectedId = null;
      centerView();
    }

    const previous = byId;
    byId = new Map();
    nodes = graph.mapNodes((id, attrs) => {
      const node = previous.get(id) || { id };
      const hadAnchor = node.anchor;
      Object.assign(node, attrs);
      node.r = attrs.seed ? 15 : 5 + (attrs.score ?? 0.3) * 9;
      if (node.x == null || (attrs.anchor && !hadAnchor)) placeNear(node, graph, previous);
      if (!attrs.anchor && node.pinned) {
        node.anchor = undefined;
        node.pinned = false;
        node.fx = null;
        node.fy = null;
      }
      byId.set(id, node);
      return node;
    });

    links = graph.mapEdges((id, attrs, source, target) => ({
      id,
      source,
      target,
      weight: attrs.weight,
      influence: Boolean(attrs.influence),
      // Recorded explicitly, because an influence claim points one way and an
      // edge added later in the opposite order would otherwise reverse it.
      from: attrs.from || source,
    }));

    degree = new Map();
    for (const link of links) {
      degree.set(link.source, (degree.get(link.source) || 0) + 1);
      degree.set(link.target, (degree.get(link.target) || 0) + 1);
    }

    sim.nodes(nodes);
    sim.force('link').links(links);
    join();

    if (options.fresh) needsFit = true;
    if (reduceMotion) {
      sim.alpha(1);
      for (let i = 0; i < 300; i++) sim.tick();
      render();
      if (needsFit) fit(false);
    } else {
      sim.alpha(options.fresh ? 0.9 : Math.max(sim.alpha(), 0.3)).restart();
    }
    applyEmphasis();
  }

  function placeNear(node, graph, previous) {
    // Path maps have two anchored ends, pinned apart so the route reads across the map.
    if (node.anchor) {
      node.x = node.anchor === 'start' ? -230 : 230;
      node.y = 0;
      node.fx = node.x;
      node.fy = node.y;
      node.pinned = true;
      return;
    }
    if (node.gen != null) {
      node.x = node.gen * GENERATION_SPAN + (Math.random() - 0.5) * 60;
      node.y = (Math.random() - 0.5) * 240;
      return;
    }
    const near = graph
      .neighbors(node.id)
      .map((id) => previous.get(id) || byId.get(id))
      .find((n) => n && n.x != null);
    if (near) {
      node.x = near.x + (Math.random() - 0.5) * 50;
      node.y = near.y + (Math.random() - 0.5) * 50;
    } else if (node.seed) {
      node.x = 0;
      node.y = 0;
    } else {
      const angle = Math.random() * Math.PI * 2;
      const radius = 70 + Math.random() * 140;
      node.x = Math.cos(angle) * radius;
      node.y = Math.sin(angle) * radius;
    }
  }

  function join() {
    edgeSel = edgeLayer
      .selectAll('line')
      .data(links, (d) => d.id)
      .join('line')
      .attr('stroke-width', (d) => (d.influence ? 1.6 : 0.6 + d.weight * 2.2))
      .classed('influence', (d) => d.influence)
      .style('--w', (d) => (d.weight * d.weight).toFixed(3));

    arrowSel = arrowLayer
      .selectAll('path')
      .data(links.filter((d) => d.influence), (d) => d.id)
      .join('path')
      .attr('class', 'arrow')
      .attr('d', 'M0,0 L-9,-3.6 L-7.4,0 L-9,3.6 Z');

    haloSel = haloLayer
      .selectAll('circle')
      .data(nodes, (d) => d.id)
      .join('circle')
      .attr('r', (d) => d.r * 2);

    nodeSel = nodeLayer
      .selectAll('g.node')
      .data(nodes, (d) => d.id)
      .join((enter) => {
        const group = enter.append('g').attr('class', 'node').attr('tabindex', 0).attr('role', 'button');
        group.append('circle').attr('class', 'ring');
        group.append('circle').attr('class', 'core');
        group.append('text').attr('class', 'label');
        group
          .on('mouseenter', (event, d) => {
            hoverId = d.id;
            applyEmphasis();
            showTip(event, d);
          })
          .on('mousemove', moveTip)
          .on('mouseleave', () => {
            hoverId = null;
            applyEmphasis();
            hideTip();
          })
          .on('focus', (_event, d) => {
            hoverId = d.id;
            applyEmphasis();
          })
          .on('blur', () => {
            hoverId = null;
            applyEmphasis();
          })
          .on('click', (event, d) => {
            event.stopPropagation();
            handlers.onSelect?.(d.id);
          })
          .on('dblclick', (event, d) => {
            event.stopPropagation();
            handlers.onExpand?.(d.id);
          })
          .on('keydown', (event, d) => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault();
              handlers.onSelect?.(d.id);
            }
          })
          .call(drag);
        return group;
      });

    nodeSel
      .attr('aria-label', (d) => (d.byline ? `${d.label}, by ${d.byline}` : d.label))
      .classed('seed', (d) => Boolean(d.seed))
      .classed('bridge', (d) => bridges.has(d.id));
    nodeSel.select('circle.core').attr('r', (d) => d.r);
    nodeSel.select('circle.ring').attr('r', (d) => d.r + 5);
    nodeSel.select('text.label').text((d) => mapLabel(d.label));
    updateLabels();
  }

  // ---------- Drawing ----------

  /**
   * Where a line starts and ends. Ordinary links run centre to centre and
   * disappear under the dots. Influence links stop at the rim, because they
   * carry an arrowhead that has to be visible to mean anything.
   */
  function endpointsOf(link) {
    const source = link.source;
    const target = link.target;
    if (!link.influence) {
      return { x1: source.x, y1: source.y, x2: target.x, y2: target.y };
    }
    const forward = link.from === source.id;
    const tail = forward ? source : target;
    const head = forward ? target : source;
    const dx = head.x - tail.x;
    const dy = head.y - tail.y;
    const length = Math.hypot(dx, dy) || 1;
    const ux = dx / length;
    const uy = dy / length;
    return {
      x1: tail.x + ux * (tail.r + 2),
      y1: tail.y + uy * (tail.r + 2),
      x2: head.x - ux * (head.r + 5),
      y2: head.y - uy * (head.r + 5),
      angle: (Math.atan2(dy, dx) * 180) / Math.PI,
    };
  }

  function render() {
    const colorAt = createSpectrum(nodes, centerId);
    for (const node of nodes) node.color = colorAt(node.x, node.y);

    edgeSel.each(function (d) {
      const ends = endpointsOf(d);
      d.ends = ends;
      this.setAttribute('x1', ends.x1);
      this.setAttribute('y1', ends.y1);
      this.setAttribute('x2', ends.x2);
      this.setAttribute('y2', ends.y2);
      this.style.stroke = colorAt((d.source.x + d.target.x) / 2, (d.source.y + d.target.y) / 2);
    });

    arrowSel
      .attr('transform', (d) => {
        const ends = d.ends || endpointsOf(d);
        return `translate(${ends.x2},${ends.y2}) rotate(${ends.angle})`;
      })
      .style('fill', (d) => colorAt(d.ends?.x2 ?? d.target.x, d.ends?.y2 ?? d.target.y));

    haloSel
      .attr('cx', (d) => d.x)
      .attr('cy', (d) => d.y)
      .style('fill', (d) => d.color);

    nodeSel.attr('transform', (d) => `translate(${d.x},${d.y})`);
    nodeSel.select('circle.core').style('fill', (d) => d.color);

    // Re-place labels every few frames while the layout settles.
    if (++tickCount % 8 === 0) updateLabels();

    if (needsFit && sim.alpha() < 0.12) fit(true);
  }

  function applyEmphasis() {
    const focusId = hoverId || selectedId;
    let activeEdges = null;
    active = null;

    if (path) {
      active = path.nodes;
      activeEdges = path.edges;
    } else if (focusId && byId.has(focusId)) {
      active = new Set([focusId]);
      activeEdges = new Set();
      for (const link of links) {
        if (link.source.id === focusId || link.target.id === focusId) {
          active.add(link.source.id);
          active.add(link.target.id);
          activeEdges.add(link.id);
        }
      }
    }

    svg.classed('showing-path', Boolean(path));
    nodeSel
      .classed('dim', (d) => Boolean(active && !active.has(d.id)))
      .classed('selected', (d) => d.id === selectedId)
      .classed('on-path', (d) => Boolean(path?.nodes.has(d.id)));
    haloSel.classed('dim', (d) => Boolean(active && !active.has(d.id)));
    edgeSel
      .classed('lit', (d) => Boolean(activeEdges?.has(d.id)))
      .classed('dim', (d) => Boolean(active && !activeEdges.has(d.id)))
      .classed('path', (d) => Boolean(path?.edges.has(d.id)));
    arrowSel.classed('dim', (d) => Boolean(active && !activeEdges.has(d.id)));
    updateLabels();
  }

  function updateLabels() {
    const k = transform.k;
    const threshold = k > 1.8 ? 0 : k > 1.25 ? 0.3 : k > 0.85 ? 0.5 : 0.75;
    const size = 12 / Math.min(1.6, Math.max(0.75, k));

    const priority = (d) => {
      if (d.id === hoverId || d.id === selectedId) return 3;
      if (d.seed) return 2;
      return d.score ?? 0;
    };
    const wanted = nodes
      .filter((d) => {
        if (d.seed || d.id === selectedId || d.id === hoverId) return true;
        if (active) return active.has(d.id);
        return (d.score ?? 0) >= threshold;
      })
      .sort((a, b) => priority(b) - priority(a));

    // Greedy label placement: higher-priority labels claim space first. Each
    // label tries below its node, then above; if both collide with a node or a
    // placed label it stays hidden until you zoom in. The seed, hover, and
    // selection must always show, so they take the less-crowded side and,
    // failing that, draw below anyway.
    const placed = [];
    const shown = new Set();
    const circles = nodes.map((n) => ({ id: n.id, x0: n.x - n.r, x1: n.x + n.r, y0: n.y - n.r, y1: n.y + n.r }));
    const textHeight = size * 1.15;

    for (const d of wanted) {
      const width = mapLabel(d.label).length * size * 0.56;
      const below = { x0: d.x - width / 2, x1: d.x + width / 2, y0: d.y + d.r + 3, y1: d.y + d.r + 3 + textHeight, side: 'below' };
      const above = { x0: below.x0, x1: below.x1, y0: d.y - d.r - 3 - textHeight, y1: d.y - d.r - 3, side: 'above' };
      const clash = (box) => {
        const hits = (b) => box.x0 < b.x1 && box.x1 > b.x0 && box.y0 < b.y1 && box.y1 > b.y0;
        return placed.some(hits) || circles.some((c) => c.id !== d.id && hits(c));
      };
      let pick = [below, above].find((box) => !clash(box));
      if (!pick && priority(d) >= 2) pick = below;
      if (pick) {
        placed.push(pick);
        shown.add(d.id);
        d.labelSide = pick.side;
      }
    }

    nodeSel
      .select('text.label')
      .attr('font-size', size.toFixed(2))
      .attr('y', (d) => (d.labelSide === 'above' ? -(d.r + 5) : d.r + size + 3))
      .classed('shown', (d) => shown.has(d.id));
  }

  // ---------- Tooltip ----------

  // Touch has no hover: a tap fires mouseenter with no mouseleave to follow, so
  // the tooltip would stick. The details panel carries the same information.
  const hasHover = window.matchMedia('(hover: hover)').matches;

  function showTip(event, d) {
    if (!hasHover) return;
    const info = handlers.describe?.(d) || { title: d.label };
    tooltip.selectAll('*').remove();
    tooltip.append('strong').text(info.title);
    if (info.subtitle) tooltip.append('span').text(info.subtitle);
    if (info.note) tooltip.append('span').attr('class', 'tip-note').text(info.note);
    tooltip.classed('visible', true);
    moveTip(event);
  }

  function moveTip(event) {
    const [x, y] = d3.pointer(event, container);
    tooltip.style('transform', `translate(${Math.round(x + 14)}px, ${Math.round(y + 14)}px)`);
  }

  function hideTip() {
    tooltip.classed('visible', false);
  }

  // ---------- Camera ----------

  function fit(animate = true) {
    needsFit = false;
    if (!nodes.length) return;
    const { w, h, cx, cy } = viewport();
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (const n of nodes) {
      x0 = Math.min(x0, n.x - n.r - 40);
      x1 = Math.max(x1, n.x + n.r + 40);
      y0 = Math.min(y0, n.y - n.r - 20);
      y1 = Math.max(y1, n.y + n.r + 30);
    }
    const k = Math.min(1.5, 0.94 * Math.min(w / (x1 - x0), h / (y1 - y0)));
    const target = d3.zoomIdentity.translate(cx - k * ((x0 + x1) / 2), cy - k * ((y0 + y1) / 2)).scale(k);
    if (animate && !reduceMotion) svg.transition().duration(700).ease(d3.easeCubicOut).call(zoom.transform, target);
    else svg.call(zoom.transform, target);
  }

  function focusNode(id) {
    const node = byId.get(id);
    if (!node) return;
    const { cx, cy } = viewport();
    const run = reduceMotion ? svg : svg.transition().duration(600).ease(d3.easeCubicOut);
    run.call(zoom.translateTo, node.x, node.y, [cx, cy]);
  }

  // Pans by screen pixels, keeping the current zoom. Used when the space
  // available to the map changes, so what you were looking at stays in view.
  function nudge(dx, dy) {
    const run = reduceMotion ? svg : svg.transition().duration(280).ease(d3.easeCubicOut);
    run.call(zoom.translateBy, dx / transform.k, dy / transform.k);
  }

  function zoomBy(factor) {
    const run = reduceMotion ? svg : svg.transition().duration(250);
    run.call(zoom.scaleBy, factor);
  }

  // ---------- Public ----------

  return {
    setGraph,
    fit,
    focusNode,
    zoomBy,
    nudge,
    clear() {
      nodes = [];
      links = [];
      byId = new Map();
      path = null;
      selectedId = null;
      sim.stop();
      sim.nodes([]);
      sim.force('link').links([]);
      join();
      hideTip();
    },
    select(id) {
      selectedId = id;
      applyEmphasis();
    },
    setPath(ids) {
      if (!ids) {
        path = null;
      } else {
        const edges = new Set();
        for (let i = 0; i < ids.length - 1; i++) {
          const link = links.find(
            (x) =>
              (x.source.id === ids[i] && x.target.id === ids[i + 1]) ||
              (x.source.id === ids[i + 1] && x.target.id === ids[i]),
          );
          if (link) edges.add(link.id);
        }
        path = { nodes: new Set(ids), edges };
      }
      applyEmphasis();
    },
    setInset(next) {
      inset = { ...inset, ...next };
    },
    setPickMode(on) {
      svg.classed('picking', on);
    },
    setBridges(ids) {
      bridges = new Set(ids);
      nodeSel.classed('bridge', (d) => bridges.has(d.id));
    },
  };
}
