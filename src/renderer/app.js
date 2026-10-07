'use strict';

const { Marked, DOMPurify, hljs, mermaid } = window.MDV;
const ipc = window.api;  // `api` itself is a non-configurable window property

const $ = (id) => document.getElementById(id);
const el = {
  html: document.documentElement,
  content: $('content'), source: $('source'), sourceCode: $('source').querySelector('code'),
  main: $('main'), welcome: $('welcome'), welcomeRecent: $('welcome-recent'),
  sidebar: $('sidebar'), sidebarTitle: $('sidebar-title'), tree: $('tree'), treeEmpty: $('tree-empty'),
  filter: $('sidebar-filter'), toc: $('toc'), tocList: $('toc-list'), tocEmpty: $('toc-empty'),
  crumb: $('crumb'), statusPath: $('status-path'), statusMeta: $('status-meta'),
  statusDirty: $('status-dirty'), statusCursor: $('status-cursor'),
  find: $('find'), findInput: $('find-input'), findCount: $('find-count'),
  canvas: $('canvas'), sceneHolder: $('scene-holder'), sceneError: $('scene-error'),
  exportStage: $('export-stage'),
  zoomPill: $('zoom-pill'), zoomLevel: $('zoom-level'),
  drop: $('drop-overlay'), toast: $('toast'), help: $('help'),
  body: $('body'), editorPane: $('editor-pane'), editorHost: $('editor-host'),
  splitHandle: $('split-handle'), btnSave: $('btn-save'),
  drawEditor: $('draw-editor'), drawModal: $('draw-modal'), drawModalHost: $('draw-modal-host'),
  drawModalTitle: $('draw-modal-title'),
};

const state = {
  path: null, dir: null, raw: '', root: null, tree: [], kind: 'markdown',
  scene: null, sceneBounds: null, sceneNatural: { width: 0, height: 0 },
  sceneZoom: 1, sceneAutoFit: true, spaceHeld: false, monoDiagrams: false,
  exportAssembled: false,
  theme: 'system', systemDark: false,
  sourceView: false, scrollMemory: new Map(),
  matches: [], matchIndex: -1, renderToken: 0,
  // Editing: `savedRaw` is what is on disk, `raw` what is in the editor.
  editing: false, previewHidden: false, dirty: false, savedRaw: '', untitled: false,
};

/* ================================================================ markdown */

const marked = new Marked({ gfm: true, breaks: false, pedantic: false });

const FRONTMATTER = /^﻿?---\r?\n([\s\S]*?)\r?\n---[ \t]*\r?\n?/;

