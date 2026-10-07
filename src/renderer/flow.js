'use strict';

/**
 * A structural model of a Mermaid flowchart: parsed out of Mermaid's own
 * database, edited as plain objects, and written back as Mermaid source.
 * Exposed as window.FlowModel. The visual designer edits this model; the
 * document only ever sees the regenerated text.
 */
(() => {
  const { mermaid } = window.MDV;

  /* -------------------------------------------------------------- shapes */

  // Classic bracket syntax. Newer shapes fall back to the `@{ shape: … }` form.
  const BRACKETS = {
    square: ['[', ']'], round: ['(', ')'], stadium: ['([', '])'], subroutine: ['[[', ']]'],
    cylinder: ['[(', ')]'], circle: ['((', '))'], doublecircle: ['(((', ')))'],
    diamond: ['{', '}'], hexagon: ['{{', '}}'], odd: ['>', ']'],
    trapezoid: ['[/', '\\]'], inv_trapezoid: ['[\\', '/]'],
    lean_right: ['[/', '/]'], lean_left: ['[\\', '\\]'],
  };

  // Names the `@{ shape: … }` syntax accepts for the same classic shapes.
  const ALIASES = {
    rect: 'square', rectangle: 'square', process: 'square', proc: 'square',
    rounded: 'round', event: 'round',
    pill: 'stadium', terminal: 'stadium',
    'fr-rect': 'subroutine', subproc: 'subroutine', subprocess: 'subroutine', subroutine: 'subroutine',
    cyl: 'cylinder', database: 'cylinder', db: 'cylinder',
    circ: 'circle', circle: 'circle',
    'dbl-circ': 'doublecircle', 'double-circle': 'doublecircle',
    diam: 'diamond', decision: 'diamond', question: 'diamond',
    hex: 'hexagon', prepare: 'hexagon',
    'trap-b': 'trapezoid', 'trap-t': 'inv_trapezoid',
    'lean-r': 'lean_right', 'lean-l': 'lean_left',
  };

  const SHAPES = [
    ['square', 'Rectangle'], ['round', 'Rounded'], ['stadium', 'Stadium'],
    ['subroutine', 'Subroutine'], ['cylinder', 'Database'], ['circle', 'Circle'],
    ['doublecircle', 'Double circle'], ['diamond', 'Decision'], ['hexagon', 'Hexagon'],
    ['odd', 'Flag'], ['trapezoid', 'Trapezoid'], ['inv_trapezoid', 'Inverted trapezoid'],
    ['lean_right', 'Parallelogram'], ['lean_left', 'Parallelogram (reverse)'],
  ];

  const ARROWS = [
    ['arrow_point', 'Arrow'], ['arrow_open', 'Line (no arrow)'], ['arrow_cross', 'Cross'],
    ['arrow_circle', 'Circle'], ['double_arrow_point', 'Both ways'],
    ['double_arrow_cross', 'Both ways, cross'], ['double_arrow_circle', 'Both ways, circle'],
  ];

  const STROKES = [['normal', 'Solid'], ['thick', 'Thick'], ['dotted', 'Dotted'], ['invisible', 'Invisible']];
  const DIRECTIONS = [['TB', 'Top to bottom'], ['LR', 'Left to right'], ['BT', 'Bottom to top'], ['RL', 'Right to left']];

  /* ------------------------------------------------------------- parsing */

  // Anything before the `flowchart`/`graph` line — front matter, directives,
  // comments — is kept verbatim and put back when the text is regenerated.
  function splitHeader(text) {
    const lines = text.split('\n');
    let i = 0;
    const preamble = [];
    if (lines[0] && lines[0].trim() === '---') {
      preamble.push(lines[0]);
      for (i = 1; i < lines.length; i++) {
        preamble.push(lines[i]);
        if (lines[i].trim() === '---') { i++; break; }
      }
    }
    for (; i < lines.length; i++) {
      const line = lines[i];
      if (/^\s*(flowchart|graph)\b/.test(line)) {
        const keyword = line.trim().split(/\s+/)[0];
        return { preamble, keyword };
      }
      if (line.trim() === '' || line.trim().startsWith('%%')) preamble.push(line);
      else break;
    }
    return { preamble, keyword: 'flowchart' };
  }

  async function parse(text) {
    const diagram = await mermaid.mermaidAPI.getDiagramFromText(text);
    if (!/^flowchart/.test(diagram.type || '')) {
      const err = new Error('Only flowcharts can be edited visually');
      err.code = 'NOT_FLOWCHART';
      throw err;
    }
    const db = diagram.db;
    const { preamble, keyword } = splitHeader(text);

    const vertices = [...db.getVertices().values()].map((v) => ({
      id: v.id,
      domId: v.domId,
      text: v.text === undefined ? v.id : v.text,
      labelType: v.labelType || 'text',
      type: v.type,
      classes: (v.classes || []).filter((c) => c !== 'clickable' && c !== 'default'),
      styles: [...(v.styles || [])],
      link: v.link,
      linkTarget: v.linkTarget,
      icon: v.icon, form: v.form, pos: v.pos, img: v.img, constraint: v.constraint,
      assetWidth: v.assetWidth, assetHeight: v.assetHeight,
    }));

    const edges = db.getEdges().map((e) => ({
      id: e.id,
      isUserDefinedId: !!e.isUserDefinedId,
      start: e.start,
      end: e.end,
      type: e.type || 'arrow_point',
      stroke: e.stroke || 'normal',
      length: e.length || 1,
      text: e.text || '',
      labelType: e.labelType || 'text',
      style: e.style ? e.style.filter((s) => s !== 'fill:none') : [],
      interpolate: e.interpolate,
      animate: e.animate,
    }));

    const subgraphs = db.getSubGraphs().map((s) => ({
      id: s.id,
      title: s.title || '',
      nodes: [...(s.nodes || [])],
      dir: s.dir,
      classes: [...(s.classes || [])],
    }));

    const classDefs = [...db.getClasses().entries()].map(([id, c]) => ({
      id, styles: [...(c.styles || [])],
    }));

    return {
      keyword,
      preamble,
      direction: db.getDirection() || 'TB',
      vertices, edges, subgraphs, classDefs,
    };
  }

  /* ----------------------------------------------------------- serialise */

  function quote(text) {
    return '"' + String(text).replace(/"/g, '#quot;') + '"';
  }

  function labelFor(v) {
    // Markdown labels are written in backticks inside the quotes.
    const inner = v.labelType === 'markdown' ? '`' + v.text + '`' : v.text;
    return quote(inner);
  }

  function nodeDef(v) {
    const classic = v.type && (BRACKETS[v.type] ? v.type : ALIASES[v.type]);
    const extras = v.icon || v.img || v.form || v.pos || v.constraint || v.assetWidth || v.assetHeight;
    if (!v.type && v.text === v.id) return v.id;
    if (classic && !extras) {
      const [open, close] = BRACKETS[classic];
      return `${v.id}${open}${labelFor(v)}${close}`;
    }
    const fields = [];
    if (v.type) fields.push(`shape: ${v.type}`);
    fields.push(`label: "${String(v.text).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`);
    if (v.icon) fields.push(`icon: "${v.icon}"`);
    if (v.img) fields.push(`img: "${v.img}"`);
    if (v.form) fields.push(`form: "${v.form}"`);
    if (v.pos) fields.push(`pos: "${v.pos}"`);
    if (v.constraint) fields.push(`constraint: "${v.constraint}"`);
    if (v.assetWidth) fields.push(`w: ${v.assetWidth}`);
    if (v.assetHeight) fields.push(`h: ${v.assetHeight}`);
    return `${v.id}@{ ${fields.join(', ')} }`;
  }

  function arrowFor(e) {
    const double = e.type.startsWith('double_');
    const base = double ? e.type.slice('double_'.length) : e.type;
    const end = { arrow_point: '>', arrow_cross: 'x', arrow_circle: 'o', arrow_open: '' }[base] ?? '>';
    const start = double ? ({ arrow_point: '<', arrow_cross: 'x', arrow_circle: 'o' }[base] || '') : '';
    const n = Math.min(10, Math.max(1, e.length || 1));
    let body;
    switch (e.stroke) {
      case 'thick': body = '='.repeat(n + 1) + (end || '='); break;
      case 'dotted': body = '-' + '.'.repeat(n) + '-' + end; break;
      case 'invisible': body = '~'.repeat(n + 2); break;
      default: body = '-'.repeat(n + 1) + (end || '-');
    }
    return start + body;
  }

  function edgeDef(e) {
    const id = e.isUserDefinedId && e.id ? `${e.id}@` : '';
    const label = e.text ? `|${quote(e.text.replace(/\|/g, '/'))}|` : '';
    return `${e.start} ${id}${arrowFor(e)}${label} ${e.end}`;
  }

  function serialize(model) {
    const out = [...model.preamble];
    out.push(`${model.keyword} ${model.direction}`);
    const ind = '  ';

    for (const c of model.classDefs) {
      if (c.styles.length) out.push(`${ind}classDef ${c.id} ${c.styles.join(',')}`);
    }

    const byId = new Map(model.vertices.map((v) => [v.id, v]));
    const subById = new Map(model.subgraphs.map((s) => [s.id, s]));
    const placed = new Set();
    for (const s of model.subgraphs) for (const n of s.nodes) placed.add(n);

    // A subgraph nested inside another is listed among its parent's nodes.
    const nested = new Set();
    for (const s of model.subgraphs) for (const n of s.nodes) if (subById.has(n)) nested.add(n);

    const emitSubgraph = (s, depth) => {
      const pad = ind.repeat(depth);
      const head = /^subGraph\d+$/.test(s.id) ? quote(s.title || s.id) : `${s.id} [${quote(s.title || s.id)}]`;
      out.push(`${pad}subgraph ${head}`);
      if (s.dir) out.push(`${pad}${ind}direction ${s.dir}`);
      for (const n of s.nodes) {
        if (subById.has(n)) emitSubgraph(subById.get(n), depth + 1);
        else if (byId.has(n)) out.push(`${pad}${ind}${nodeDef(byId.get(n))}`);
        else out.push(`${pad}${ind}${n}`);
      }
      out.push(`${pad}end`);
    };

    for (const v of model.vertices) if (!placed.has(v.id)) out.push(`${ind}${nodeDef(v)}`);
    for (const s of model.subgraphs) if (!nested.has(s.id)) emitSubgraph(s, 1);

    for (const e of model.edges) out.push(`${ind}${edgeDef(e)}`);

    for (const v of model.vertices) {
      if (v.classes.length) out.push(`${ind}class ${v.id} ${v.classes.join(',')}`);
      if (v.styles.length) out.push(`${ind}style ${v.id} ${v.styles.join(',')}`);
      if (v.link) out.push(`${ind}click ${v.id} ${quote(v.link)}${v.linkTarget ? ' ' + v.linkTarget : ''}`);
    }
    for (const s of model.subgraphs) {
      if (s.classes.length) out.push(`${ind}class ${s.id} ${s.classes.join(',')}`);
    }
    model.edges.forEach((e, i) => {
      if (e.style && e.style.length) out.push(`${ind}linkStyle ${i} ${e.style.join(',')}`);
    });
    return out.join('\n') + '\n';
  }

  /* ---------------------------------------------------------------- edits */

  function newNodeId(model) {
    const taken = new Set([...model.vertices.map((v) => v.id), ...model.subgraphs.map((s) => s.id)]);
    for (let n = model.vertices.length + 1; ; n++) {
      const id = `N${n}`;
      if (!taken.has(id)) return id;
    }
  }

  function addNode(model, { text = 'New node', type = 'square', after = null } = {}) {
    const id = newNodeId(model);
    model.vertices.push({ id, text, labelType: 'text', type, classes: [], styles: [] });
    if (after && model.vertices.some((v) => v.id === after)) {
      addEdge(model, after, id);
      // Keep the new node inside the same group as the one it hangs off.
      const group = model.subgraphs.find((s) => s.nodes.includes(after));
      if (group) group.nodes.push(id);
    }
    return id;
  }

  function removeNode(model, id) {
    model.vertices = model.vertices.filter((v) => v.id !== id);
    model.edges = model.edges.filter((e) => e.start !== id && e.end !== id);
    for (const s of model.subgraphs) s.nodes = s.nodes.filter((n) => n !== id);
  }

  function addEdge(model, start, end) {
    const edge = {
      id: `L_${start}_${end}_${model.edges.length}`, isUserDefinedId: false,
      start, end, type: 'arrow_point', stroke: 'normal', length: 1, text: '', labelType: 'text', style: [],
    };
    model.edges.push(edge);
    return edge;
  }

  function removeEdge(model, index) {
    model.edges.splice(index, 1);
  }

  function setGroup(model, id, groupId) {
    for (const s of model.subgraphs) s.nodes = s.nodes.filter((n) => n !== id);
    const group = model.subgraphs.find((s) => s.id === groupId);
    if (group) group.nodes.push(id);
  }

  function addGroup(model, title, nodeIds = []) {
    const id = `G${model.subgraphs.length + 1}`;
    for (const s of model.subgraphs) s.nodes = s.nodes.filter((n) => !nodeIds.includes(n));
    model.subgraphs.push({ id, title, nodes: [...nodeIds], dir: undefined, classes: [] });
    return id;
  }

  function removeGroup(model, id) {
    const group = model.subgraphs.find((s) => s.id === id);
    if (!group) return;
    // Nodes survive; only the box around them goes.
    const parent = model.subgraphs.find((s) => s.nodes.includes(id));
    if (parent) parent.nodes = parent.nodes.filter((n) => n !== id).concat(group.nodes);
    model.subgraphs = model.subgraphs.filter((s) => s.id !== id);
    model.edges = model.edges.filter((e) => e.start !== id && e.end !== id);
  }

  window.FlowModel = {
    parse, serialize, splitHeader,
    addNode, removeNode, addEdge, removeEdge, setGroup, addGroup, removeGroup, newNodeId,
    SHAPES, ARROWS, STROKES, DIRECTIONS, BRACKETS, ALIASES,
  };
})();
