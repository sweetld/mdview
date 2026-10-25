'use strict';

/**
 * Visual editing of a Mermaid diagram on top of its own rendering: click to
 * select, double-click to rename, add, connect, relabel and delete directly
 * on the picture. Mermaid still does the layout. Every change regenerates the
 * Mermaid source, which is what gets saved.
 *
 * This file is the diagram-agnostic core. What a "node" or an "edge" means,
 * how to find them in the SVG, and what the inspector shows come from an
 * adapter per diagram type: FlowAdapter, StateAdapter, SeqAdapter.
 * Exposed as window.FlowDesigner.
 */
(() => {
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

  const esc = (s) => (window.CSS && CSS.escape ? CSS.escape(String(s)) : String(s));

  function adapters() {
    return [window.FlowAdapter, window.StateAdapter, window.SeqAdapter].filter(Boolean);
  }

  async function detect(text) {
    const diagram = await window.MDV.mermaid.mermaidAPI.getDiagramFromText(text);
    const type = diagram.type || '';
    const adapter = adapters().find((a) => a.matches(type));
    if (!adapter) {
      const names = adapters().map((a) => a.name).join(', ');
      const err = new Error(`Visual editing covers ${names}; this is a ${type} diagram. Use Source mode or convert it to a drawing.`);
      err.code = 'NOT_SUPPORTED';
      throw err;
    }
    return adapter;
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
    const zoomLabel = h('button', { type: 'button', class: 'fd-zoom-num', title: 'Reset to 100%', onclick: () => setZoom(1) });
    const zoomBar = h('div', { class: 'fd-zoom' },
      h('button', { type: 'button', class: 'icon-btn sm', title: 'Zoom out', 'aria-label': 'Zoom out', onclick: () => setZoom(zoomValue() / 1.25) },
        svgIcon('M3.5 8h9')),
      zoomLabel,
      h('button', { type: 'button', class: 'icon-btn sm', title: 'Zoom in', 'aria-label': 'Zoom in', onclick: () => setZoom(zoomValue() * 1.25) },
        svgIcon('M8 3.5v9M3.5 8h9')),
      h('button', { type: 'button', class: 'fd-zoom-num', text: 'Fit', title: 'Fit to the canvas', onclick: () => setZoom('fit') }),
    );
    const root = h('div', { class: 'fd-root' }, canvas, zoomBar, inspector);
    parent.append(root);

    const st = {
      adapter: null, model: null, text: '', selection: null, connecting: false,
      history: [], future: [], coalesce: null, drawSeq: 0, inspectorKey: null,
      // Natural size by default: a dense diagram squeezed to fit is unclickable.
      zoom: 1,
    };

    function svgIcon(d) {
      const ns = 'http://www.w3.org/2000/svg';
      const svg = document.createElementNS(ns, 'svg');
      svg.setAttribute('viewBox', '0 0 16 16');
      svg.setAttribute('aria-hidden', 'true');
      const path = document.createElementNS(ns, 'path');
      path.setAttribute('d', d);
      svg.append(path);
      return svg;
    }

    function svgSize() {
      const svg = canvas.querySelector('svg');
      const vb = svg && svg.getAttribute('viewBox');
      if (!vb) return null;
      const [, , w, hgt] = vb.split(/[\s,]+/).map(Number);
      return w > 0 && hgt > 0 ? { svg, w, h: hgt } : null;
    }

    // The scale at which the drawing exactly fills the canvas width.
    function fitScale() {
      const size = svgSize();
      if (!size) return 1;
      const pad = parseFloat(getComputedStyle(canvas).paddingLeft) || 0;
      return Math.min(1, (canvas.clientWidth - pad * 2 - 2) / size.w);
    }

    function zoomValue() {
      return st.zoom === 'fit' ? fitScale() : st.zoom;
    }

    function setZoom(z) {
      st.zoom = z === 'fit' ? 'fit' : Math.min(4, Math.max(0.2, z));
      applyZoom();
    }

    function applyZoom() {
      const size = svgSize();
      if (!size) return;
      const scale = zoomValue();
      size.svg.style.maxWidth = 'none';
      size.svg.style.width = `${Math.round(size.w * scale)}px`;
      size.svg.style.height = 'auto';
      zoomLabel.textContent = `${Math.round(scale * 100)}%`;
    }

    const status = (msg, isError) => { if (onStatus) onStatus(msg, isError); };

    /* ------------------------------------------------------------ loading */

    async function load(text, { silent = false } = {}) {
      const adapter = await detect(text);
      // The picture is always drawn from regenerated source, and Mermaid
      // numbers its DOM ids by definition order — so the model has to come
      // from that same regenerated text or clicks would miss their targets.
      const first = await adapter.parse(text);
      st.adapter = adapter;
      st.model = await adapter.parse(adapter.serialize(first));
      st.text = text;
      if (!silent) { st.history = []; st.future = []; }
      await draw();
    }

    async function draw() {
      const mine = ++st.drawSeq;
      let svg;
      try {
        svg = await renderSvg(st.adapter.serialize(st.model));
      } catch (err) {
        status(err && err.message ? err.message.split('\n')[0] : String(err), true);
        return;
      }
      if (mine !== st.drawSeq) return;
      const keep = { left: canvas.scrollLeft, top: canvas.scrollTop };
      canvas.innerHTML = svg;
      applyZoom();
      canvas.scrollTo(keep);
      st.adapter.bind(canvas, st.model, ctx);
      applySelection();
      // Rebuilding the form while someone is typing in it would steal the
      // caret; the fields already show what was typed.
      const active = document.activeElement;
      const typing = active && active.tagName === 'INPUT' && inspector.contains(active);
      if (!typing || JSON.stringify(st.selection) !== st.inspectorKey) renderInspector();
      status('');
    }

    /* ---------------------------------------------------------- selection */

    function sameSel(a, b) {
      return JSON.stringify(a) === JSON.stringify(b);
    }

    function setSelection(sel) {
      st.selection = sel;
      applySelection();
      renderInspector();
      canvas.focus({ preventScroll: true });
    }

    function applySelection() {
      canvas.querySelectorAll('.fd-selected').forEach((n) => n.classList.remove('fd-selected'));
      if (st.selection && st.adapter) st.adapter.applySelection(canvas, st.model, st.selection);
    }

    // Adapters report clicks here; the core decides whether it is a
    // selection or the second half of a connection.
    function click(sel, e) {
      const from = st.selection;
      const connectable = from && st.adapter.canConnect(from) && st.adapter.canConnect(sel) && !sameSel(from, sel);
      if ((st.connecting || (e && e.shiftKey)) && connectable) {
        st.connecting = false;
        canvas.classList.remove('connecting');
        let next = null;
        commit((m) => { next = st.adapter.connect(m, from, sel); }, { selectAfter: () => next });
        return;
      }
      setSelection(sel);
    }

    function dblclick(sel) {
      st.selection = sel;
      applySelection();
      renderInspector();
      renameInline(sel);
    }

    canvas.addEventListener('click', () => {
      if (st.connecting) { st.connecting = false; canvas.classList.remove('connecting'); renderInspector(); return; }
      setSelection(null);
    });

    canvas.addEventListener('keydown', (e) => {
      if (e.target !== canvas) return;
      if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); deleteSelection(); }
      else if (e.key === 'Escape') { st.connecting = false; canvas.classList.remove('connecting'); setSelection(null); }
      else if (e.key === 'Enter') { if (st.selection) { e.preventDefault(); renameInline(st.selection); } }
    });

    /* ------------------------------------------------------------ editing */

    // Applies a change to the model, regenerates the source, and redraws.
    // Re-parsing the regenerated text keeps ids in step with what Mermaid
    // will put in the SVG. `coalesce` folds a run of keystrokes into one
    // undo step; `selectAfter` picks the selection once ids have settled.
    async function commit(mutate, { select: sel, selectAfter, coalesce = null } = {}) {
      if (!(coalesce && st.coalesce === coalesce)) st.history.push(st.text);
      st.coalesce = coalesce;
      st.future = [];
      if (st.history.length > 100) st.history.shift();
      let text;
      try {
        mutate(st.model);
        text = st.adapter.serialize(st.model);
        st.model = await st.adapter.parse(text);
      } catch (err) {
        status('Could not apply: ' + (err && err.message ? err.message.split('\n')[0] : err), true);
        st.history.pop();
        // The model may be half-changed; rebuild it from the last good text.
        st.model = await st.adapter.parse(st.text);
        return;
      }
      st.text = text;
      onChange(text);
      if (selectAfter) sel = selectAfter();
      if (sel !== undefined) st.selection = sel ? resolve(sel) : null;
      await draw();
    }

    function resolve(sel) {
      return st.adapter.resolveSelection ? st.adapter.resolveSelection(st.model, sel) : sel;
    }

    // Text fields regenerate the diagram once typing pauses, not per key.
    let typeTimer = null;
    function commitTyped(mutate, coalesce) {
      clearTimeout(typeTimer);
      typeTimer = setTimeout(() => commit(mutate, { coalesce }), 350);
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
      const sel = st.selection;
      if (!sel) return;
      commit((m) => st.adapter.remove(m, sel), { select: null });
    }

    function addItem() {
      let next = null;
      commit((m) => { next = st.adapter.add(m, st.selection); }, { selectAfter: () => next })
        .then(() => {
          if (next && st.adapter.labelElement(canvas, st.model, st.selection)) renameInline(st.selection);
        });
    }

    function startConnect() {
      if (!st.selection || !st.adapter.canConnect(st.selection)) {
        status(st.adapter.connectHint || 'Select where the connection starts first');
        return;
      }
      st.connecting = true;
      canvas.classList.add('connecting');
      status('Click the target (Esc to cancel)');
      renderInspector();
    }

    // An input laid over the thing itself, so renaming feels like editing
    // the picture rather than a form.
    function renameInline(sel) {
      const target = st.adapter.labelElement(canvas, st.model, sel);
      if (!target) return;
      const current = st.adapter.label(st.model, sel) || '';
      canvas.querySelectorAll('.fd-inline').forEach((n) => n.remove());
      const box = target.getBoundingClientRect();
      const base = canvas.getBoundingClientRect();
      const input = h('input', { class: 'fd-inline', type: 'text', value: current, spellcheck: 'false' });
      input.style.left = `${box.left - base.left + canvas.scrollLeft}px`;
      input.style.top = `${box.top - base.top + canvas.scrollTop + box.height / 2 - 14}px`;
      input.style.width = `${Math.max(110, box.width)}px`;
      let done = false;
      const finish = (apply) => {
        if (done) return;
        done = true;
        const value = input.value.trim();
        input.remove();
        if (apply && value !== current && (value || st.adapter.allowEmptyLabel)) {
          commit((m) => st.adapter.setLabel(m, sel, value));
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

    function focusField(name) {
      const el = inspector.querySelector(`[data-field="${name}"]`);
      if (el) { el.focus(); if (el.select) el.select(); }
    }

    function renderInspector() {
      inspector.replaceChildren();
      if (!st.model || !st.adapter) return;
      st.inspectorKey = JSON.stringify(st.selection);
      const sel = st.selection;
      const canConnect = !!(sel && st.adapter.canConnect(sel));
      const tools = h('div', { class: 'fd-tools' },
        h('button', { type: 'button', class: 'ghost-btn', text: st.adapter.addLabel(st.model, sel), title: 'Add (attached to the selection, if any)', onclick: addItem }),
        h('button', { type: 'button', class: 'ghost-btn', text: st.connecting ? 'Connecting…' : (st.adapter.connectLabel || 'Connect'), title: 'Connect the selection to another (or Shift+click)', disabled: !canConnect, onclick: startConnect }),
        h('button', { type: 'button', class: 'ghost-btn', text: 'Delete', disabled: !sel, onclick: deleteSelection }),
      );
      inspector.append(tools, ...st.adapter.inspector(st.model, sel, ctx));
    }

    // Everything an adapter may need from the core.
    const ctx = {
      h, field, select, esc, status, commit, commitTyped, askText, focusField,
      click, dblclick, setSelection, selection: () => st.selection,
      connecting: () => st.connecting, startConnect, addItem, deleteSelection, renameInline,
    };

    return {
      root, canvas, load, undo, redo,
      getText: () => st.text,
      isActive: () => root.contains(document.activeElement),
      canUndo: () => st.history.length > 0,
      destroy() { clearTimeout(typeTimer); st.drawSeq++; root.remove(); },
    };
  }

  window.FlowDesigner = { create, h, field, select, esc };
})();