function splitFrontmatter(md) {
  const m = md.match(FRONTMATTER);
  if (!m) return { meta: null, body: md };
  const meta = [];
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z0-9_.-]+)\s*:\s*(.*)$/);
    if (kv) meta.push([kv[1], kv[2].replace(/^["']|["']$/g, '')]);
    else if (line.trim() && meta.length) meta[meta.length - 1][1] += ' ' + line.trim();
  }
  return { meta: meta.length ? meta : null, body: md.slice(m[0].length) };
}

const SANITIZE = {
  USE_PROFILES: { html: true },
  ADD_ATTR: ['id', 'start', 'align', 'checked', 'disabled', 'type', 'colspan', 'rowspan'],
  FORBID_TAGS: ['style', 'form', 'iframe', 'object', 'embed'],
};

function slugify(text, seen) {
  let base = text.toLowerCase().trim()
    .replace(/[^\w\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '') || 'section';
  let slug = base;
  let n = 1;
  while (seen.has(slug)) slug = `${base}-${n++}`;
  seen.add(slug);
  return slug;
}

function resolveLocal(ref, dir) {
  if (!ref || /^[a-z][a-z0-9+.-]*:/i.test(ref) || ref.startsWith('//') || ref.startsWith('#')) return null;
  const base = 'file://' + dir.split('/').map(encodeURIComponent).join('/') + '/';
  try {
    return new URL(ref, base);
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------- rendering */

// Parses Markdown into a detached node. `seen` carries heading ids across
// calls so a multi-document export cannot collide on anchors; `deferred`
// collects the diagrams that still need drawing.
function buildStage(md, dir, seen, deferred) {
  const { meta, body } = splitFrontmatter(md);
  const clean = DOMPurify.sanitize(marked.parse(body), SANITIZE);

  const stage = document.createElement('div');
  stage.innerHTML = clean;
  if (meta) stage.prepend(frontmatterBlock(meta));

  decorateHeadings(stage, seen);
  decorateLinks(stage, dir);
  decorateImages(stage, dir, deferred);
  decorateTaskLists(stage);
  decorateCode(stage, deferred);
  return { stage, body };
}

async function render(md, { path: filePath, dir }) {
  const token = ++state.renderToken;
  const seen = new Set();
  const deferred = [];
  const { stage, body } = buildStage(md, dir, seen, deferred);

  if (token !== state.renderToken) return;

  // Only the live document gets Edit buttons on its diagrams — an export
  // stage is a snapshot, and the panel would end up in the PDF.
  for (const item of deferred) item.editable = true;

  closeDiagramEditor();
  renderedRaw = md;
  const keep = el.main.scrollTop;
  el.content.replaceChildren(...stage.childNodes);
  // Re-rendering while typing must not make the preview jump.
  if (state.editing) restoreScroll(keep);
  buildToc();
  updateStatus(body);

  // Diagrams are async; the document is already readable while they resolve.
  await renderDeferred(deferred, token);
}

// The source most recently drawn into #content, so leaving edit mode knows
// whether the preview is still a debounce tick behind.
let renderedRaw = null;

function restoreScroll(top) {
  el.main.classList.add('no-smooth');
  el.main.scrollTop = top;
  requestAnimationFrame(() => el.main.classList.remove('no-smooth'));
}

function frontmatterBlock(meta) {
  const details = document.createElement('details');
  details.className = 'frontmatter';
  const summary = document.createElement('summary');
  summary.textContent = 'Front matter';
  const table = document.createElement('table');
  const tbody = document.createElement('tbody');
  for (const [k, v] of meta) {
    const tr = document.createElement('tr');
    const th = document.createElement('th');
    th.textContent = k;
    const td = document.createElement('td');
    td.textContent = v;
    tr.append(th, td);
    tbody.append(tr);
  }
  table.append(tbody);
  details.append(summary, table);
  return details;
}

function decorateHeadings(stage, seen) {
  for (const h of stage.querySelectorAll('h1, h2, h3, h4, h5, h6')) {
    const id = h.id && !seen.has(h.id) ? (seen.add(h.id), h.id) : slugify(h.textContent, seen);
    h.id = id;
    const anchor = document.createElement('a');
    anchor.className = 'anchor';
    anchor.href = '#' + id;
    anchor.textContent = '#';
    anchor.setAttribute('aria-hidden', 'true');
    h.prepend(anchor);
  }
}

function decorateLinks(stage, dir) {
  for (const a of stage.querySelectorAll('a[href]')) {
    const href = a.getAttribute('href');
    if (href.startsWith('#')) {
      a.dataset.kind = 'anchor';
      continue;
    }
    if (/^(https?|mailto):/i.test(href)) {
      a.dataset.kind = 'external';
      a.title = href;
      continue;
    }
    const url = resolveLocal(href, dir);
    if (url) {
      a.dataset.kind = 'local';
      a.dataset.target = decodeURIComponent(url.pathname);
      a.dataset.hash = url.hash;
      a.title = a.dataset.target;
    }
  }
}

function decorateImages(stage, dir, deferred) {
  for (const img of stage.querySelectorAll('img[src]')) {
    const ref = img.getAttribute('src');
    const url = resolveLocal(ref, dir);

    // ![alt](diagram.excalidraw) is a scene reference, not a bitmap.
    if (/\.excalidraw(\.json|\.md)?$/i.test(ref) && url) {
      const wrap = document.createElement('div');
      wrap.className = 'excalidraw-wrap';
      wrap.textContent = 'Loading diagram…';
      img.replaceWith(wrap);
      deferred.push({ kind: 'scene-file', wrap, path: decodeURIComponent(url.pathname) });
      continue;
    }

    if (url) img.src = url.href;
    img.loading = 'lazy';
    img.addEventListener('error', () => {
      img.classList.add('broken');
      if (!img.alt) img.alt = 'missing image: ' + img.getAttribute('src');
    });
  }
}

function decorateTaskLists(stage) {
  for (const box of stage.querySelectorAll('li > input[type="checkbox"]')) {
    box.disabled = true;
    box.parentElement.classList.add('task');
  }
}

function decorateCode(stage, deferred) {
  let mermaidIndex = 0;
  let excalidrawIndex = 0;
  for (const code of stage.querySelectorAll('pre > code')) {
    const pre = code.parentElement;
    const lang = (code.className.match(/language-([\w+#-]+)/) || [])[1] || '';
    // marked leaves the fence's trailing newline off; keep the text as the
    // author wrote it so an edit round-trips cleanly.
    const text = code.textContent.replace(/\n$/, '');

    if (lang === 'mermaid' || lang === 'excalidraw') {
      const wrap = document.createElement('div');
      wrap.className = lang === 'mermaid' ? 'mermaid-wrap' : 'excalidraw-wrap';
      wrap.textContent = 'Rendering diagram…';
      pre.replaceWith(wrap);
      // The ordinal lets an edited diagram be written back to its own fence.
      const index = lang === 'mermaid' ? mermaidIndex++ : excalidrawIndex++;
      deferred.push({ kind: lang === 'mermaid' ? 'mermaid' : 'scene-inline', wrap, text, index });
      continue;
    }

    code.classList.add('hljs');
    try {
      const result = lang && hljs.getLanguage(lang)
        ? hljs.highlight(text, { language: lang, ignoreIllegals: true })
        : hljs.highlightAuto(text, ['javascript', 'typescript', 'python', 'bash', 'json', 'yaml', 'sql', 'go', 'java', 'xml', 'css']);
      code.innerHTML = DOMPurify.sanitize(result.value, SANITIZE);
    } catch {
      /* unhighlighted code is still perfectly readable */
    }

    const btn = document.createElement('button');
    btn.className = 'copy-btn';
    btn.type = 'button';
    btn.textContent = 'Copy';
    btn.addEventListener('click', () => {
      ipc.writeClipboard(text);
      btn.textContent = 'Copied';
      setTimeout(() => { btn.textContent = 'Copy'; }, 1200);
    });
    pre.append(btn);
  }
}

let mermaidSeq = 0;

async function renderDeferred(items, token) {
  if (!items.length) return;
  const mermaids = items.filter((i) => i.kind === 'mermaid');
  const scenes = items.filter((i) => i.kind !== 'mermaid');
  await renderDiagrams(mermaids, token);
  await renderEmbeddedScenes(scenes, token);
}

// Rendered diagrams are cached by their source so the live preview does not
// redraw every diagram on every keystroke. Keyed on theme and font too, since
// both change the output.
const CACHE_MAX = 80;
const mermaidCache = new Map();
const sceneCache = new Map();

function cachePut(map, key, value) {
  if (map.size >= CACHE_MAX) map.delete(map.keys().next().value);
  map.set(key, value);
  return value;
}

function clearDiagramCaches() {
  mermaidCache.clear();
  sceneCache.clear();
}

// Diagrams embedded in Markdown, either an inline ```excalidraw block or a
// reference to a scene file sitting next to the document.
async function renderEmbeddedScenes(items, token) {
  for (const item of items) {
    if (token !== state.renderToken) return;
    try {
      const cacheKey = `${item.kind}|${isDark()}|${state.monoDiagrams}|${item.path || item.text}`;
      let drawn = sceneCache.get(cacheKey);
      if (!drawn) {
        let text = item.text;
        let kind = 'excalidraw';
        if (item.kind === 'scene-file') {
          const res = await ipc.readFile(item.path);
          if (!res.ok) throw new Error(res.error);
          text = res.content;
          kind = /\.excalidraw\.md$/i.test(item.path) ? 'excalidraw-md' : 'excalidraw';
        }
        const scene = SceneView.parse(text, { kind, mono: state.monoDiagrams });
        drawn = cachePut(sceneCache, cacheKey, await SceneView.toSvg(scene, { dark: isDark() }));
      }
      if (token !== state.renderToken) return;
      const svg = drawn.svg.cloneNode(true);
      // Draw at natural size, shrinking only when the column is narrower —
      // a small sketch should not be blown up to the full text width.
      if (drawn.width) svg.style.width = `${drawn.width}px`;
      item.wrap.replaceChildren(svg);
      if (item.editable) attachSceneTools(item);
    } catch (err) {
      item.wrap.textContent = '';
      const msg = document.createElement('div');
      msg.className = 'excalidraw-error';
      msg.textContent = 'Excalidraw: ' + (err && err.message ? err.message : String(err));
      item.wrap.append(msg);
    }
  }
}

let mermaidTheme = null;

function initMermaid() {
  const theme = isDark() ? 'dark' : 'default';
  if (theme === mermaidTheme) return;
  mermaidTheme = theme;
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: 'strict',
    theme,
    fontFamily: 'system-ui, sans-serif',
    // Plain SVG <text> labels survive sanitising and print cleanly.
    htmlLabels: false,
    flowchart: { htmlLabels: false, useMaxWidth: true },
    class: { htmlLabels: false },
  });
}

// Renders Mermaid source to sanitised SVG markup, throwing on a parse error.
async function mermaidSvg(text) {
  const key = `${isDark()}|${text}`;
  const hit = mermaidCache.get(key);
  if (hit) return hit;
  initMermaid();
  try {
    const { svg } = await mermaid.render(`mmd-${++mermaidSeq}`, text);
    return cachePut(mermaidCache, key, DOMPurify.sanitize(svg, {
      USE_PROFILES: { svg: true, svgFilters: true, html: true },
      ADD_TAGS: ['foreignObject'],
      ADD_ATTR: ['dominant-baseline', 'transform', 'marker-end', 'marker-start', 'xmlns:xlink'],
    }));
  } catch (err) {
    // A failed render leaves its scratch element behind in the body.
    document.querySelectorAll('[id^="dmmd-"], [id^="mmd-"]').forEach((n) => {
      if (n.tagName === 'DIV' && !n.closest('.mermaid-wrap, .de-preview')) n.remove();
    });
    throw err;
  }
}

function firstLine(err) {
  return err && err.message ? err.message.split('\n')[0] : String(err);
}

async function renderDiagrams(diagrams, token) {
  if (!diagrams.length) return;
  for (const item of diagrams) {
    const { wrap, text } = item;
    if (token !== state.renderToken) return;
    try {
      const svg = await mermaidSvg(text);
      if (token !== state.renderToken) return;
      wrap.innerHTML = svg;
    } catch (err) {
      wrap.textContent = '';
      const msg = document.createElement('div');
      msg.className = 'mermaid-error';
      msg.textContent = 'Diagram error: ' + firstLine(err);
      const src = document.createElement('pre');
      src.textContent = text;
      wrap.append(msg, src);
    }
    // A broken diagram needs the Edit button most of all.
    if (item.editable) attachDiagramTools(wrap, text, item.index);
  }
}

/* ======================================================= diagram editing */

function attachDiagramTools(wrap, text, index) {
  const tools = document.createElement('div');
  tools.className = 'diagram-tools';
  const edit = document.createElement('button');
  edit.type = 'button';
  edit.textContent = 'Edit';
  edit.title = 'Edit this diagram';
  edit.addEventListener('click', () => openDiagramEditor(wrap, text, index));
  const copy = document.createElement('button');
  copy.type = 'button';
  copy.textContent = 'Copy';
  copy.title = 'Copy the diagram source';
  copy.addEventListener('click', () => {
    ipc.writeClipboard(text);
    copy.textContent = 'Copied';
    setTimeout(() => { copy.textContent = 'Copy'; }, 1200);
  });
  tools.append(edit, copy);
  wrap.append(tools);
}

let diagramPanel = null;

function button(className, label, onClick, title) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = className;
  btn.textContent = label;
  if (title) btn.title = title;
  if (onClick) btn.addEventListener('click', onClick);
  return btn;
}

// Opens an inline editor in place of the diagram. Source mode shows the text
// beside a live re-render; Visual mode edits the flowchart on the picture
// itself. Apply writes the text back into the fence it came from; nothing
// touches the document until then.
function openDiagramEditor(wrap, text, index) {
  closeDiagramEditor();
  wrap.classList.add('editing');

  const panel = document.createElement('div');
  panel.className = 'diagram-editor';
  const source = document.createElement('div');
  source.className = 'de-source';
  const preview = document.createElement('div');
  preview.className = 'de-preview';
  const bar = document.createElement('div');
  bar.className = 'de-bar';
  const mode = document.createElement('div');
  mode.className = 'de-mode';
  const modeSource = button('on', 'Source', () => setMode('source'));
  const modeVisual = button('', 'Visual', () => setMode('visual'), 'Edit the flowchart on the picture');
  mode.append(modeSource, modeVisual);
  const status = document.createElement('span');
  status.className = 'de-status';
  const convert = button('ghost-btn', 'To drawing…', () => convertToDrawing(),
    'Turn this diagram into a free-form Excalidraw drawing');
  const cancel = button('ghost-btn', 'Cancel', () => doCancel());
  const apply = button('primary-btn', 'Apply', () => doApply(), 'Apply (Ctrl+Enter)');
  bar.append(mode, status, convert, cancel, apply);
  panel.append(source, preview, bar);
  wrap.append(panel);

  let timer = null;
  let seq = 0;
  let designer = null;
  let suppress = false;
  const setStatus = (msg, isError) => {
    status.textContent = msg;
    status.classList.toggle('error', !!isError);
  };
  const refresh = async () => {
    const mine = ++seq;
    const src = ed.getValue();
    preview.classList.add('stale');
    try {
      const svg = await mermaidSvg(src);
      if (mine !== seq) return;
      preview.innerHTML = svg;
      if (!designer || !panel.classList.contains('visual')) {
        setStatus(src === text ? 'Unchanged' : 'Ctrl+Enter to apply');
      }
      apply.disabled = false;
    } catch (err) {
      if (mine !== seq) return;
      setStatus(firstLine(err), true);
      apply.disabled = true;
      // The last good drawing stays up, dimmed, until the source parses again.
      return;
    }
    if (mine === seq) preview.classList.remove('stale');
  };
  const schedule = () => {
    clearTimeout(timer);
    timer = setTimeout(refresh, 250);
  };
  const doApply = () => {
    if (apply.disabled) return true;
    applyDiagramEdit(index, ed.getValue(), text);
    return true;
  };
  const doCancel = () => { closeDiagramEditor(); return true; };

  const ed = MdEditor.create({
    parent: source,
    doc: text,
    lang: 'plain',
    hint: 'Mermaid diagram source',
    onChange: () => { if (!suppress) schedule(); },
    keys: [{ key: 'Mod-Enter', run: doApply }, { key: 'Escape', run: doCancel }],
  });

  async function setMode(next) {
    if (next === 'visual') {
      if (!designer) {
        designer = FlowDesigner.create({
          parent: panel,
          renderSvg: mermaidSvg,
          onStatus: setStatus,
          onChange: (t) => {
            suppress = true;
            ed.setValue(t);
            suppress = false;
            apply.disabled = false;
            setStatus(t === text ? 'Unchanged' : 'Ctrl+Enter to apply');
          },
        });
      }
      try {
        await designer.load(ed.getValue());
      } catch (err) {
        setStatus(err.code === 'NOT_FLOWCHART'
          ? 'Visual editing works on flowcharts; this is a different diagram type'
          : firstLine(err), true);
        return;
      }
      panel.classList.add('visual');
      modeVisual.classList.add('on');
      modeSource.classList.remove('on');
      designer.canvas.focus({ preventScroll: true });
    } else {
      panel.classList.remove('visual');
      modeSource.classList.add('on');
      modeVisual.classList.remove('on');
      refresh();
      ed.focus();
    }
  }

  async function convertToDrawing() {
    const src = ed.getValue();
    setStatus('Converting…');
    let scene;
    try {
      scene = await DrawEditor.fromMermaid(src);
    } catch (err) {
      setStatus('Could not convert: ' + firstLine(err), true);
      return;
    } finally {
      // The converter re-initialises Mermaid with its own settings.
      mermaidTheme = null;
    }
    closeDiagramEditor();
    openDrawOverlay({
      title: 'Convert diagram to drawing',
      scene,
      onApply: (json) => replaceFenceWithDrawing('mermaid', index, text, json),
    });
  }

  diagramPanel = {
    designer: () => designer,
    destroy() {
      clearTimeout(timer);
      seq++;
      if (designer) designer.destroy();
      ed.destroy();
      panel.remove();
      wrap.classList.remove('editing');
    },
  };
  refresh();
  ed.focus();
}

// Swaps a ```mermaid fence for a ```excalidraw one holding the drawing.
function replaceFenceWithDrawing(lang, index, original, json) {
  const span = locateFence(state.raw, lang, index);
  if (!span || span.body !== original) {
    toast('Could not find this diagram in the source — it may have moved');
    return;
  }
  const insert = 'excalidraw' + state.raw.slice(span.langTo, span.from) + span.lead + json + span.tail;
  applySourceChange(span.langFrom, span.to, insert);
}

/* ======================================================== scene editing */

// Edit buttons on drawings embedded in Markdown: inline ```excalidraw blocks
// and ![](file.excalidraw) references.
function attachSceneTools(item) {
  const tools = document.createElement('div');
  tools.className = 'diagram-tools';
  const edit = button('', 'Edit', () => editEmbeddedScene(item), 'Edit this drawing');
  tools.append(edit);
  item.wrap.append(tools);
}

async function editEmbeddedScene(item) {
  let text = item.text;
  let kind = 'excalidraw';
  if (item.kind === 'scene-file') {
    const res = await ipc.readFile(item.path);
    if (!res.ok) { toast('Could not read ' + item.path); return; }
    text = res.content;
    kind = /\.excalidraw\.md$/i.test(item.path) ? 'excalidraw-md' : 'excalidraw';
  }
  let scene;
  try {
    scene = SceneView.parse(text, { kind, mono: false });
  } catch (err) {
    toast('Could not open the drawing: ' + firstLine(err));
    return;
  }
  const name = item.kind === 'scene-file' ? item.path.split('/').pop() : 'embedded drawing';
  openDrawOverlay({
    title: `Edit ${name}`,
    scene,
    onApply: async (json) => {
      if (item.kind === 'scene-file') {
        const out = kind === 'excalidraw-md' ? SceneView.replaceDrawing(text, json) : json;
        const res = await ipc.saveFile(item.path, out);
        if (!res.ok) { toast('Could not save: ' + res.error); return; }
        clearDiagramCaches();
        const keep = el.main.scrollTop;
        rerender().then(() => restoreScroll(keep));
        toast(`Saved ${name}`);
        return;
      }
      const span = locateFence(state.raw, 'excalidraw', item.index);
      if (!span || span.body !== item.text) {
        toast('Could not find this drawing in the source — it may have moved');
        return;
      }
      applySourceChange(span.from, span.to, span.lead + json + span.tail);
    },
  });
}

let overlayEditor = null;

// A full-window Excalidraw session for a drawing that lives inside a
// document. Apply hands the serialised scene back; Cancel throws it away.
function openDrawOverlay({ title, scene, onApply }) {
  closeDrawOverlay();
  el.drawModalTitle.textContent = title;
  el.drawModal.hidden = false;
  overlayEditor = DrawEditor.mount(el.drawModalHost, { scene, dark: isDark() });
  overlayEditor.onApply = onApply;
  ipc.setEditing('draw');
  setTimeout(() => overlayEditor && overlayEditor.focus(), 50);
}

function closeDrawOverlay() {
  if (!overlayEditor) return;
  overlayEditor.destroy();
  overlayEditor = null;
  el.drawModal.hidden = true;
  ipc.setEditing(sceneEditor ? 'draw' : (state.editing ? 'text' : false));
}

$('draw-modal-apply').addEventListener('click', async () => {
  if (!overlayEditor) return;
  const json = overlayEditor.toJSON();
  const apply = overlayEditor.onApply;
  closeDrawOverlay();
  await apply(json);
});
$('draw-modal-cancel').addEventListener('click', () => {
  if (overlayEditor && overlayEditor.isDirty() && !window.confirm('Discard the changes to this drawing?')) return;
  closeDrawOverlay();
});

// Editing a drawing file (.excalidraw or an Obsidian .excalidraw.md) in
// place of the read-only canvas.
let sceneEditor = null;

function mountSceneEditor() {
  if (sceneEditor) return;
  let scene;
  try {
    scene = SceneView.parse(state.raw, { kind: state.kind, mono: false });
  } catch (err) {
    if (err.code === 'NO_DRAWING') scene = { elements: [], appState: {}, files: {} };
    else { toast('Cannot edit: ' + firstLine(err)); return; }
  }
  sceneEditor = DrawEditor.mount(el.drawEditor, {
    scene,
    dark: isDark(),
    onChange: (changed) => setDirty(changed || state.raw !== state.savedRaw),
  });
  ipc.setEditing('draw');
  setTimeout(() => sceneEditor && sceneEditor.focus(), 50);
}

function unmountSceneEditor() {
  if (!sceneEditor) return;
  sceneEditor.destroy();
  sceneEditor = null;
}

// The document text catches up with the canvas: before a save, an export,
// or leaving edit mode.
function sceneToText() {
  const json = sceneEditor.toJSON();
  return state.kind === 'excalidraw-md' ? SceneView.replaceDrawing(state.raw, json) : json;
}

function syncSceneRaw() {
  if (!sceneEditor || !sceneEditor.isDirty()) return;
  state.raw = sceneToText();
  sceneEditor.markClean();
  setDirty(state.raw !== state.savedRaw);
}

function closeDiagramEditor() {
  if (!diagramPanel) return;
  const panel = diagramPanel;
  diagramPanel = null;
  panel.destroy();
}

function applyDiagramEdit(index, text, original) {
  const span = locateFence(state.raw, 'mermaid', index);
  if (!span || span.body !== original) {
    toast('Could not find this diagram in the source — it may have moved');
    return;
  }
  closeDiagramEditor();
  if (text === original) return;
  const body = text.split('\n').map((line) => (line ? span.prefix + line : line)).join('\n');
  applySourceChange(span.from, span.to, span.lead + body + span.tail);
}

// Finds the nth fenced block with the given language. Returns the character
// span of its contents, and the indentation or quote prefix each line carries
// so replacement text can be written back in the same shape.
function locateFence(raw, lang, nth) {
  const lines = raw.split('\n');
  let offset = 0;
  let count = 0;
  let open = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!open) {
      const m = line.match(/^([ \t>]*)(`{3,}|~{3,})([ \t]*)([\w+#-]*)/);
      if (m) {
        const langFrom = offset + m[1].length + m[2].length + m[3].length;
        open = {
          i, at: offset, prefix: m[1], fence: m[2], lang: m[4].toLowerCase(),
          langFrom, langTo: langFrom + m[4].length, bodyAt: offset + line.length + 1,
        };
      }
    } else {
      const m = line.match(/^[ \t>]*(`{3,}|~{3,})[ \t]*\r?$/);
      if (m && m[1][0] === open.fence[0] && m[1].length >= open.fence.length) {
        if (open.lang === lang) {
          if (count === nth) return fenceSpan(raw, open, offset);
          count++;
        }
        open = null;
      }
    }
    offset += line.length + 1;
  }
  // An unterminated fence runs to the end of the document.
  if (open && open.lang === lang && count === nth) return fenceSpan(raw, open, raw.length + 1);
  return null;
}

function fenceSpan(raw, open, closeAt) {
  const unterminated = closeAt > raw.length;
  const from = Math.min(open.bodyAt, raw.length);
  // `closeAt` is the offset of the closing fence line; the body ends just
  // before the newline that precedes it. An empty block has no such newline.
  const to = unterminated ? raw.length : Math.max(from, closeAt - 1);
  const body = raw.slice(from, to).replace(/\r/g, '').split('\n')
    .map((l) => (l.startsWith(open.prefix) ? l.slice(open.prefix.length) : l.replace(/^[ \t>]*/, '')))
    .join('\n');
  return {
    from, to, prefix: open.prefix, body,
    // Where the language word sits on the opening line, for retagging.
    langFrom: open.langFrom, langTo: open.langTo,
    // Newlines the replacement has to supply itself: after an opening fence
    // that ends the file, and before a closing fence that follows directly.
    lead: open.bodyAt > raw.length ? '\n' : '',
    tail: !unterminated && closeAt <= open.bodyAt ? '\n' : '',
  };
}

// Routes a programmatic change through the editor when one is open, so it
// lands in the undo history; otherwise the document is updated directly.
function applySourceChange(from, to, insert) {
  if (state.editing && editor) {
    editor.replaceRange(from, to, insert);
    return;
  }
  state.raw = state.raw.slice(0, from) + insert + state.raw.slice(to);
  setDirty(state.raw !== state.savedRaw);
  const keep = el.main.scrollTop;
  rerender().then(() => restoreScroll(keep));
}

/* =================================================================== TOC */

function buildToc() {
  const headings = [...el.content.querySelectorAll('h1, h2, h3, h4, h5, h6')];
  el.tocList.replaceChildren();
  el.tocEmpty.hidden = headings.length > 0;
  el.tocEmpty.textContent = 'No headings.';
  for (const h of headings) {
    const a = document.createElement('a');
    a.href = '#' + h.id;
    a.className = h.tagName.toLowerCase();
    a.textContent = h.textContent.replace(/^#/, '').trim();
    a.title = a.textContent;
    a.addEventListener('click', (e) => { e.preventDefault(); scrollToId(h.id); });
    el.tocList.append(a);
  }
  observeHeadings(headings);
}

let tocObserver = null;

function observeHeadings(headings) {
  tocObserver?.disconnect();
  if (!headings.length) return;
  const visible = new Set();
  tocObserver = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (entry.isIntersecting) visible.add(entry.target.id);
      else visible.delete(entry.target.id);
    }
    const first = headings.find((h) => visible.has(h.id));
    highlightToc(first ? first.id : null);
  }, { root: el.main, rootMargin: '0px 0px -72% 0px', threshold: 0 });
  headings.forEach((h) => tocObserver.observe(h));
}

function highlightToc(id) {
  for (const a of el.tocList.children) {
    const on = a.getAttribute('href') === '#' + id;
    a.classList.toggle('active', on);
    if (on) a.scrollIntoView({ block: 'nearest' });
  }
}

function scrollToId(id) {
  const target = document.getElementById(id);
  if (!target) return;
  target.scrollIntoView({ block: 'start', behavior: 'smooth' });
  highlightToc(id);
}

/* ============================================================== file tree */

function renderTree(nodes, container, depth = 0) {
  for (const node of nodes) {
    if (node.type === 'dir') {
      const row = document.createElement('div');
      row.className = 'row';
      row.innerHTML = '<svg class="caret" viewBox="0 0 16 16"><path d="M5 3l5 5-5 5"/></svg>';
      const label = document.createElement('span');
      label.textContent = node.name;
      row.append(label);
      row.title = node.path;

      const children = document.createElement('div');
      children.className = 'children';
      renderTree(node.children, children, depth + 1);
      if (depth > 0) { children.hidden = true; row.classList.add('collapsed'); }

      row.addEventListener('click', () => {
        children.hidden = !children.hidden;
        row.classList.toggle('collapsed', children.hidden);
      });
      container.append(row, children);
    } else {
      const row = document.createElement('div');
      row.className = 'row file';
      row.dataset.path = node.path;
      row.title = node.path;
      row.innerHTML = '<svg viewBox="0 0 16 16"><path d="M9 1.5H4.5v13h7V4z"/><path d="M9 1.5V4h2.5"/></svg>';
      const label = document.createElement('span');
      label.textContent = node.name;
      row.append(label);
      row.addEventListener('click', () => ipc.openPath(node.path));
      container.append(row);
    }
  }
}

function markCurrentInTree() {
  for (const row of el.tree.querySelectorAll('.row.file')) {
    const on = row.dataset.path === state.path;
    row.classList.toggle('current', on);
    if (on) row.scrollIntoView({ block: 'nearest' });
  }
}

function applyFilter(term) {
  const needle = term.trim().toLowerCase();
  for (const row of el.tree.querySelectorAll('.row.file')) {
    row.hidden = needle ? !row.textContent.toLowerCase().includes(needle) : false;
  }
  for (const group of el.tree.querySelectorAll('.children')) {
    if (!needle) continue;
    const anyVisible = [...group.querySelectorAll('.row.file')].some((r) => !r.hidden);
    group.hidden = !anyVisible;
    group.previousElementSibling?.classList.toggle('collapsed', !anyVisible);
  }
}

/* ============================================================ find in doc */

const FIND_HL = 'mdv-find';
const FIND_ACTIVE = 'mdv-find-active';
const highlightsSupported = typeof CSS !== 'undefined' && CSS.highlights;

function clearFind() {
  if (highlightsSupported) { CSS.highlights.delete(FIND_HL); CSS.highlights.delete(FIND_ACTIVE); }
  state.matches = [];
  state.matchIndex = -1;
  el.findCount.textContent = '0/0';
}

function runFind(term) {
  clearFind();
  if (!term || !highlightsSupported) return;
  const scope = state.sourceView ? el.source
    : SCENE_KINDS.has(state.kind) ? el.canvas : el.content;
  const needle = term.toLowerCase();
  const walker = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT);
  const ranges = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node.nodeValue.toLowerCase();
    let at = text.indexOf(needle);
    while (at !== -1) {
      const range = new Range();
      range.setStart(node, at);
      range.setEnd(node, at + needle.length);
      ranges.push(range);
      at = text.indexOf(needle, at + needle.length);
    }
  }
  state.matches = ranges;
  if (!ranges.length) { el.findCount.textContent = '0/0'; return; }
  CSS.highlights.set(FIND_HL, new Highlight(...ranges));
  gotoMatch(0);
}

