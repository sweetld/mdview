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

/* ===================================================== designer adapter */
// How the generic designer sees a flowchart: where its nodes and edges are
// in the SVG, and what the inspector offers for each.
(() => {
  const FM = () => window.FlowModel;

  const nodeEl = (canvas, esc, v) => canvas.querySelector(`g.node[id$="-${esc(v.domId || '')}"]`);
  const edgeEl = (canvas, esc, e) => canvas.querySelector(`path.flowchart-link[id$="-${esc(e.id)}"]`);
  const labelEls = (canvas) => [...canvas.querySelectorAll('g.edgeLabel')];
  const vertex = (m, sel) => (sel && sel.kind === 'node' ? m.vertices.find((v) => v.id === sel.id) : null);
  const edgeIndex = (m, sel) => (sel && sel.kind === 'edge' ? m.edges.findIndex((e) => e.id === sel.id) : -1);

  function labelFor(canvas, m, i) {
    const labels = labelEls(canvas);
    return labels.length === m.edges.length ? labels[i] : null;
  }

  window.FlowAdapter = {
    name: 'flowcharts',
    addLabel: () => '+ Node',
    matches: (type) => /^flowchart|^graph/.test(type),
    parse: (text) => FM().parse(text),
    serialize: (model) => FM().serialize(model),

    bind(canvas, model, ctx) {
      for (const v of model.vertices) {
        const g = nodeEl(canvas, ctx.esc, v);
        if (!g) continue;
        g.classList.add('fd-node');
        g.addEventListener('click', (e) => { e.stopPropagation(); ctx.click({ kind: 'node', id: v.id }, e); });
        g.addEventListener('dblclick', (e) => { e.stopPropagation(); ctx.dblclick({ kind: 'node', id: v.id }); });
      }
      model.edges.forEach((edge, i) => {
        const sel = { kind: 'edge', id: edge.id };
        const path = edgeEl(canvas, ctx.esc, edge);
        if (path) {
          path.classList.add('fd-edge');
          path.addEventListener('click', (e) => { e.stopPropagation(); ctx.click(sel, e); });
        }
        const label = labelFor(canvas, model, i);
        if (label) {
          label.classList.add('fd-edge-label');
          label.addEventListener('click', (e) => { e.stopPropagation(); ctx.click(sel, e); });
          label.addEventListener('dblclick', (e) => { e.stopPropagation(); ctx.setSelection(sel); ctx.focusField('label'); });
        }
      });
    },

    applySelection(canvas, model, sel) {
      const v = vertex(model, sel);
      if (v) { const g = nodeEl(canvas, window.FlowDesigner.esc, v); if (g) g.classList.add('fd-selected'); }
      const i = edgeIndex(model, sel);
      if (i >= 0) {
        const path = edgeEl(canvas, window.FlowDesigner.esc, model.edges[i]);
        if (path) path.classList.add('fd-selected');
        const label = labelFor(canvas, model, i);
        if (label) label.classList.add('fd-selected');
      }
    },

    canConnect: (sel) => sel.kind === 'node',
    connect(model, a, b) {
      FM().addEdge(model, a.id, b.id);
      return { kind: 'edge', pair: [a.id, b.id] };
    },
    resolveSelection(model, sel) {
      if (sel.kind === 'edge' && sel.pair) {
        const matches = model.edges.filter((e) => e.start === sel.pair[0] && e.end === sel.pair[1]);
        const last = matches[matches.length - 1];
        return last ? { kind: 'edge', id: last.id } : null;
      }
      return sel;
    },
    add(model, sel) {
      const v = vertex(model, sel);
      const id = FM().addNode(model, { after: v ? v.id : null });
      return { kind: 'node', id };
    },
    remove(model, sel) {
      const v = vertex(model, sel);
      if (v) { FM().removeNode(model, v.id); return; }
      const i = edgeIndex(model, sel);
      if (i >= 0) FM().removeEdge(model, i);
    },
    label(model, sel) {
      const v = vertex(model, sel);
      if (v) return v.text;
      const i = edgeIndex(model, sel);
      return i >= 0 ? model.edges[i].text : '';
    },
    setLabel(model, sel, text) {
      const v = vertex(model, sel);
      if (v) { v.text = text; return; }
      const i = edgeIndex(model, sel);
      if (i >= 0) model.edges[i].text = text;
    },
    labelElement(canvas, model, sel) {
      const v = vertex(model, sel);
      if (v) return nodeEl(canvas, window.FlowDesigner.esc, v);
      const i = edgeIndex(model, sel);
      return i >= 0 ? labelFor(canvas, model, i) : null;
    },

    inspector(model, sel, ctx) {
      const { h, field, select, commit, commitTyped, askText } = ctx;
      const v = vertex(model, sel);
      const ei = edgeIndex(model, sel);

      if (v) {
        const label = h('input', { type: 'text', value: v.text, 'data-field': 'label', spellcheck: 'false' });
        label.addEventListener('input', () => {
          commitTyped((m) => { const n = m.vertices.find((x) => x.id === v.id); if (n) n.text = label.value; }, 'label:' + v.id);
        });
        const shapeNow = v.type ? (FM().BRACKETS[v.type] ? v.type : FM().ALIASES[v.type] || v.type) : 'square';
        const shapes = FM().SHAPES.some(([k]) => k === shapeNow) ? FM().SHAPES : [...FM().SHAPES, [shapeNow, shapeNow]];
        const groups = [['', '(none)'], ...model.subgraphs.map((s) => [s.id, s.title || s.id])];
        const group = model.subgraphs.find((s) => s.nodes.includes(v.id));
        const link = h('input', { type: 'text', value: v.link || '', 'data-field': 'link', placeholder: 'https://…', spellcheck: 'false' });
        link.addEventListener('change', () => {
          commit((m) => { const n = m.vertices.find((x) => x.id === v.id); if (n) n.link = link.value.trim() || undefined; });
        });
        return [
          h('div', { class: 'fd-head', text: `Node ${v.id}` }),
          field('Label', label),
          field('Shape', select(shapes, shapeNow, (val) => commit((m) => { const n = m.vertices.find((x) => x.id === v.id); if (n) n.type = val; }))),
          field('Group', select(groups, group ? group.id : '', (val) => commit((m) => FM().setGroup(m, v.id, val)))),
          field('Link', link),
          h('p', { class: 'fd-hint', text: 'Double-click the node to rename it in place. Shift+click another node to connect.' }),
        ];
      }
      if (ei >= 0) {
        const e = model.edges[ei];
        const label = h('input', { type: 'text', value: e.text, 'data-field': 'label', spellcheck: 'false' });
        label.addEventListener('input', () => {
          commitTyped((m) => { if (m.edges[ei]) m.edges[ei].text = label.value; }, 'edge:' + ei);
        });
        return [
          h('div', { class: 'fd-head', text: `${e.start} → ${e.end}` }),
          field('Label', label),
          field('Arrow', select(FM().ARROWS, e.type, (val) => commit((m) => { if (m.edges[ei]) m.edges[ei].type = val; }))),
          field('Line', select(FM().STROKES, e.stroke, (val) => commit((m) => { if (m.edges[ei]) m.edges[ei].stroke = val; }))),
          field('Length', select([['1', 'Normal'], ['2', 'Longer'], ['3', 'Longest']], String(Math.min(3, e.length || 1)),
            (val) => commit((m) => { if (m.edges[ei]) m.edges[ei].length = Number(val); }))),
          h('button', { type: 'button', class: 'ghost-btn', text: 'Reverse direction',
            onclick: () => commit((m) => { const x = m.edges[ei]; if (x) [x.start, x.end] = [x.end, x.start]; }, { select: { kind: 'edge', pair: [e.end, e.start] } }) }),
        ];
      }
      const groups = model.subgraphs;
      return [
        h('div', { class: 'fd-head', text: 'Diagram' }),
        field('Direction', select(FM().DIRECTIONS, model.direction === 'TD' ? 'TB' : model.direction, (val) => commit((m) => { m.direction = val; }))),
        h('button', { type: 'button', class: 'ghost-btn', text: '+ Group', title: 'Add a subgraph box',
          onclick: () => askText('New group', 'Group', (title) => commit((m) => { FM().addGroup(m, title || 'Group'); })) }),
        groups.length ? h('div', { class: 'fd-groups' },
          h('div', { class: 'fd-head', text: 'Groups' }),
          ...groups.map((s) => h('div', { class: 'fd-group-row' },
            h('span', { text: s.title || s.id, title: `${s.nodes.length} node${s.nodes.length === 1 ? '' : 's'}` }),
            h('button', { type: 'button', class: 'ghost-btn sm', text: 'Rename', onclick: () => askText('Rename group', s.title || s.id, (title) => {
              commit((m) => { const g = m.subgraphs.find((x) => x.id === s.id); if (g) g.title = title; });
            }) }),
            h('button', { type: 'button', class: 'ghost-btn sm', text: 'Ungroup', onclick: () => commit((m) => FM().removeGroup(m, s.id)) }),
          ))) : null,
        h('p', { class: 'fd-hint', text: 'Click a node or connection to edit it. Double-click a node to rename. Delete removes the selection.' }),
      ];
    },
  };
})();
