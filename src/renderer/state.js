'use strict';

/**
 * A Mermaid state diagram as an editable document tree: parsed from
 * Mermaid's own statement tree, edited as plain objects, written back as
 * Mermaid source. Exposed as window.StateModel, with the designer adapter
 * as window.StateAdapter.
 */
(() => {
  const { mermaid } = window.MDV;
  const clone = (o) => JSON.parse(JSON.stringify(o));

  const TYPES = [['default', 'State'], ['choice', 'Choice'], ['fork', 'Fork'], ['join', 'Join']];
  const DIRECTIONS = [['TB', 'Top to bottom'], ['LR', 'Left to right'], ['BT', 'Bottom to top'], ['RL', 'Right to left']];

  /* ------------------------------------------------------------- parsing */

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
      const m = line.match(/^\s*(stateDiagram(?:-v2)?)\b/);
      if (m) return { preamble, keyword: m[1] };
      if (line.trim() === '' || line.trim().startsWith('%%')) preamble.push(line);
      else break;
    }
    return { preamble, keyword: 'stateDiagram-v2' };
  }

  async function parse(text) {
    const diagram = await mermaid.mermaidAPI.getDiagramFromText(text);
    if (!/^stateDiagram/.test(diagram.type || '')) {
      const err = new Error('Not a state diagram');
      err.code = 'NOT_SUPPORTED';
      throw err;
    }
    const db = diagram.db;
    const root = clone(db.getRootDocV2());
    const data = db.getData();
    const { preamble, keyword } = splitHeader(text);
    const doc = root.doc || [];
    normalize(doc);
    return {
      keyword, preamble, doc,
      nodes: clone(data.nodes || []),
      edges: clone(data.edges || []),
    };
  }

  const isPlain = (it) => it.stmt === 'state' && !it.note && !it.doc;

  // Mermaid splits `state X <<choice>>` and `X : label` into two statements
  // for the same state. Folding them back together keeps one definition per
  // state per scope, so edits land in one place. Only lossless merges are
  // made: a second description line is left alone.
  function normalize(doc) {
    const seen = new Map();
    for (let i = 0; i < doc.length; i++) {
      const it = doc[i];
      if (it.stmt === 'state' && it.doc) { normalize(it.doc); continue; }
      if (!isPlain(it)) continue;
      const first = seen.get(it.id);
      if (!first) { seen.set(it.id, it); continue; }
      const typed = it.type && it.type !== 'default';
      if (typed && first.type && first.type !== 'default' && first.type !== it.type) continue;
      if (it.description && first.description && it.description !== first.description) continue;
      if (typed) first.type = it.type;
      if (it.description) first.description = it.description;
      doc.splice(i--, 1);
    }
  }

  /* ----------------------------------------------------------- serialise */

  const q = (s) => '"' + String(s).replace(/"/g, '’') + '"';
  const ref = (s) => ('start' in s ? '[*]' : s.id);

  function emit(doc, depth, out) {
    const pad = '  '.repeat(depth);
    let prevDivider = false;
    for (const it of doc) {
      if (it.stmt === 'state' && it.type === 'divider') {
        // Mermaid folds `--` dividers into synthetic groups; unfold them.
        if (prevDivider) out.push(`${pad}--`);
        if (it.doc) emit(it.doc, depth, out);
        prevDivider = true;
        continue;
      }
      prevDivider = false;
      switch (it.stmt) {
        case 'dir': out.push(`${pad}direction ${it.value}`); break;
        case 'state': {
          if (it.note) {
            const t = String(it.note.text || '');
            if (t.includes('\n')) {
              // Mermaid keeps the indentation inside a note block as text,
              // so each line is trimmed or it would creep right on every save.
              out.push(`${pad}note ${it.note.position} ${it.id}`);
              for (const l of t.split('\n')) out.push(`${pad}  ${l.trim()}`);
              out.push(`${pad}end note`);
            } else {
              out.push(`${pad}note ${it.note.position} ${it.id} : ${t}`);
            }
            break;
          }
          if (it.doc) {
            out.push(`${pad}state ${it.description ? q(it.description) + ' as ' : ''}${it.id} {`);
            emit(it.doc, depth + 1, out);
            out.push(`${pad}}`);
            break;
          }
          if (it.type && it.type !== 'default') {
            out.push(`${pad}state ${it.id} <<${it.type}>>`);
            if (it.description) out.push(`${pad}${it.id} : ${it.description}`);
            break;
          }
          if (it.description) out.push(`${pad}state ${q(it.description)} as ${it.id}`);
          else out.push(`${pad}${it.id}`);
          break;
        }
        case 'relation':
          out.push(`${pad}${ref(it.state1)} --> ${ref(it.state2)}${it.description ? ' : ' + it.description : ''}`);
          break;
        case 'classDef': out.push(`${pad}classDef ${it.id} ${it.classes}`); break;
        case 'style': out.push(`${pad}style ${it.id} ${it.styleClass}`); break;
        case 'applyClass': out.push(`${pad}class ${it.id} ${it.styleClass}`); break;
        case 'click':
          out.push(`${pad}click ${it.id} href ${q(it.url || '')}${it.tooltip ? ' ' + q(it.tooltip) : ''}`);
          break;
        default: break;
      }
    }
  }

  function serialize(model) {
    const out = [...model.preamble, model.keyword];
    emit(model.doc, 1, out);
    return out.join('\n') + '\n';
  }

  /* ------------------------------------------------------------- lookups */

  // Depth-first over every statement; `fn` returning false stops the walk.
  function walk(doc, fn, parent = null) {
    for (let i = 0; i < doc.length; i++) {
      const it = doc[i];
      if (fn(it, doc, i, parent) === false) return false;
      if (it.stmt === 'state' && it.doc && walk(it.doc, fn, it) === false) return false;
    }
    return true;
  }

  // Every statement about a state, other than notes.
  function stmtsFor(model, id) {
    const out = [];
    walk(model.doc, (it, doc, i, parent) => {
      if (it.stmt === 'state' && it.id === id && !it.note) out.push({ it, doc, i, parent });
      return true;
    });
    return out;
  }

  // The statement that defines a state: the one with members, else the one
  // with a label, else the first mention.
  function definition(model, id) {
    const all = stmtsFor(model, id);
    return all.find((s) => s.it.doc) || all.find((s) => s.it.description) || all[0] || null;
  }

  const nodeOf = (model, id) => model.nodes.find((n) => n.id === id);
  const isMarker = (n) => !!n && (n.shape === 'stateStart' || n.shape === 'stateEnd');
  const isNote = (n) => !!n && /note/i.test(n.shape || '');
  const isNoteEdge = (e) => /note-edge/.test(e.classes || '');

  function labelOf(model, id) {
    const n = nodeOf(model, id);
    return n ? String(Array.isArray(n.label) ? n.label[0] : n.label) : id;
  }

  function insertDef(doc, stmt) {
    const i = doc.findIndex((it) => it.stmt !== 'dir');
    doc.splice(i < 0 ? doc.length : i, 0, stmt);
  }

  function pruneDoc(doc, pred) {
    for (let i = doc.length - 1; i >= 0; i--) {
      const it = doc[i];
      if (pred(it)) { doc.splice(i, 1); continue; }
      if (it.stmt === 'state' && it.doc) pruneDoc(it.doc, pred);
    }
  }

  function relationsInOrder(model) {
    const out = [];
    walk(model.doc, (it) => { if (it.stmt === 'relation') out.push(it); return true; });
    return out;
  }

  // Mermaid numbers transitions in the order it meets them walking the
  // tree, which is the same order `relationsInOrder` produces.
  function relationFor(model, edgeId) {
    const k = model.edges.filter((e) => !isNoteEdge(e)).findIndex((e) => e.id === edgeId);
    return k >= 0 ? relationsInOrder(model)[k] || null : null;
  }

  function newId(model, prefix) {
    const taken = new Set(model.nodes.map((n) => n.id));
    walk(model.doc, (it) => { if (it.id) taken.add(it.id); return true; });
    for (let n = 1; ; n++) {
      const id = prefix + n;
      if (!taken.has(id)) return id;
    }
  }

  /* ---------------------------------------------------------------- edits */

  function endpoint(model, id) {
    const n = nodeOf(model, id);
    if (n && n.shape === 'stateStart') return { stmt: 'state', id: '[*]', type: 'default', description: '', start: true };
    if (n && n.shape === 'stateEnd') return { stmt: 'state', id: '[*]', type: 'default', description: '', start: false };
    return { stmt: 'state', id, type: 'default', description: '' };
  }

  function relation(model, a, b, description = '') {
    return { stmt: 'relation', state1: endpoint(model, a), state2: endpoint(model, b), description };
  }

  function setLabel(model, id, text) {
    const def = definition(model, id);
    if (def) { def.it.description = text; return; }
    insertDef(model.doc, { stmt: 'state', id, type: 'default', description: text });
  }

  function setType(model, id, type) {
    const def = definition(model, id);
    if (def) { def.it.type = type; return; }
    insertDef(model.doc, { stmt: 'state', id, type, description: '' });
  }

  function addState(model, after) {
    const id = newId(model, 'S');
    const def = after ? definition(model, after) : null;
    const doc = def ? def.doc : model.doc;
    doc.push({ stmt: 'state', id, type: 'default', description: 'New state' });
    if (after) doc.push(relation(model, after, id));
    return id;
  }

  function removeState(model, id) {
    pruneDoc(model.doc, (it) =>
      (it.stmt === 'state' && it.id === id)
      || (it.stmt === 'relation' && (it.state1.id === id || it.state2.id === id)));
  }

  function addRelation(model, a, b) {
    const da = definition(model, a);
    const db = definition(model, b);
    const doc = da && db && da.doc === db.doc ? da.doc : model.doc;
    doc.push(relation(model, a, b));
  }

  function removeRelation(model, edgeId) {
    const rel = relationFor(model, edgeId);
    if (rel) pruneDoc(model.doc, (it) => it === rel);
  }

  function setRelationLabel(model, edgeId, text) {
    const rel = relationFor(model, edgeId);
    if (rel) rel.description = text;
  }

  function reverseRelation(model, edgeId) {
    const rel = relationFor(model, edgeId);
    if (rel) [rel.state1, rel.state2] = [rel.state2, rel.state1];
  }

  function groups(model) {
    const out = [];
    walk(model.doc, (it) => {
      if (it.stmt === 'state' && it.doc && it.type !== 'divider') out.push({ id: it.id, title: it.description || it.id, stmt: it });
      return true;
    });
    return out;
  }

  function groupOf(model, id) {
    const def = definition(model, id);
    return def && def.parent ? def.parent.id : '';
  }

  // Moves a state into a composite (or out to the top level). Every plain
  // mention of it goes, folded into one statement, so nothing is left behind
  // to pin it in its old scope.
  function setGroup(model, id, groupId) {
    const merged = { stmt: 'state', id, type: 'default', description: '' };
    for (const s of stmtsFor(model, id)) {
      if (s.it.doc) continue;
      if (s.it.type && s.it.type !== 'default') merged.type = s.it.type;
      if (s.it.description && !merged.description) merged.description = s.it.description;
    }
    const composite = stmtsFor(model, id).find((s) => s.it.doc);
    pruneDoc(model.doc, (it) => isPlain(it) && it.id === id);
    if (!merged.description && !composite) merged.description = labelOf(model, id);
    const target = groupId ? definition(model, groupId) : null;
    const dest = target ? target.it.doc : model.doc;
    if (composite) {
      // A composite moves as a whole, members and all.
      composite.doc.splice(composite.i, 1);
      if (merged.type !== 'default') composite.it.type = merged.type;
      insertDef(dest, composite.it);
      return;
    }
    insertDef(dest, merged);
  }

  function addGroup(model, title, memberId) {
    const id = newId(model, 'G');
    const stmt = { stmt: 'state', id, type: 'default', description: title, doc: [] };
    model.doc.push(stmt);
    if (memberId) setGroup(model, memberId, id);
    else stmt.doc.push({ stmt: 'state', id: newId(model, 'S'), type: 'default', description: 'New state' });
    return id;
  }

  function removeGroup(model, id) {
    const def = definition(model, id);
    if (!def) return;
    const inner = (def.it.doc || []).filter((it) => it.stmt !== 'dir');
    def.doc.splice(def.i, 1, ...inner);
    pruneDoc(model.doc, (it) => it.stmt === 'relation' && (it.state1.id === id || it.state2.id === id));
  }

  function direction(model, groupId) {
    const doc = groupId ? (definition(model, groupId) || {}).it?.doc : model.doc;
    const d = (doc || []).find((it) => it.stmt === 'dir');
    return d ? d.value : (groupId ? '' : 'TB');
  }

  function setDirection(model, dir, groupId) {
    const doc = groupId ? (definition(model, groupId) || {}).it?.doc : model.doc;
    if (!doc) return;
    const i = doc.findIndex((it) => it.stmt === 'dir');
    if (!dir) { if (i >= 0) doc.splice(i, 1); return; }
    if (i >= 0) doc[i].value = dir;
    else doc.unshift({ stmt: 'dir', value: dir });
  }

  window.StateModel = {
    parse, serialize, splitHeader, walk, definition, nodeOf, labelOf, relationFor, groups, groupOf,
    setLabel, setType, addState, removeState, addRelation, removeRelation, setRelationLabel,
    reverseRelation, setGroup, addGroup, removeGroup, direction, setDirection,
    isMarker, isNote, isNoteEdge, TYPES, DIRECTIONS,
  };

  /* ===================================================== designer adapter */

  const SM = window.StateModel;
  const nodeEl = (canvas, esc, n) => canvas.querySelector(`g.node[id$="-${esc(n.domId)}"]`);
  // Composite states sit under a <g class="clusters"> with their own class
  // names, so the wrapper is the reliable hook.
  const clusterEl = (canvas, esc, n) => canvas.querySelector(`g.clusters g[id$="-${esc(n.domId)}"]`);
  const pathEl = (canvas, esc, e) =>
    canvas.querySelector(`path.transition[data-id="${esc(e.id)}"]`) || canvas.querySelector(`path.transition[id$="-${esc(e.id)}"]`);

  // Edge labels carry no id, but they are laid down in the same order as
  // the paths, so the nth label belongs to the nth path.
  function labelEl(canvas, e) {
    const paths = [...canvas.querySelectorAll('path.transition')];
    const labels = [...canvas.querySelectorAll('g.edgeLabel')];
    if (paths.length !== labels.length) return null;
    const i = paths.findIndex((p) => (p.getAttribute('data-id') || p.id).endsWith(e.id));
    return i >= 0 ? labels[i] : null;
  }

  const edgeOf = (m, sel) => (sel && sel.kind === 'edge' ? m.edges.find((e) => e.id === sel.id) : null);

  window.StateAdapter = {
    name: 'state diagrams',
    addLabel: () => '+ State',
    matches: (type) => /^stateDiagram/.test(type),
    parse, serialize,

    bind(canvas, model, ctx) {
      for (const n of model.nodes) {
        if (isNote(n)) continue;
        const sel = { kind: n.isGroup ? 'group' : 'node', id: n.id };
        const el = n.isGroup ? clusterEl(canvas, ctx.esc, n) : nodeEl(canvas, ctx.esc, n);
        if (!el) continue;
        el.classList.add('fd-node');
        el.addEventListener('click', (e) => { e.stopPropagation(); ctx.click(sel, e); });
        if (!isMarker(n)) el.addEventListener('dblclick', (e) => { e.stopPropagation(); ctx.dblclick(sel); });
      }
      for (const e of model.edges) {
        if (isNoteEdge(e)) continue;
        const sel = { kind: 'edge', id: e.id };
        const path = pathEl(canvas, ctx.esc, e);
        if (path) {
          path.classList.add('fd-edge');
          path.addEventListener('click', (ev) => { ev.stopPropagation(); ctx.click(sel, ev); });
        }
        const label = labelEl(canvas, e);
        if (label) {
          label.classList.add('fd-edge-label');
          label.addEventListener('click', (ev) => { ev.stopPropagation(); ctx.click(sel, ev); });
          label.addEventListener('dblclick', (ev) => { ev.stopPropagation(); ctx.setSelection(sel); ctx.focusField('label'); });
        }
      }
    },

    applySelection(canvas, model, sel) {
      const esc = window.FlowDesigner.esc;
      if (sel.kind === 'node' || sel.kind === 'group') {
        const n = nodeOf(model, sel.id);
        const el = n && (n.isGroup ? clusterEl(canvas, esc, n) : nodeEl(canvas, esc, n));
        if (el) el.classList.add('fd-selected');
      } else if (sel.kind === 'edge') {
        const e = edgeOf(model, sel);
        if (!e) return;
        const path = pathEl(canvas, esc, e);
        if (path) path.classList.add('fd-selected');
        const label = labelEl(canvas, e);
        if (label) label.classList.add('fd-selected');
      }
    },

    canConnect: (sel) => sel.kind === 'node' || sel.kind === 'group',
    connect(model, a, b) {
      SM.addRelation(model, a.id, b.id);
      return { kind: 'edge', pair: [a.id, b.id] };
    },
    resolveSelection(model, sel) {
      if (sel.kind === 'edge' && sel.pair) {
        // A `[*]` marker is a start at one end of an arrow and an end at the
        // other, so a reversed pair swaps marker ids too.
        const from = sel.pair[0].replace(/_end$/, '_start');
        const to = sel.pair[1].replace(/_start$/, '_end');
        const matches = model.edges.filter((e) => !isNoteEdge(e) && e.start === from && e.end === to);
        const last = matches[matches.length - 1];
        return last ? { kind: 'edge', id: last.id } : null;
      }
      return sel;
    },
    add(model, sel) {
      const after = sel && (sel.kind === 'node' || sel.kind === 'group') ? sel.id : null;
      return { kind: 'node', id: SM.addState(model, after) };
    },
    remove(model, sel) {
      if (sel.kind === 'node') SM.removeState(model, sel.id);
      else if (sel.kind === 'group') SM.removeGroup(model, sel.id);
      else if (sel.kind === 'edge') SM.removeRelation(model, sel.id);
    },
    label(model, sel) {
      if (sel.kind === 'edge') { const r = SM.relationFor(model, sel.id); return r ? r.description || '' : ''; }
      return SM.labelOf(model, sel.id);
    },
    setLabel(model, sel, text) {
      if (sel.kind === 'edge') SM.setRelationLabel(model, sel.id, text);
      else SM.setLabel(model, sel.id, text);
    },
    labelElement(canvas, model, sel) {
      const esc = window.FlowDesigner.esc;
      if (sel.kind === 'edge') { const e = edgeOf(model, sel); return e ? labelEl(canvas, e) : null; }
      const n = nodeOf(model, sel.id);
      if (!n || isMarker(n)) return null;
      if (n.isGroup) { const c = clusterEl(canvas, esc, n); return c ? (c.querySelector('.cluster-label') || c) : null; }
      return nodeEl(canvas, esc, n);
    },

    inspector(model, sel, ctx) {
      const { h, field, select, commit, commitTyped, askText } = ctx;
      const groupOptions = () => [['', '(none)'], ...SM.groups(model).map((g) => [g.id, g.title])];

      if (sel && (sel.kind === 'node' || sel.kind === 'group')) {
        const n = nodeOf(model, sel.id);
        if (!n) return [];
        if (isMarker(n)) {
          return [
            h('div', { class: 'fd-head', text: n.shape === 'stateStart' ? 'Start marker' : 'End marker' }),
            h('p', { class: 'fd-hint', text: 'Shift+click a state to draw a transition from here, or select a state and Shift+click this marker to end there.' }),
          ];
        }
        const id = n.id;
        const label = h('input', { type: 'text', value: SM.labelOf(model, id), 'data-field': 'label', spellcheck: 'false' });
        label.addEventListener('input', () => commitTyped((m) => SM.setLabel(m, id, label.value), 'label:' + id));
        const rows = [h('div', { class: 'fd-head', text: `${n.isGroup ? 'Composite state' : 'State'} ${id}` }), field(n.isGroup ? 'Title' : 'Label', label)];
        if (n.isGroup) {
          rows.push(
            field('Layout inside', select([['', 'Inherit'], ...SM.DIRECTIONS], SM.direction(model, id), (val) => commit((m) => SM.setDirection(m, val, id)))),
            field('Inside', select(groupOptions().filter(([g]) => g !== id), SM.groupOf(model, id), (val) => commit((m) => SM.setGroup(m, id, val)))),
            h('button', { type: 'button', class: 'ghost-btn', text: 'Ungroup (keep states)', onclick: () => commit((m) => SM.removeGroup(m, id), { select: null }) }),
          );
        } else {
          const def = SM.definition(model, id);
          const type = (def && def.it.type) || 'default';
          rows.push(
            field('Kind', select(SM.TYPES.some(([k]) => k === type) ? SM.TYPES : [...SM.TYPES, [type, type]], type, (val) => commit((m) => SM.setType(m, id, val)))),
            field('Inside', select(groupOptions(), SM.groupOf(model, id), (val) => commit((m) => SM.setGroup(m, id, val)))),
          );
        }
        rows.push(h('p', { class: 'fd-hint', text: 'Double-click to rename in place. Shift+click another state to add a transition.' }));
        return rows;
      }
      if (sel && sel.kind === 'edge') {
        const e = edgeOf(model, sel);
        if (!e) return [];
        const rel = SM.relationFor(model, e.id);
        const label = h('input', { type: 'text', value: rel ? rel.description || '' : '', 'data-field': 'label', spellcheck: 'false' });
        label.addEventListener('input', () => commitTyped((m) => SM.setRelationLabel(m, e.id, label.value), 'edge:' + e.id));
        const name = (id) => { const n = nodeOf(model, id); return n && n.shape === 'stateStart' ? '[start]' : n && n.shape === 'stateEnd' ? '[end]' : SM.labelOf(model, id); };
        return [
          h('div', { class: 'fd-head', text: `${name(e.start)} → ${name(e.end)}` }),
          field('Label', label),
          h('button', { type: 'button', class: 'ghost-btn', text: 'Reverse direction',
            onclick: () => commit((m) => SM.reverseRelation(m, e.id), { select: { kind: 'edge', pair: [e.end, e.start] } }) }),
        ];
      }
      const gs = SM.groups(model);
      return [
        h('div', { class: 'fd-head', text: 'Diagram' }),
        field('Direction', select(SM.DIRECTIONS, SM.direction(model, '') || 'TB', (val) => commit((m) => SM.setDirection(m, val, '')))),
        h('button', { type: 'button', class: 'ghost-btn', text: '+ Composite state', title: 'A box that holds other states',
          onclick: () => askText('New composite state', 'Group', (title) => commit((m) => { SM.addGroup(m, title || 'Group', null); })) }),
        gs.length ? h('div', { class: 'fd-groups' },
          h('div', { class: 'fd-head', text: 'Composite states' }),
          ...gs.map((g) => h('div', { class: 'fd-group-row' },
            h('span', { text: g.title }),
            h('button', { type: 'button', class: 'ghost-btn sm', text: 'Select', onclick: () => ctx.setSelection({ kind: 'group', id: g.id }) }),
            h('button', { type: 'button', class: 'ghost-btn sm', text: 'Ungroup', onclick: () => commit((m) => SM.removeGroup(m, g.id)) }),
          ))) : null,
        h('p', { class: 'fd-hint', text: 'Click a state or transition to edit it. Double-click a state to rename. Delete removes the selection.' }),
      ];
    },
  };
})();