function gotoMatch(index) {
  if (!state.matches.length) return;
  const count = state.matches.length;
  state.matchIndex = ((index % count) + count) % count;
  const range = state.matches[state.matchIndex];
  CSS.highlights.set(FIND_ACTIVE, new Highlight(range));
  el.findCount.textContent = `${state.matchIndex + 1}/${count}`;
  const rect = range.getBoundingClientRect();
  const mainRect = el.main.getBoundingClientRect();
  if (rect.top < mainRect.top + 40 || rect.bottom > mainRect.bottom - 40) {
    el.main.scrollTop += rect.top - mainRect.top - el.main.clientHeight / 3;
  }
}

function openFind() {
  el.find.hidden = false;
  el.findInput.focus();
  el.findInput.select();
  if (el.findInput.value) runFind(el.findInput.value);
}

function closeFind() {
  el.find.hidden = true;
  clearFind();
  el.main.focus();
}

/* ================================================================== theme */

function isDark() {
  return el.html.dataset.theme === 'dark';
}

function applyTheme(theme, systemDark) {
  state.theme = theme ?? state.theme;
  if (systemDark !== undefined) state.systemDark = systemDark;
  const dark = state.theme === 'dark' || (state.theme === 'system' && state.systemDark);
  el.html.dataset.theme = dark ? 'dark' : 'light';
  rerender();
}

