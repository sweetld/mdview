'use strict';

/**
 * Visual editing of a Mermaid flowchart on top of its own rendering: click to
 * select, double-click to rename, drag nothing — Mermaid lays the diagram out
 * — but add, connect, reshape, relabel and delete directly on the picture.
 * Every change regenerates the Mermaid source, which is what gets saved.
 * Exposed as window.FlowDesigner.
 */
(() => {
  const FM = () => window.FlowModel;

  function h(tag, attrs = {}, ...children) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (v !== undefined && v !== null && v !== false) el.setAttribute(k, v === true ? '' : v);
    }
    for (const c of children) if (c !== null && c !== undefined) el.append(c);
    return el;
  }

  function select(options, value, onchange) {
    const sel = h('select', { onchange: (e) => onchange(e.target.value) });
    for (const [val, label] of options) {
      sel.append(h('option', { value: val, text: label, selected: val === value }));
    }
    return sel;
  }

  function field(label, control) {
    return h('label', { class: 'fd-field' }, h('span', { text: label }), control);
  }

  /**
   * @param {object} opts
   * @param {HTMLElement} opts.parent   where the designer mounts
   * @param {(text: string) => Promise<string>} opts.renderSvg   Mermaid → SVG markup
   * @param {(text: string) => void} opts.onChange   regenerated source
   * @param {(msg: string, isError?: boolean) => void} [opts.onStatus]
   */
  function create({ parent, renderSvg, onChange, onStatus }) {
    const canvas = h('div', { class: 'fd-canvas', tabindex: '0' });
    const inspector = h('div', { class: 'fd-inspector' });
    const root = h('div', { class: 'fd-root' }, canvas, inspector);
    parent.append(root);

    const st = {
      model: null, text: '', selection: null, connecting: false,
      history: [], future: [], coalesce: null, drawSeq: 0,
    };

    const status = (msg, isError) => { if (onStatus) onStatus(msg, isError); };

    /* ------------------------------------------------------------ loading */

    async function load(text, { silent = false } = {}) {
      // The picture is always drawn from regenerated source, and Mermaid
      // numbers its DOM ids by definition order — so the model has to come
      // from that same regenerated text or clicks would miss their nodes.
      const first = await FM().parse(text);
      st.model = await FM().parse(FM().serialize(first));
      st.text = text;
      if (!silent) { st.history = []; st.future = []; }
      await draw();
    }

    async function draw() {
      const mine = ++st.drawSeq;
      let svg;
      try {
        svg = await renderSvg(FM().serialize(st.model));
      } catch (err) {
        status(err && err.message ? err.message.split('\n')[0] : String(err), true);
        return;
      }
      if (mine !== st.drawSeq) return;
      canvas.innerHTML = svg;
      bindCanvas();
      applySelection();
      // Rebuilding the form while someone is typing in it would steal the
      // caret; the fields already show what was typed.
      const active = document.activeElement;
      const typing = active && active.tagName === 'INPUT' && inspector.contains(active);
      if (!typing || JSON.stringify(st.selection) !== st.inspectorKey) renderInspector();
      status('');
    }

    // Text fields regenerate the diagram once typing pauses, not per key.
    let typeTimer = null;
    function commitTyped(mutate, coalesce) {
      clearTimeout(typeTimer);
      typeTimer = setTimeout(() => commit(mutate, { coalesce }), 350);
    }

    /* ------------------------------------------------------------- lookup */

    const esc = (s) => (window.CSS && CSS.escape ? CSS.escape(s) : s);

    function nodeEl(v) {
      return canvas.querySelector(`g.node[id$="-${esc(v.domId || '')}"]`);
    }

    function edgeEl(e) {
      return canvas.querySelector(`path.flowchart-link[id$="-${esc(e.id)}"]`);
    }

    function edgeLabelEls() {
      return [...canvas.querySelectorAll('g.edgeLabel')];
    }

    function selectedNode() {
      return st.selection && st.selection.kind === 'node'
        ? st.model.vertices.find((v) => v.id === st.selection.id) : null;
    }

    function selectedEdgeIndex() {
      if (!st.selection || st.selection.kind !== 'edge') return -1;
      return st.model.edges.findIndex((e) => e.id === st.selection.id);
    }

    /* ------------------------------------------------------------ binding */

    function bindCanvas() {
      for (const v of st.model.vertices) {
        const g = nodeEl(v);
        if (!g) continue;
        g.classList.add('fd-node');
        g.addEventListener('click', (e) => { e.stopPropagation(); onNodeClick(v, e); });
        g.addEventListener('dblclick', (e) => { e.stopPropagation(); renameInline(v); });
      }
      const labels = edgeLabelEls();
      const labelsMatch = labels.length === st.model.edges.length;
      st.model.edges.forEach((edge, i) => {
        const path = edgeEl(edge);
        if (path) {
          path.classList.add('fd-edge');
          path.addEventListener('click', (e) => { e.stopPropagation(); setSelection({ kind: 'edge', id: edge.id }); });
        }
        if (labelsMatch && labels[i]) {
          labels[i].classList.add('fd-edge-label');
          labels[i].addEventListener('click', (e) => { e.stopPropagation(); setSelection({ kind: 'edge', id: edge.id }); });
          labels[i].addEventListener('dblclick', (e) => { e.stopPropagation(); setSelection({ kind: 'edge', id: edge.id }); focusInspectorField('label'); });
        }
      });
    }

    canvas.addEventListener('click', () => {
      if (st.connecting) { st.connecting = false; canvas.classList.remove('connecting'); renderInspector(); return; }
      setSelection(null);
    });

    canvas.addEventListener('keydown', (e) => {
      if (e.target !== canvas) return;
      if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); deleteSelection(); }
      else if (e.key === 'Escape') { st.connecting = false; canvas.classList.remove('connecting'); setSelection(null); }
      else if (e.key === 'Enter') { const v = selectedNode(); if (v) { e.preventDefault(); renameInline(v); } }
    });

    function onNodeClick(v, e) {
      const from = selectedNode();
      if ((st.connecting || e.shiftKey) && from && from.id !== v.id) {
        st.connecting = false;
        canvas.classList.remove('connecting');
        commit((m) => { FM().addEdge(m, from.id, v.id); }, { select: { kind: 'edge', pair: [from.id, v.id] } });
        return;
      }
      setSelection({ kind: 'node', id: v.id });
    }

    function setSelection(sel) {
      st.selection = sel;
      applySelection();
      renderInspector();
      canvas.focus({ preventScroll: true });
    }

    function applySelection() {
      canvas.querySelectorAll('.fd-selected').forEach((n) => n.classList.remove('fd-selected'));
      const v = selectedNode();
      if (v) { const g = nodeEl(v); if (g) g.classList.add('fd-selected'); }
      const i = selectedEdgeIndex();
      if (i >= 0) {
        const path = edgeEl(st.model.edges[i]);
        if (path) path.classList.add('fd-selected');
        const labels = edgeLabelEls();
        if (labels.length === st.model.edges.length && labels[i]) labels[i].classList.add('fd-selected');
      }
    }

    /* ------------------------------------------------------------ editing */

    // Applies a change to the model, regenerates the source, and redraws.
    // Re-parsing the regenerated text keeps ids in step with what Mermaid
    // will put in the SVG. `coalesce` folds a run of keystrokes into one
    // undo step.
    async function commit(mutate, { select, coalesce = null } = {}) {
      if (!(coalesce && st.coalesce === coalesce)) st.history.push(st.text);
      st.coalesce = coalesce;
      st.future = [];
      if (st.history.length > 100) st.history.shift();
      mutate(st.model);
      const text = FM().serialize(st.model);
      try {
        st.model = await FM().parse(text);
      } catch (err) {
        status('Could not apply: ' + (err.message || err), true);
        st.history.pop();
        return;
      }
      st.text = text;
      onChange(text);
      if (select) st.selection = resolveSelection(select);
      await draw();
    }

    function resolveSelection(sel) {
      if (sel.kind === 'edge' && sel.pair) {
        const matches = st.model.edges.filter((e) => e.start === sel.pair[0] && e.end === sel.pair[1]);
        const last = matches[matches.length - 1];
        return last ? { kind: 'edge', id: last.id } : null;
      }
      return sel;
    }

    async function undo() {
      if (!st.history.length) return;
      st.future.push(st.text);
      const text = st.history.pop();
      st.coalesce = null;
      await load(text, { silent: true });
      onChange(text);
    }

    async function redo() {
      if (!st.future.length) return;
      st.history.push(st.text);
      const text = st.future.pop();
      st.coalesce = null;
      await load(text, { silent: true });
      onChange(text);
    }

    function deleteSelection() {
      const v = selectedNode();
      if (v) { commit((m) => FM().removeNode(m, v.id), { select: null }); return; }
      const i = selectedEdgeIndex();
      if (i >= 0) commit((m) => FM().removeEdge(m, i), { select: null });
    }

    function addNode() {
      const from = selectedNode();
      let id = null;
      commit((m) => { id = FM().addNode(m, { after: from ? from.id : null }); }, { select: null })
        .then(() => {
          const v = st.model.vertices.find((n) => n.id === id);
          if (v) { st.selection = { kind: 'node', id }; applySelection(); renderInspector(); renameInline(v); }
        });
    }

    function startConnect() {
      if (!selectedNode()) { status('Select the node the connection starts from first'); return; }
      st.connecting = true;
      canvas.classList.add('connecting');
      status('Click the node to connect to (Esc to cancel)');
      renderInspector();
    }

    // An input laid over the node itself, so renaming feels like editing the
    // picture rather than a form.
    function renameInline(v) {
      const g = nodeEl(v);
      if (!g) return;
      canvas.querySelectorAll('.fd-inline').forEach((n) => n.remove());
      const box = g.getBoundingClientRect();
      const base = canvas.getBoundingClientRect();
      const input = h('input', { class: 'fd-inline', type: 'text', value: v.text, spellcheck: 'false' });
      input.style.left = `${box.left - base.left + canvas.scrollLeft}px`;
      input.style.top = `${box.top - base.top + canvas.scrollTop + box.height / 2 - 14}px`;
      input.style.width = `${Math.max(90, box.width)}px`;
      let done = false;
      const finish = (apply) => {
        if (done) return;
        done = true;
        const value = input.value.trim();
        input.remove();
        if (apply && value && value !== v.text) {
          commit((m) => { const n = m.vertices.find((x) => x.id === v.id); if (n) n.text = value; });
        } else {
          canvas.focus({ preventScroll: true });
        }
      };
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); finish(true); }
        else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
        e.stopPropagation();
      });
      input.addEventListener('blur', () => finish(true));
      canvas.append(input);
      input.focus();
      input.select();
    }

    /* ---------------------------------------------------------- inspector */

    // Electron has no window.prompt; a small form in the inspector stands in.
    function askText(label, initial, onDone) {
      inspector.replaceChildren();
      const input = h('input', { type: 'text', value: initial, spellcheck: 'false' });
      const finish = (ok) => { if (ok) onDone(input.value.trim()); else renderInspector(); };
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); finish(true); }
        if (e.key === 'Escape') { e.preventDefault(); finish(false); }
      });
      inspector.append(
        h('div', { class: 'fd-head', text: label }),
        field('Title', input),
        h('div', { class: 'fd-tools' },
          h('button', { type: 'button', class: 'primary-btn', text: 'OK', onclick: () => finish(true) }),
          h('button', { type: 'button', class: 'ghost-btn', text: 'Cancel', onclick: () => finish(false) }),
        ),
      );
      input.focus();
      input.select();
    }

    function focusInspectorField(name) {
      const el = inspector.querySelector(`[data-field="${name}"]`);
      if (el) { el.focus(); if (el.select) el.select(); }
    }

    function renderInspector() {
      inspector.replaceChildren();
      const model = st.model;
      if (!model) return;
      st.inspectorKey = JSON.stringify(st.selection);

      const tools = h('div', { class: 'fd-tools' },
        h('button', { type: 'button', class: 'ghost-btn', text: '+ Node', title: 'Add a node (connected to the selection, if any)', onclick: addNode }),
        h('button', { type: 'button', class: 'ghost-btn', text: st.connecting ? 'Connecting…' : 'Connect', title: 'Connect the selected node to another (or Shift+click)', disabled: !selectedNode(), onclick: startConnect }),
        h('button', { type: 'button', class: 'ghost-btn', text: 'Delete', disabled: !st.selection, onclick: deleteSelection }),
      );
      inspector.append(tools);

      const v = selectedNode();
      const ei = selectedEdgeIndex();

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
        inspector.append(
          h('div', { class: 'fd-head', text: `Node ${v.id}` }),
          field('Label', label),
          field('Shape', select(shapes, shapeNow, (val) => commit((m) => { const n = m.vertices.find((x) => x.id === v.id); if (n) n.type = val; }))),
          field('Group', select(groups, group ? group.id : '', (val) => commit((m) => FM().setGroup(m, v.id, val)))),
          field('Link', link),
          h('p', { class: 'fd-hint', text: 'Double-click the node to rename it in place. Shift+click another node to connect.' }),
        );
      } else if (ei >= 0) {
        const e = model.edges[ei];
        const label = h('input', { type: 'text', value: e.text, 'data-field': 'label', spellcheck: 'false' });
        label.addEventListener('input', () => {
          commitTyped((m) => { if (m.edges[ei]) m.edges[ei].text = label.value; }, 'edge:' + ei);
        });
        inspector.append(
          h('div', { class: 'fd-head', text: `${e.start} → ${e.end}` }),
          field('Label', label),
          field('Arrow', select(FM().ARROWS, e.type, (val) => commit((m) => { if (m.edges[ei]) m.edges[ei].type = val; }))),
          field('Line', select(FM().STROKES, e.stroke, (val) => commit((m) => { if (m.edges[ei]) m.edges[ei].stroke = val; }))),
          field('Length', select([['1', 'Normal'], ['2', 'Longer'], ['3', 'Longest']], String(Math.min(3, e.length || 1)),
            (val) => commit((m) => { if (m.edges[ei]) m.edges[ei].length = Number(val); }))),
          h('button', { type: 'button', class: 'ghost-btn', text: 'Reverse direction',
            onclick: () => commit((m) => { const x = m.edges[ei]; if (x) [x.start, x.end] = [x.end, x.start]; }, { select: { kind: 'edge', pair: [e.end, e.start] } }) }),
        );
      } else {
        const groups = model.subgraphs;
        inspector.append(
          h('div', { class: 'fd-head', text: 'Diagram' }),
          field('Direction', select(FM().DIRECTIONS, model.direction === 'TD' ? 'TB' : model.direction, (val) => commit((m) => { m.direction = val; }))),
          h('button', { type: 'button', class: 'ghost-btn', text: '+ Group', title: 'Add a subgraph box',
            onclick: () => askText('New group', 'Group', (title) => {
              commit((m) => { FM().addGroup(m, title || 'Group'); });
            }) }),
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
        );
      }
    }

    return {
      root, canvas, load, undo, redo,
      getText: () => st.text,
      isActive: () => root.contains(document.activeElement),
      canUndo: () => st.history.length > 0,
      destroy() { clearTimeout(typeTimer); st.drawSeq++; root.remove(); },
    };
  }

  window.FlowDesigner = { create };
})();
