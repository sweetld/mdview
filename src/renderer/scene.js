'use strict';

/**
 * Excalidraw scene support: parsing the several shapes a scene file can take,
 * exporting it to SVG, and the geometry the viewer needs to scroll around it.
 * Exposed as window.SceneView; app.js owns all the UI.
 */
(() => {
  const { exportToSvg, restore, FONT_FAMILY, DOMPurify, LZString } = window.MDV;

  const PADDING = 20;

  /* ------------------------------------------------------------- parsing */

  // Obsidian's Excalidraw plugin wraps the scene in Markdown, either as plain
  // JSON or LZString-compressed base64, under a "## Drawing" heading.
  const DRAWING_BLOCK = /##\s*Drawing\s*\r?\n+```(compressed-json|json)\r?\n([\s\S]*?)```/i;
  const BARE_BLOCK = /```(compressed-json|json)\r?\n([\s\S]*?)```/i;

  function extractFromMarkdown(text) {
    const m = text.match(DRAWING_BLOCK) || text.match(BARE_BLOCK);
    if (!m) {
      const err = new Error('No Excalidraw drawing block found in this file.');
      err.code = 'NO_DRAWING';
      throw err;
    }
    const [, lang, payload] = m;
    if (lang.toLowerCase() === 'compressed-json') {
      const decoded = LZString.decompressFromBase64(payload.replace(/\s+/g, ''));
      if (!decoded) throw new Error('The compressed drawing data could not be decoded.');
      return decoded;
    }
    return payload;
  }

  function parse(text, { kind, mono = false } = {}) {
    const raw = kind === 'excalidraw-md' ? extractFromMarkdown(text) : text;

    let data;
    try {
      data = JSON.parse(raw);
    } catch (err) {
      throw new Error(`Not valid JSON: ${err.message}`);
    }
    if (!data || typeof data !== 'object') throw new Error('Scene file is empty.');
    if (Array.isArray(data)) data = { elements: data };
    if (!Array.isArray(data.elements)) {
      throw new Error('No "elements" array — this does not look like an Excalidraw scene.');
    }

    if (mono) {
      for (const el of data.elements) {
        if (el && el.type === 'text') el.fontFamily = FONT_FAMILY.Cascadia;
      }
    }

    // refreshDimensions stays off even when the font is overridden. Monospace
    // is wider, so re-wrapping breaks labels mid-word ("Excalidra/w?") while
    // often not fixing the fit anyway; keeping the author's own line breaks
    // and letting a wide label sit slightly proud of its shape reads better.
    const scene = restore(data, null, null, {
      repairBindings: true,
      refreshDimensions: false,
    });
    scene.elements = scene.elements.filter((el) => !el.isDeleted);
    return scene;
  }

  /* ------------------------------------------------------------ geometry */

  function bounds(elements) {
    if (!elements.length) return { minX: 0, minY: 0, width: 0, height: 0 };
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const el of elements) {
      const x1 = Math.min(el.x, el.x + (el.width || 0));
      const y1 = Math.min(el.y, el.y + (el.height || 0));
      minX = Math.min(minX, x1);
      minY = Math.min(minY, y1);
      maxX = Math.max(maxX, x1 + Math.abs(el.width || 0));
      maxY = Math.max(maxY, y1 + Math.abs(el.height || 0));
    }
    return { minX, minY, width: maxX - minX, height: maxY - minY };
  }

  // Where an element sits inside the exported SVG's own coordinate space.
  function positionInSvg(el, sceneBounds) {
    return {
      x: el.x - sceneBounds.minX + PADDING,
      y: el.y - sceneBounds.minY + PADDING,
      width: Math.abs(el.width || 0),
      height: Math.abs(el.height || 0),
    };
  }

  /* ------------------------------------------------------------- outline */

  const TYPE_LABEL = {
    rectangle: 'rectangle', ellipse: 'ellipse', diamond: 'diamond',
    arrow: 'arrow', line: 'line', freedraw: 'sketch', image: 'image',
    frame: 'frame', magicframe: 'frame', embeddable: 'embed', text: 'text',
  };

  function outline(scene) {
    const byId = new Map(scene.elements.map((el) => [el.id, el]));
    const items = [];

    for (const el of scene.elements) {
      if (el.type === 'frame' || el.type === 'magicframe') {
        items.push({ id: el.id, label: el.name || 'Frame', type: 'frame', el });
      } else if (el.type === 'text') {
        const label = (el.originalText || el.text || '').trim().replace(/\s+/g, ' ');
        if (!label) continue;
        // A label bound to a shape should point at the shape, not the text node.
        const target = el.containerId && byId.get(el.containerId);
        items.push({
          id: el.id,
          label,
          type: target ? TYPE_LABEL[target.type] || target.type : 'text',
          el: target || el,
        });
      }
    }
    items.sort((a, b) => (a.el.y - b.el.y) || (a.el.x - b.el.x));
    return items;
  }

  function stats(scene) {
    const b = bounds(scene.elements);
    const counts = new Map();
    for (const el of scene.elements) counts.set(el.type, (counts.get(el.type) || 0) + 1);
    return {
      count: scene.elements.length,
      width: Math.round(b.width),
      height: Math.round(b.height),
      breakdown: [...counts.entries()].sort((a, b2) => b2[1] - a[1]),
    };
  }

  /* ------------------------------------------------------------ exporting */

  const SVG_SANITIZE = {
    USE_PROFILES: { svg: true, svgFilters: true, html: true },
    // Excalidraw emits @font-face rules and foreignObject-wrapped labels; the
    // page CSP blocks anything a stylesheet might try to fetch.
    ADD_TAGS: ['style', 'foreignObject'],
    ADD_ATTR: ['dominant-baseline', 'transform', 'marker-end', 'marker-start', 'font-family'],
  };

  async function toSvg(scene, { dark = false, background = true } = {}) {
    const svg = await exportToSvg({
      elements: scene.elements,
      appState: {
        ...scene.appState,
        exportBackground: background,
        exportWithDarkMode: dark,
        exportEmbedScene: false,
        exportScale: 1,
        viewBackgroundColor: scene.appState?.viewBackgroundColor || '#ffffff',
      },
      files: scene.files || {},
      exportPadding: PADDING,
      renderEmbeddables: false,
    });

    // The exporter writes @font-face rules pointing at Excalidraw's CDN so the
    // SVG travels well. This viewer is offline, so repoint them at the fonts
    // vendored beside the page — the filenames are identical.
    const markup = svg.outerHTML.replace(
      /https?:\/\/[^)"']*\/dist\/prod\/fonts\//g,
      window.EXCALIDRAW_ASSET_PATH + 'fonts/');

    // Round-trip through the sanitiser: scene files are untrusted input.
    const holder = document.createElement('div');
    holder.innerHTML = DOMPurify.sanitize(markup, SVG_SANITIZE);
    const clean = holder.querySelector('svg');
    if (!clean) throw new Error('The exported diagram was empty.');

    const width = parseFloat(svg.getAttribute('width')) || 0;
    const height = parseFloat(svg.getAttribute('height')) || 0;
    // Let CSS drive the displayed size; the viewBox keeps it scaling cleanly.
    clean.removeAttribute('width');
    clean.removeAttribute('height');
    if (!clean.getAttribute('viewBox') && width && height) {
      clean.setAttribute('viewBox', `0 0 ${width} ${height}`);
    }
    return { svg: clean, width, height };
  }

  // Writes an edited scene back into an Obsidian-style .excalidraw.md: the
  // drawing block is replaced, as plain JSON, and the rest of the note kept.
  function replaceDrawing(text, json) {
    const block = '```json\n' + json + '\n```';
    const m = text.match(DRAWING_BLOCK) || text.match(BARE_BLOCK);
    if (!m) return text.trimEnd() + '\n\n## Drawing\n' + block + '\n';
    const fenceAt = m[0].indexOf('```');
    const head = m[0].slice(0, fenceAt);
    return text.slice(0, m.index) + head + block + text.slice(m.index + m[0].length);
  }

  window.SceneView = { parse, toSvg, outline, stats, bounds, positionInSvg, replaceDrawing, PADDING };
})();