// Redraw the current document in place, whichever kind it is. Markdown goes
// back through the full pipeline so embedded diagrams pick the change up too.
function rerender() {
  if (sceneEditor) sceneEditor.setTheme(isDark());
  if (overlayEditor) overlayEditor.setTheme(isDark());
  if (!state.raw && !state.untitled) return Promise.resolve();
  return SCENE_KINDS.has(state.kind)
    ? renderScene(state.raw, state.kind)
    : render(state.raw, { path: state.path, dir: state.dir });
}

/* =============================================================== exports */

let exportSaved = null;

// Documents are printed onto white paper, so exports always render light and
// from the rendered view — never the raw source — then put things back.
window.__exportPrepare = async () => {
  exportSaved = {
    theme: state.theme,
    systemDark: state.systemDark,
    sourceView: state.sourceView,
    editing: state.editing,
  };
  state.theme = 'light';
  state.systemDark = false;
  state.sourceView = false;
  // The editor pane would otherwise print alongside the document; a drawing
  // being edited exports as it currently looks on the canvas.
  syncSceneRaw();
  state.editing = false;
  el.html.dataset.theme = 'light';
  applyView();
  await rerender();
};

// Builds the document to export into the main view: one file, or every file
// in the folder, preceded by a table of contents. Both formats consume the
// same assembled DOM, so a PDF and a .docx always carry identical content.
window.__exportAssemble = async (paths) => {
  // An untitled document has no path yet; export whatever is in the editor.
  const list = (paths && paths.length) ? paths : [state.path || ''];
  const token = ++state.renderToken;
  const seen = new Set();
  const holder = document.createElement('div');
  const multi = list.length > 1;

  for (let i = 0; i < list.length; i++) {
    const filePath = list[i];
    // The open document exports as it is on screen, unsaved edits included.
    const current = !filePath || filePath === state.path;
    const res = current ? { ok: true, content: state.raw } : await ipc.readFile(filePath);
    if (!res.ok) continue;

    const section = document.createElement('section');
    if (holder.childElementCount) holder.append(window.DocExport.pageBreak());

    let drawn = false;
    const kind = exportKindOf(filePath);
    if (kind !== 'markdown') {
      const figure = await sceneFigure(res.content, kind);
      // A .excalidraw.md with no drawing in it is just Markdown — same
      // fallback the viewer makes when you open one.
      if (figure) {
        section.append(headingFor(filePath, seen), figure);
        drawn = true;
      }
    }
    if (!drawn) {
      const deferred = [];
      const { stage } = buildStage(res.content, dirNameOf(filePath), seen, deferred);
      // Diagrams are measured during export, so the stage has to be laid out.
      el.exportStage.replaceChildren(stage);
      await renderDeferred(deferred, token);
      if (multi) titleSection(stage, filePath, seen);
      section.append(...stage.childNodes);
    }
    holder.append(section);
  }

  el.exportStage.replaceChildren();

  // Diagrams are sized to the page before the TOC is built, so the headings
  // it points at have settled where they will actually print.
  window.DocExport.fitDiagrams(holder);

  const toc = window.DocExport.buildToc(holder);
  state.exportAssembled = true;
  el.content.replaceChildren(...(toc ? [toc] : []), ...holder.childNodes);
  el.content.hidden = false;
  el.canvas.hidden = true;
  el.source.hidden = true;
  return list.length;
};

function dirNameOf(p) { return p.slice(0, p.lastIndexOf('/')) || '/'; }

function exportKindOf(p) {
  const lower = p.toLowerCase();
  if (lower.endsWith('.excalidraw.md')) return 'excalidraw-md';
  if (lower.endsWith('.excalidraw') || lower.endsWith('.excalidraw.json')) return 'excalidraw';
  return 'markdown';
}

// A file that already opens with a title names itself; anything else gets one.
function titleSection(stage, filePath, seen) {
  const first = stage.firstElementChild;
  if (first && first.tagName === 'H1') return;
  stage.prepend(headingFor(filePath, seen));
}

function headingFor(filePath, seen) {
  // Strip compound extensions too, so "notes.excalidraw.md" reads as "notes".
  const name = filePath.split('/').pop()
    .replace(/\.(md|markdown|mdown|mkd|mdx|txt|json)$/i, '')
    .replace(/\.excalidraw$/i, '');
  const h = document.createElement('h1');
  h.id = slugify(name, seen);
  h.textContent = name;
  return h;
}

// Returns null when the file turns out not to hold a drawing at all, so the
// caller can fall back to rendering it as Markdown.
async function sceneFigure(text, kind) {
  let scene;
  try {
    scene = SceneView.parse(text, { kind, mono: state.monoDiagrams });
  } catch (err) {
    if (err.code === 'NO_DRAWING') return null;
    return errorFigure(err.message);
  }

  const wrap = document.createElement('div');
  wrap.className = 'excalidraw-wrap';
  try {
    const { svg, width } = await SceneView.toSvg(scene, { dark: false });
    if (width) svg.style.width = `${width}px`;
    wrap.append(svg);
  } catch (err) {
    return errorFigure(err.message);
  }
  return wrap;
}

function errorFigure(message) {
  const wrap = document.createElement('div');
  const msg = document.createElement('p');
  msg.textContent = `[drawing could not be exported: ${message}]`;
  wrap.append(msg);
  return wrap;
}

window.__exportHtml = async () => {
  if (state.exportAssembled) {
    return window.DocExport.buildHtml({ root: el.content, title: null });
  }
  const isScene = SCENE_KINDS.has(state.kind);
  const root = isScene ? el.sceneHolder : el.content;
  // A drawing carries no title of its own; a Markdown file usually opens with one.
  const title = isScene && state.path ? state.path.split('/').pop() : null;
  return window.DocExport.buildHtml({ root, title });
};

window.__exportRestore = async () => {
  if (!exportSaved) return;
  const saved = exportSaved;
  exportSaved = null;
  state.sourceView = saved.sourceView;
  state.editing = saved.editing;
  state.exportAssembled = false;
  applyView();
  applyTheme(saved.theme, saved.systemDark);
  await rerender();
};

/* ================================================================== misc */

const HOME = /^\/home\/[^/]+/;

// Paths are long; keep the tail, which is the part that identifies the file.
function shortPath(p, segments = 3) {
  const tilde = p.replace(HOME, '~');
  const parts = tilde.split('/').filter(Boolean);
  if (parts.length <= segments) return tilde;
  return '…/' + parts.slice(-segments).join('/');
}

let printWasReading = false;
let toastTimer = null;

function toast(message) {
  el.toast.textContent = message;
  el.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.toast.hidden = true; }, 2600);
}

function updateStatus(body) {
  const words = (body.match(/[A-Za-z0-9'’À-ɏ]+/g) || []).length;
  const minutes = Math.max(1, Math.round(words / 220));
  const lines = body.split('\n').length;
  el.statusMeta.textContent = `${words.toLocaleString()} words · ${lines.toLocaleString()} lines · ~${minutes} min read`;
}

/* ============================================================ scene view */

const SCENE_KINDS = new Set(['excalidraw', 'excalidraw-md']);

async function renderScene(text, kind) {
  const token = ++state.renderToken;
  el.sceneError.hidden = true;
  el.sceneHolder.replaceChildren();

  let scene;
  try {
    scene = SceneView.parse(text, { kind, mono: state.monoDiagrams });
  } catch (err) {
    // A .excalidraw.md with no drawing in it is just a Markdown file.
    if (err.code === 'NO_DRAWING') {
      state.kind = 'markdown';
      applyView();
      return render(text, { path: state.path, dir: state.dir });
    }
    showSceneError('This file could not be read as an Excalidraw scene', err.message);
    return;
  }

  state.scene = scene;
  state.sceneBounds = SceneView.bounds(scene.elements);
  buildSceneOutline(scene);
  updateSceneStatus(scene);

  if (!scene.elements.length) {
    showSceneError('Empty scene', 'This drawing has no elements.');
    return;
  }

  try {
    const { svg, width, height } = await SceneView.toSvg(scene, { dark: isDark() });
    if (token !== state.renderToken) return;
    state.sceneNatural = { width, height };
    el.sceneHolder.replaceChildren(svg);
    fitScene();
    applyView();
  } catch (err) {
    showSceneError('The diagram could not be drawn', err.message);
  }
}

function showSceneError(title, detail) {
  el.sceneHolder.replaceChildren();
  el.sceneError.replaceChildren();
  const h = document.createElement('h2');
  h.textContent = title;
  const p = document.createElement('p');
  p.textContent = detail || '';
  el.sceneError.append(h, p);
  el.sceneError.hidden = false;
  el.zoomPill.hidden = true;
  updateSceneStatusEmpty();
}

function updateSceneStatusEmpty() {
  if (!state.scene) el.statusMeta.textContent = '';
}

function updateSceneStatus(scene) {
  const { count, width, height, breakdown } = SceneView.stats(scene);
  const top = breakdown.slice(0, 3).map(([type, n]) => `${n} ${type}`).join(', ');
  el.statusMeta.textContent =
    `${count} element${count === 1 ? '' : 's'} · ${width}×${height}${top ? ' · ' + top : ''}`;
}

/* ------------------------------------------------------------ scene zoom */

function sceneViewportWidth() {
  const pad = getComputedStyle(el.canvas);
  return el.main.clientWidth - parseFloat(pad.paddingLeft) - parseFloat(pad.paddingRight) - 2;
}

function fitScene() {
  const natural = state.sceneNatural.width;
  if (!natural) return;
  state.sceneAutoFit = true;
  // Shrink a large diagram to fit, but never blow a small one up.
  setSceneZoom(Math.min(1, sceneViewportWidth() / natural));
}

function setSceneZoom(zoom) {
  const clamped = Math.min(8, Math.max(0.05, zoom));
  state.sceneZoom = clamped;
  if (state.sceneNatural.width) {
    el.sceneHolder.style.width = `${Math.round(state.sceneNatural.width * clamped)}px`;
  }
  el.zoomLevel.textContent = `${Math.round(clamped * 100)}%`;
}

// Zoom about a fixed point so the diagram grows under the cursor rather than
// sliding away from it. Defaults to the centre of the viewport.
function zoomSceneAt(factor, clientX, clientY) {
  if (!state.sceneNatural.width) return;
  const view = el.main.getBoundingClientRect();
  const x = clientX ?? view.left + view.width / 2;
  const y = clientY ?? view.top + view.height / 2;

  const before = el.sceneHolder.getBoundingClientRect();
  const anchorX = (x - before.left) / state.sceneZoom;
  const anchorY = (y - before.top) / state.sceneZoom;

  setSceneZoom(state.sceneZoom * factor);

  const after = el.sceneHolder.getBoundingClientRect();
  el.main.scrollTo({
    left: el.main.scrollLeft + after.left + anchorX * state.sceneZoom - x,
    top: el.main.scrollTop + after.top + anchorY * state.sceneZoom - y,
    behavior: 'instant',
  });
}

function nudgeSceneZoom(factor) {
  state.sceneAutoFit = false;
  zoomSceneAt(factor);
}

/* ------------------------------------------------------------- panning */

const PAN_THRESHOLD = 4;
const pan = { active: false, moved: false, id: null, x: 0, y: 0, left: 0, top: 0 };

function panStart(e) {
  // Left drag, middle drag, or space held — a viewer has nothing to select,
  // so dragging the canvas should simply move it.
  const wanted = e.button === 0 || e.button === 1 || state.spaceHeld;
  if (!wanted || el.canvas.hidden) return;

  // Middle button would otherwise start Chromium's autoscroll.
  if (e.button === 1) e.preventDefault();

  pan.active = true;
  pan.moved = false;
  pan.id = e.pointerId;
  pan.x = e.clientX;
  pan.y = e.clientY;
  pan.left = el.main.scrollLeft;
  pan.top = el.main.scrollTop;
  try { el.canvas.setPointerCapture(e.pointerId); } catch { /* pointer already gone */ }
}

function panMove(e) {
  if (!pan.active || e.pointerId !== pan.id) return;
  const dx = e.clientX - pan.x;
  const dy = e.clientY - pan.y;

  // Hold off until the pointer has actually travelled, so a click on an
  // element link still registers as a click.
  if (!pan.moved && Math.hypot(dx, dy) < PAN_THRESHOLD) return;
  if (!pan.moved) {
    pan.moved = true;
    el.canvas.classList.add('panning');
  }
  e.preventDefault();
  el.main.scrollTo({ left: pan.left - dx, top: pan.top - dy, behavior: 'instant' });
}

function panEnd(e) {
  if (!pan.active || (e && e.pointerId !== pan.id)) return;
  pan.active = false;
  el.canvas.classList.remove('panning');
  try {
    if (pan.id !== null && el.canvas.hasPointerCapture?.(pan.id)) {
      el.canvas.releasePointerCapture(pan.id);
    }
  } catch { /* nothing to release */ }
  pan.id = null;
}

/* --------------------------------------------------------- scene outline */

function buildSceneOutline(scene) {
  const items = SceneView.outline(scene);
  el.tocList.replaceChildren();
  el.tocEmpty.hidden = items.length > 0;
  el.tocEmpty.textContent = 'No text or frames in this drawing.';
  tocObserver?.disconnect();

  for (const item of items) {
    const a = document.createElement('a');
    a.className = 'scene-item';
    a.href = '#';
    a.title = item.label;
    const chip = document.createElement('span');
    chip.className = 'chip';
    chip.textContent = item.type;
    const label = document.createElement('span');
    label.className = 'label';
    label.textContent = item.label;
    a.append(chip, label);
    a.addEventListener('click', (e) => { e.preventDefault(); scrollToSceneElement(item.el); });
    el.tocList.append(a);
  }
}

function scrollToSceneElement(element) {
  if (!state.sceneBounds) return;
  const pos = SceneView.positionInSvg(element, state.sceneBounds);
  const pad = parseFloat(getComputedStyle(el.canvas).paddingTop) || 0;
  const z = state.sceneZoom;
  el.main.scrollTo({
    top: Math.max(0, pos.y * z + pad - el.main.clientHeight / 3),
    left: Math.max(0, pos.x * z - el.main.clientWidth / 3),
    behavior: 'smooth',
  });
}

/* ============================================================ view switch */

function applyView() {
  const scene = SCENE_KINDS.has(state.kind);
  const editing = state.editing && !scene;
  const drawing = state.editing && scene;
  el.editorPane.hidden = !editing;
  el.splitHandle.hidden = !editing || state.previewHidden;
  el.body.classList.toggle('editing', editing);
  el.body.classList.toggle('solo', editing && state.previewHidden);
  el.main.hidden = editing && state.previewHidden;
  el.main.classList.toggle('drawing', drawing);
  el.drawEditor.hidden = !drawing;
  el.source.hidden = !state.sourceView || state.editing;
  el.content.hidden = (state.sourceView && !editing) || scene;
  el.canvas.hidden = state.sourceView || !scene || drawing;
  el.zoomPill.hidden = el.canvas.hidden || !el.sceneError.hidden;
  $('btn-source').classList.toggle('on', state.sourceView && !state.editing);
  $('btn-edit').classList.toggle('on', state.editing);
  $('btn-preview').hidden = !editing;
  $('btn-preview').classList.toggle('on', editing && !state.previewHidden);
}

function displayName() {
  return state.path ? state.path.split('/').pop() : 'Untitled';
}

function updateTitle() {
  const mark = state.dirty ? '• ' : '';
  document.title = `${mark}${displayName()} — MD View`;
  el.crumb.textContent = mark + (state.path ? shortPath(state.path, 3) : 'Untitled');
  el.crumb.title = state.path || 'Not saved yet';
  el.statusPath.textContent = state.path ? state.path.replace(HOME, '~') : 'Untitled — not saved yet';
}

function setDirty(dirty) {
  if (state.dirty === dirty) return;
  state.dirty = dirty;
  el.statusDirty.hidden = !dirty;
  el.btnSave.classList.toggle('dirty', dirty);
  updateTitle();
  ipc.setDocStatus({ path: state.path, dirty });
}

function setDocument({ path: filePath, content, dir, kind }) {
  if (state.path) state.scrollMemory.set(state.path, el.main.scrollTop);
  // A drawing editor belongs to the old document; it is torn down before the
  // state changes under it. Unsaved changes were already confirmed away.
  const wasEditing = state.editing;
  if (sceneEditor) { unmountSceneEditor(); state.editing = false; }
  closeDrawOverlay();
  const sameFile = state.path === filePath;
  state.path = filePath;
  state.dir = dir;
  state.raw = content;
  state.savedRaw = content;
  state.untitled = false;
  state.kind = kind || 'markdown';
  clearDiagramCaches();

  el.welcome.hidden = true;
  setDirty(false);
  updateTitle();
  ipc.setDocStatus({ path: filePath, dirty: false });

  const isScene = SCENE_KINDS.has(state.kind);
  el.sourceCode.textContent = content;
  try {
    el.sourceCode.innerHTML = DOMPurify.sanitize(
      hljs.highlight(content, { language: isScene ? 'json' : 'markdown', ignoreIllegals: true }).value,
      SANITIZE);
  } catch { /* plain source is fine */ }

  // Edit mode follows the document: a Markdown file keeps the text editor
  // open, a drawing gets the canvas.
  if (wasEditing && isScene) {
    state.editing = false;
    clearTimeout(previewTimer);
    el.statusCursor.hidden = true;
    enterEdit();
  } else if (wasEditing && !state.editing) {
    enterEdit();
  }
  if (state.editing && editor && !isScene) editor.setValue(content);

  applyView();

  const keepScroll = sameFile ? el.main.scrollTop : (state.scrollMemory.get(filePath) || 0);
  const done = isScene
    ? renderScene(content, state.kind)
    : render(content, { path: filePath, dir });

  done.then(() => {
    restoreScroll(keepScroll);
    if (el.findInput.value && !el.find.hidden) runFind(el.findInput.value);
  });
  markCurrentInTree();
}

function toggleSourceView(force) {
  if (state.editing) return;
  state.sourceView = force ?? !state.sourceView;
  applyView();
  if (el.findInput.value && !el.find.hidden) runFind(el.findInput.value);
}

/* ============================================================== editing */

let editor = null;
let previewTimer = null;

function ensureEditor() {
  if (editor) return editor;
  editor = MdEditor.create({
    parent: el.editorHost,
    doc: state.raw,
    hint: 'Start writing Markdown…',
    onChange: onEditorChange,
    onCursor: updateCursor,
    onScroll: syncPreviewFromEditor,
  });
  return editor;
}

function onEditorChange(text) {
  // Programmatic loads set state.raw first; only the user's typing goes on.
  if (text === state.raw) return;
  state.raw = text;
  setDirty(text !== state.savedRaw);
  clearTimeout(previewTimer);
  if (!state.previewHidden) previewTimer = setTimeout(renderPreview, 180);
}

function renderPreview() {
  if (!state.editing) return;
  return render(state.raw, { path: state.path, dir: state.dir });
}

function updateCursor({ line, col }) {
  el.statusCursor.textContent = `Ln ${line}, Col ${col}`;
}

function enterEdit() {
  if (state.editing) return;
  if (SCENE_KINDS.has(state.kind)) {
    state.editing = true;
    closeFind();
    mountSceneEditor();
    if (!sceneEditor) { state.editing = false; return; }
    applyView();
    return;
  }
  if (!state.path && !state.untitled) {
    newDocument();
    return;
  }
  state.editing = true;
  ensureEditor().setValue(state.raw);
  closeFind();
  applyView();
  el.statusCursor.hidden = false;
  updateCursor(editor.cursor());
  ipc.setEditing('text');
  // Source view shows stale text while editing; the live preview replaces it.
  if (state.sourceView) { state.sourceView = false; applyView(); }
  editor.focus();
}

function exitEdit() {
  if (!state.editing) return;
  state.editing = false;
  if (sceneEditor) {
    // The canvas is the truth until now; the viewer redraws from the text.
    syncSceneRaw();
    unmountSceneEditor();
    applyView();
    ipc.setEditing(false);
    rerender();
    return;
  }
  clearTimeout(previewTimer);
  closeDiagramEditor();
  applyView();
  el.statusCursor.hidden = true;
  ipc.setEditing(false);
  // The preview may be behind the editor by a debounce tick.
  if (state.raw !== renderedRaw) rerender();
  el.main.focus();
}

function toggleEdit() {
  if (state.editing) exitEdit();
  else enterEdit();
}

function togglePreview() {
  if (!state.editing || sceneEditor) return;
  state.previewHidden = !state.previewHidden;
  applyView();
  ipc.setState({ previewHidden: state.previewHidden });
  if (!state.previewHidden) renderPreview();
  editor.focus();
}

// New, empty document. It lives in memory until it is saved.
function newDocument() {
  if (state.path) state.scrollMemory.set(state.path, el.main.scrollTop);
  if (sceneEditor) { unmountSceneEditor(); state.editing = false; }
  closeDrawOverlay();
  state.path = null;
  state.dir = state.root || '';
  state.raw = '';
  state.savedRaw = '';
  state.untitled = true;
  state.kind = 'markdown';
  state.scene = null;
  el.welcome.hidden = true;
  el.sourceCode.textContent = '';
  setDirty(false);
  updateTitle();
  ipc.setDocStatus({ path: null, dirty: false });
  markCurrentInTree();
  render('', { path: null, dir: state.dir });
  if (!state.editing) {
    state.editing = true;
    ensureEditor();
    applyView();
    el.statusCursor.hidden = false;
    ipc.setEditing('text');
  }
  editor.setValue('');
  editor.focus();
}

/* ------------------------------------------------------------ scroll sync */

// The two panes follow each other proportionally. Only the pane the user is
// actually scrolling drives the other, which stops them chasing each other.
let syncSource = null;
let syncTimer = null;

function claimSync(source) {
  if (syncSource && syncSource !== source) return false;
  syncSource = source;
  clearTimeout(syncTimer);
  syncTimer = setTimeout(() => { syncSource = null; }, 120);
  return true;
}

function syncPreviewFromEditor(sc) {
  if (!state.editing || state.previewHidden || !claimSync('editor')) return;
  const max = sc.scrollHeight - sc.clientHeight;
  if (max <= 0) return;
  const fraction = sc.scrollTop / max;
  el.main.classList.add('no-smooth');
  el.main.scrollTop = fraction * (el.main.scrollHeight - el.main.clientHeight);
  requestAnimationFrame(() => el.main.classList.remove('no-smooth'));
}

function syncEditorFromPreview() {
  if (!state.editing || !editor || !claimSync('preview')) return;
  const max = el.main.scrollHeight - el.main.clientHeight;
  if (max <= 0) return;
  editor.scrollTo(el.main.scrollTop / max);
}

el.main.addEventListener('scroll', () => {
  if (state.editing && el.main.matches(':hover')) syncEditorFromPreview();
}, { passive: true });

/* ---------------------------------------------------------- split handle */

const split = { active: false, startX: 0, startWidth: 0 };

el.splitHandle.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return;
  split.active = true;
  split.startX = e.clientX;
  split.startWidth = el.editorPane.getBoundingClientRect().width;
  el.splitHandle.classList.add('dragging');
  el.body.classList.add('resizing');
  el.splitHandle.setPointerCapture(e.pointerId);
  e.preventDefault();
});
el.splitHandle.addEventListener('pointermove', (e) => {
  if (!split.active) return;
  const total = el.editorPane.getBoundingClientRect().width + el.main.getBoundingClientRect().width;
  const width = Math.min(total - 200, Math.max(240, split.startWidth + e.clientX - split.startX));
  // Expressed as a ratio to the preview's share, so it survives resizing.
  el.body.style.setProperty('--editor-grow', String(Math.round((width / (total - width)) * 100) / 100));
});
const endSplit = () => {
  if (!split.active) return;
  split.active = false;
  el.splitHandle.classList.remove('dragging');
  el.body.classList.remove('resizing');
  ipc.setState({ editorSplit: el.body.style.getPropertyValue('--editor-grow') });
};
el.splitHandle.addEventListener('pointerup', endSplit);
el.splitHandle.addEventListener('pointercancel', endSplit);
el.splitHandle.addEventListener('dblclick', () => {
  el.body.style.removeProperty('--editor-grow');
  ipc.setState({ editorSplit: '' });
});

/* ------------------------------------------------------------------ saving */

async function save() {
  syncSceneRaw();
  if (!state.path) return saveAs();
  const res = await ipc.saveFile(state.path, state.raw);
  if (!res.ok) {
    toast('Could not save: ' + res.error);
    return false;
  }
  state.savedRaw = state.raw;
  setDirty(false);
  toast('Saved');
  return true;
}

async function saveAs() {
  syncSceneRaw();
  const res = await ipc.saveFileAs(state.raw, state.path || null);
  if (!res.ok) {
    if (!res.canceled) toast('Could not save: ' + res.error);
    return false;
  }
  state.path = res.path;
  state.dir = res.dir;
  // A drawing saved under a Markdown name is still the drawing on screen.
  if (!sceneEditor) state.kind = res.kind;
  state.savedRaw = state.raw;
  state.untitled = false;
  setDirty(false);
  updateTitle();
  ipc.setDocStatus({ path: state.path, dirty: false });
  markCurrentInTree();
  // Relative links and images resolve against the new location.
  if (!sceneEditor) rerender();
  toast(`Saved to ${shortPath(res.path, 3)}`);
  return true;
}

// Asks about unsaved changes before they would be lost. Resolves true when
// it is safe to go ahead — the user saved, or chose to discard.
async function confirmDiscard() {
  if (!state.dirty) return true;
  const choice = await ipc.askUnsaved(displayName());
  if (choice === 'save') return save();
  return choice === 'discard';
}

// The main process calls this before opening another file or closing.
window.__confirmDiscard = confirmDiscard;

// Handles for the smoke-test hook (MDV_SHOT_JS); nothing in the app uses them.
window.__mdvTest = {
  sceneEditor: () => sceneEditor,
  overlayEditor: () => overlayEditor,
  state,
};

function togglePane(pane, button, key) {
  pane.hidden = !pane.hidden;
  button.classList.toggle('on', !pane.hidden);
  ipc.setState({ [key]: !pane.hidden });
}

function renderRecent(recent) {
  el.welcomeRecent.replaceChildren();
  const list = (recent || []).slice(0, 6);
  if (list.length) {
    const head = document.createElement('li');
    head.className = 'recent-head';
    head.textContent = 'Recent';
    el.welcomeRecent.append(head);
  }
  for (const p of list) {
    const li = document.createElement('li');
    li.textContent = shortPath(p, 2);
    li.title = p;
    li.addEventListener('click', () => ipc.openPath(p));
    el.welcomeRecent.append(li);
  }
}

/* ================================================================ wiring */

$('btn-open').addEventListener('click', () => ipc.openFileDialog());
$('btn-folder').addEventListener('click', () => ipc.openFolderDialog());
$('welcome-open').addEventListener('click', () => ipc.openFileDialog());
$('welcome-folder').addEventListener('click', () => ipc.openFolderDialog());
$('welcome-new').addEventListener('click', () => newDocument());
$('btn-sidebar').addEventListener('click', () => togglePane(el.sidebar, $('btn-sidebar'), 'sidebar'));
$('btn-toc').addEventListener('click', () => togglePane(el.toc, $('btn-toc'), 'toc'));
$('btn-source').addEventListener('click', () => toggleSourceView());
$('btn-edit').addEventListener('click', () => toggleEdit());
$('btn-preview').addEventListener('click', () => togglePreview());
el.btnSave.addEventListener('click', () => save());

// Formatting buttons must not steal focus from the editor, or the selection
// they are meant to act on is gone by the time they run.
for (const btn of document.querySelectorAll('#editor-tools .fmt[data-fmt]')) {
  btn.addEventListener('mousedown', (e) => e.preventDefault());
  btn.addEventListener('click', () => { if (editor) editor.format(btn.dataset.fmt); });
}
$('btn-theme').addEventListener('click', () => {
  const next = isDark() ? 'light' : 'dark';
  applyTheme(next);
  ipc.setState({ theme: next });
});
$('help-close').addEventListener('click', () => { el.help.hidden = true; });
$('zoom-in').addEventListener('click', () => { state.sceneAutoFit = false; nudgeSceneZoom(1.25); });
$('zoom-out').addEventListener('click', () => { state.sceneAutoFit = false; nudgeSceneZoom(0.8); });
$('zoom-level').addEventListener('click', () => { state.sceneAutoFit = false; setSceneZoom(1); });
$('zoom-fit').addEventListener('click', () => { state.sceneAutoFit = true; fitScene(); });

// Ctrl+wheel over a diagram zooms the diagram, not the whole page.
el.canvas.addEventListener('wheel', (e) => {
  if (!e.ctrlKey && !e.metaKey) return;
  e.preventDefault();
  state.sceneAutoFit = false;
  zoomSceneAt(e.deltaY < 0 ? 1.1 : 1 / 1.1, e.clientX, e.clientY);
}, { passive: false });

el.canvas.addEventListener('pointerdown', panStart);
el.canvas.addEventListener('pointermove', panMove);
el.canvas.addEventListener('pointerup', panEnd);
el.canvas.addEventListener('pointercancel', panEnd);
el.canvas.addEventListener('lostpointercapture', panEnd);
el.canvas.addEventListener('dragstart', (e) => e.preventDefault());

// A drag that moved is a pan, not a click on whatever sits under the pointer.
el.canvas.addEventListener('click', (e) => {
  if (pan.moved) { e.preventDefault(); e.stopPropagation(); pan.moved = false; }
}, true);

// A fitted diagram stays fitted as the window changes size.
let resizeTimer = null;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    if (state.sceneAutoFit && SCENE_KINDS.has(state.kind) && !el.canvas.hidden) fitScene();
  }, 120);
});
$('find-next').addEventListener('click', () => gotoMatch(state.matchIndex + 1));
$('find-prev').addEventListener('click', () => gotoMatch(state.matchIndex - 1));
$('find-close').addEventListener('click', closeFind);

$('sidebar-filter-btn').addEventListener('click', () => {
  el.filter.hidden = !el.filter.hidden;
  if (!el.filter.hidden) el.filter.focus();
  else { el.filter.value = ''; applyFilter(''); }
});
el.filter.addEventListener('input', () => applyFilter(el.filter.value));

let findDebounce = null;
el.findInput.addEventListener('input', () => {
  clearTimeout(findDebounce);
  findDebounce = setTimeout(() => runFind(el.findInput.value), 120);
});
el.findInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); gotoMatch(state.matchIndex + (e.shiftKey ? -1 : 1)); }
  if (e.key === 'Escape') { e.preventDefault(); closeFind(); }
});

document.addEventListener('click', (e) => {
  const a = e.target.closest('a[href], a[*|href]');
  if (!a) return;
  e.preventDefault();
  const kind = a.dataset.kind;
  if (kind === 'anchor') scrollToId(decodeURIComponent(a.getAttribute('href').slice(1)));
  else if (kind === 'external') ipc.openExternal(a.href);
  else if (kind === 'local') ipc.openPath(a.dataset.target);
  else openSceneLink(a);
});

// Excalidraw elements can carry a link. On an SVG anchor `href` is an
// SVGAnimatedString, so the attribute has to be read directly.
function openSceneLink(a) {
  const href = a.getAttribute('href') || a.getAttribute('xlink:href');
  if (!href) return;
  if (/^(https?|mailto):/i.test(href)) { ipc.openExternal(href); return; }
  if (href.startsWith('#')) { scrollToId(decodeURIComponent(href.slice(1))); return; }
  const url = state.dir && resolveLocal(href, state.dir);
  if (url) ipc.openPath(decodeURIComponent(url.pathname));
}

document.addEventListener('keydown', (e) => {
  // Excalidraw owns the keyboard while a drawing is being edited.
  if (overlayEditor || (sceneEditor && el.drawEditor.contains(e.target))) return;
  if (e.key === 'Escape') {
    if (!el.help.hidden) { el.help.hidden = true; return; }
    if (!el.find.hidden) closeFind();
  }
  if (e.key === 'F1') { e.preventDefault(); el.help.hidden = !el.help.hidden; }
  if (e.code === 'Space' && !el.canvas.hidden && e.target === document.body) {
    e.preventDefault();
    state.spaceHeld = true;
    el.canvas.classList.add('grabbable');
  }
  if ((e.ctrlKey || e.metaKey) && e.key === '9') {
    e.preventDefault();
    state.sceneAutoFit = true;
    fitScene();
  }
});

document.addEventListener('keyup', (e) => {
  if (e.code === 'Space') {
    state.spaceHeld = false;
    el.canvas.classList.remove('grabbable');
  }
});

window.addEventListener('blur', () => { state.spaceHeld = false; panEnd(); });

/* drag and drop ---------------------------------------------------------- */
let dragDepth = 0;
window.addEventListener('dragenter', (e) => { e.preventDefault(); if (++dragDepth === 1) el.drop.hidden = false; });
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('dragleave', (e) => { e.preventDefault(); if (--dragDepth <= 0) { dragDepth = 0; el.drop.hidden = true; } });
window.addEventListener('drop', (e) => {
  e.preventDefault();
  dragDepth = 0;
  el.drop.hidden = true;
  const file = e.dataTransfer.files[0];
  const p = file && ipc.pathForFile(file);
  if (p) ipc.openPath(p);
});

/* main-process events ---------------------------------------------------- */
ipc.onFileOpened((payload) => setDocument(payload));

ipc.onFolderOpened(({ root, tree }) => {
  state.root = root;
  state.tree = tree;
  el.tree.replaceChildren();
  renderTree(tree, el.tree);
  el.treeEmpty.hidden = tree.length > 0;
  if (!tree.length) el.treeEmpty.textContent = 'No Markdown files in this folder.';
  el.sidebarTitle.textContent = root.split('/').pop() || 'Files';
  el.sidebar.hidden = false;
  $('btn-sidebar').classList.add('on');
  markCurrentInTree();
});

ipc.onFileChanged(async (changed) => {
  if (changed !== state.path) return;
  const res = await ipc.readFile(changed);
  if (!res.ok) return;
  // Our own save comes back through the watcher too.
  if (res.content === state.savedRaw) return;
  if (state.dirty) {
    // Never clobber live edits. The disk copy is remembered so a later save
    // is still a deliberate overwrite rather than an accident.
    state.savedRaw = res.content;
    toast('File changed on disk — Reload (Ctrl+R) to discard your edits and pick it up');
    return;
  }
  setDocument({ path: changed, content: res.content, dir: state.dir, kind: state.kind });
  toast('Reloaded — file changed on disk');
});

ipc.onReadingWidth((on) => el.main.classList.toggle('reading', on));
ipc.onDiagramFont((on) => {
  state.monoDiagrams = on;
  const keep = el.main.scrollTop;
  rerender();
  requestAnimationFrame(() => { el.main.scrollTop = keep; });
  toast(on ? 'Diagram text: monospace' : 'Diagram text: as authored');
});
ipc.onThemeChanged((theme) => applyTheme(theme));
ipc.onSystemTheme((dark) => applyTheme(undefined, dark));
ipc.onToast((msg) => toast(msg));
ipc.onReadyEmpty(() => { el.welcome.hidden = false; });

// Keyboard shortcuts arrive from the application menu, which fires before
// the page sees the key — so the editor's own bindings are reached from here.
function editingTarget() {
  // The flowchart designer keeps its own history of regenerated source.
  const designer = diagramPanel && diagramPanel.designer();
  if (designer && designer.isActive()) {
    return {
      undo: () => designer.undo(), redo: () => designer.redo(),
      selectAll: () => {}, openSearch: () => {}, findNext: () => {}, findPrevious: () => {},
    };
  }
  const view = MdEditor.focused();
  if (!view) return null;
  if (editor && view === editor.view) return editor;
  // The inline diagram editor: a bare view, wrapped on the fly.
  return {
    view,
    undo: () => window.MDV.CM.undo(view),
    redo: () => window.MDV.CM.redo(view),
    selectAll: () => window.MDV.CM.selectAll(view),
    openSearch: () => window.MDV.CM.openSearchPanel(view),
    findNext: () => window.MDV.CM.findNext(view),
    findPrevious: () => window.MDV.CM.findPrevious(view),
  };
}

ipc.onAction(async (action) => {
  if (action.startsWith('fmt:')) {
    if (state.editing && editor) editor.format(action.slice(4));
    return;
  }
  const target = editingTarget();
  switch (action) {
    case 'new':
      if (await confirmDiscard()) newDocument();
      break;
    case 'save': save(); break;
    case 'save-as': saveAs(); break;
    case 'toggle-edit': toggleEdit(); break;
    case 'toggle-preview': togglePreview(); break;
    case 'undo':
      if (target) target.undo(); else document.execCommand('undo');
      break;
    case 'redo':
      if (target) target.redo(); else document.execCommand('redo');
      break;
    case 'select-all':
      if (target) target.selectAll(); else document.execCommand('selectAll');
      break;
    case 'reload': {
      if (!state.path) return;
      if (!(await confirmDiscard())) return;
      const res = await ipc.readFile(state.path);
      if (res.ok) { setDocument({ path: state.path, content: res.content, dir: state.dir, kind: state.kind }); toast('Reloaded'); }
      break;
    }
    case 'find':
      if (target) target.openSearch();
      else if (state.editing && editor) editor.openSearch();
      else openFind();
      break;
    case 'find-next':
      if (target) target.findNext(); else gotoMatch(state.matchIndex + 1);
      break;
    case 'find-prev':
      if (target) target.findPrevious(); else gotoMatch(state.matchIndex - 1);
      break;
    case 'toggle-sidebar': togglePane(el.sidebar, $('btn-sidebar'), 'sidebar'); break;
    case 'toggle-toc': togglePane(el.toc, $('btn-toc'), 'toc'); break;
    case 'toggle-source': toggleSourceView(); break;
    case 'copy-html': ipc.writeClipboard(el.content.innerHTML, el.content.innerHTML); toast('HTML copied'); break;
    case 'copy-source': ipc.writeClipboard(state.raw); toast('Markdown copied'); break;
    case 'help': el.help.hidden = !el.help.hidden; break;
    case 'print-prepare':
      printWasReading = el.main.classList.contains('reading');
      el.main.classList.remove('reading');
      break;
    case 'print-done':
      el.main.classList.toggle('reading', printWasReading);
      break;
  }
});

/* boot ------------------------------------------------------------------- */
(async () => {
  const saved = await ipc.getState();
  state.systemDark = saved.dark;
  applyTheme(saved.theme || 'system', saved.dark);
  el.sidebar.hidden = saved.sidebar === false;
  el.toc.hidden = saved.toc === false;
  $('btn-sidebar').classList.toggle('on', !el.sidebar.hidden);
  $('btn-toc').classList.toggle('on', !el.toc.hidden);
  el.main.classList.toggle('reading', saved.readingWidth === true);
  state.monoDiagrams = saved.monoDiagrams === true;
  state.previewHidden = saved.previewHidden === true;
  if (saved.editorSplit) el.body.style.setProperty('--editor-grow', saved.editorSplit);
  renderRecent(saved.recent);
  if (!highlightsSupported) el.findCount.textContent = 'n/a';
})();
