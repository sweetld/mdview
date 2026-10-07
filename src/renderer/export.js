'use strict';

/**
 * Turns the rendered document into a single self-contained HTML string for
 * Word export: SVG diagrams rasterised to PNG (Word cannot draw SVG), local
 * images inlined as data URIs, and viewer-only chrome stripped out.
 * Exposed as window.DocExport.
 */
(() => {
  // Printable area of an A4 page at 96dpi. The two formats do not agree: the
  // PDF is printed with 0.5in margins, Word with ~0.79in plus paragraph
  // spacing around each image, so Word needs the smaller box. Anything taller
  // than this cannot share a page, and the print engine leaves blanks behind.
  // The heights leave room for the heading that usually sits above a diagram;
  // fill the page exactly and the heading is orphaned onto a page of its own.
  const PAGE = {
    print: { width: 660, height: 920 },
    word: { width: 620, height: 840 },
    printLandscape: { width: 980, height: 620 },
    wordLandscape: { width: 930, height: 600 },
  };

  // A diagram goes on a landscape page only when turning the page actually
  // buys it room — that is, when it is wider than the page, not merely when it
  // is large. A tall diagram is already better served by portrait, and a
  // diagram that still renders near full size in the text column is not worth
  // breaking the page for.
  const LANDSCAPE_GAIN = 1.15;
  const LANDSCAPE_CRAMPED = 0.6;

  function svgSize(svg) {
    const box = svg.getAttribute('viewBox');
    if (box) {
      const [, , w, h] = box.split(/[\s,]+/).map(Number);
      if (w > 0 && h > 0) return { width: w, height: h };
    }
    const rect = svg.getBoundingClientRect();
    return { width: rect.width || 600, height: rect.height || 400 };
  }

  // An <svg> inside <img> is a sandboxed document: it cannot pull in external
  // resources, so everything it needs must already be inline. Excalidraw
  // embeds its fonts as data URIs, which is what makes this work.
  async function rasterise(svg, scale = 2, box = PAGE.word) {
    const { width, height } = svgSize(svg);
    // Rasterise at twice the size it will actually be printed at, not twice
    // its natural size — a 1700x2650 diagram otherwise becomes a 1MB PNG.
    const printed = fit(width, height, box);
    const clone = svg.cloneNode(true);
    clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
    clone.setAttribute('width', String(width));
    clone.setAttribute('height', String(height));
    if (!clone.getAttribute('viewBox')) {
      clone.setAttribute('viewBox', `0 0 ${width} ${height}`);
    }

    const markup = new XMLSerializer().serializeToString(clone);
    const url = URL.createObjectURL(new Blob([markup], { type: 'image/svg+xml;charset=utf-8' }));
    try {
      const img = new Image();
      await new Promise((resolve, reject) => {
        img.onload = resolve;
        img.onerror = () => reject(new Error('diagram could not be rasterised'));
        img.src = url;
      });

      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(printed.w * scale));
      canvas.height = Math.max(1, Math.round(printed.h * scale));
      const ctx = canvas.getContext('2d');
      // Word composites onto white; an alpha background turns into black.
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      return { dataUrl: canvas.toDataURL('image/png'), width: printed.w, height: printed.h };
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  async function toDataUrl(src) {
    const res = await fetch(src);
    const blob = await res.blob();
    return await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(new Error('image could not be read'));
      reader.readAsDataURL(blob);
    });
  }

  function fitScale(width, height, box) {
    return Math.min(1, box.width / width, box.height / height);
  }

  function prefersLandscape(width, height, portraitBox, landscapeBox) {
    const portrait = fitScale(width, height, portraitBox);
    if (portrait >= LANDSCAPE_CRAMPED) return false;  // reads fine in the column
    return fitScale(width, height, landscapeBox) > portrait * LANDSCAPE_GAIN;
  }

  // Scale to fit the page in both directions, never enlarging.
  function fit(width, height, box) {
    if (!width || !height) return { w: Math.round(width) || box.width, h: Math.round(height) || 0 };
    const scale = Math.min(1, box.width / width, box.height / height);
    return { w: Math.round(width * scale), h: Math.round(height * scale) };
  }

  // Sizes every diagram so it fits on one page. Without this a tall diagram
  // cannot be laid out inside its `break-inside: avoid` wrapper, and the print
  // engine leaves the space blank and pushes the drawing further down.
  function fitDiagrams(root) {
    for (const svg of root.querySelectorAll('.mermaid-wrap svg, .excalidraw-wrap svg')) {
      const { width, height } = svgSize(svg);
      const wrap = svg.closest('.mermaid-wrap, .excalidraw-wrap');
      const landscape = prefersLandscape(width, height, PAGE.print, PAGE.printLandscape);

      // The decision is taken once, here, and recorded on the wrapper so the
      // Word export makes the same call from the same DOM.
      if (wrap) {
        wrap.classList.toggle('landscape-figure', landscape);
        if (landscape) wrap.dataset.landscape = '1';
        else delete wrap.dataset.landscape;
      }

      const { w, h } = fit(width, height, landscape ? PAGE.printLandscape : PAGE.print);
      svg.style.width = `${w}px`;
      svg.style.height = `${h}px`;
      svg.style.maxWidth = '100%';
    }
  }

  // Word has no per-element orientation, so the figure is fenced with markers
  // that src/docx-landscape.js converts into real section breaks.
  const LANDSCAPE_START = '[[MDV-LANDSCAPE-START]]';
  const LANDSCAPE_END = '[[MDV-LANDSCAPE-END]]';

  function markLandscape(wrap) {
    const open = document.createElement('p');
    open.textContent = LANDSCAPE_START;
    const close = document.createElement('p');
    close.textContent = LANDSCAPE_END;
    wrap.parentNode.insertBefore(open, wrap);
    wrap.parentNode.insertBefore(close, wrap.nextSibling);
  }

  function placeholder(message) {
    const p = document.createElement('p');
    p.textContent = `[${message}]`;
    return p;
  }

  async function buildHtml({ root, title }) {
    const clone = root.cloneNode(true);

    // Viewer-only furniture has no place in a document.
    clone.querySelectorAll('.copy-btn, .anchor').forEach((n) => n.remove());

    // Diagrams: rasterise from the live tree, which is laid out and measurable.
    const liveSvgs = [...root.querySelectorAll('svg')];
    const cloneSvgs = [...clone.querySelectorAll('svg')];
    for (let i = 0; i < cloneSvgs.length; i++) {
      // The landscape decision was taken on the live DOM; follow it here so
      // the Word file and the PDF agree on which diagrams get their own page.
      const wrap = cloneSvgs[i].closest('.mermaid-wrap, .excalidraw-wrap');
      const landscape = Boolean(wrap && wrap.dataset.landscape);
      try {
        const { dataUrl, width, height } = await rasterise(
          liveSvgs[i], 2, landscape ? PAGE.wordLandscape : PAGE.word);
        const img = document.createElement('img');
        img.src = dataUrl;
        img.width = width;
        img.height = height;
        cloneSvgs[i].replaceWith(img);
        if (landscape && wrap) markLandscape(wrap);
      } catch {
        cloneSvgs[i].replaceWith(placeholder('diagram could not be exported'));
      }
    }

    // Any remaining image has to travel inside the file.
    for (const img of clone.querySelectorAll('img')) {
      if (!img.src.startsWith('data:')) {
        try {
          img.src = await toDataUrl(img.src);
        } catch {
          img.replaceWith(placeholder(`missing image: ${img.alt || img.getAttribute('src')}`));
          continue;
        }
      }
      if (!img.width) {
        const { w, h } = fit(img.naturalWidth || 400, img.naturalHeight || 300, PAGE.word);
        img.width = w;
        img.height = h;
      }
    }

    // Word reflows <pre>, so each source line becomes its own run.
    for (const pre of clone.querySelectorAll('pre')) {
      const lines = (pre.textContent || '').replace(/\n+$/, '').split('\n');
      const block = document.createElement('div');
      block.setAttribute('style', 'background:#f4f6f8;border:1px solid #dfe3e8;padding:8px;');
      for (const line of lines) {
        const p = document.createElement('p');
        p.setAttribute('style', "font-family:'Cascadia Mono','Consolas',monospace;font-size:9pt;margin:0;");
        // A blank line still has to occupy a line.
        p.textContent = line.length ? line : ' ';
        block.append(p);
      }
      // Without a trailing empty paragraph, consecutive blocks run together.
      const spacer = document.createElement('p');
      spacer.textContent = '\u00a0';
      spacer.setAttribute('style', 'font-size:6pt;margin:0;');
      block.append(spacer);
      pre.replaceWith(block);
    }

    // Word's converter drops tags it does not know — and drops their text with
    // them — so anything exotic is rewritten to something it understands.
    for (const kbd of clone.querySelectorAll('kbd')) {
      const code = document.createElement('code');
      code.textContent = kbd.textContent;
      kbd.replaceWith(code);
    }
    for (const mark of clone.querySelectorAll('mark')) {
      const strong = document.createElement('strong');
      strong.textContent = mark.textContent;
      mark.replaceWith(strong);
    }

    // A checkbox is a form control in HTML and nothing at all in Word.
    for (const box of clone.querySelectorAll('li > input[type="checkbox"]')) {
      const mark = document.createTextNode(box.checked ? '\u2611 ' : '\u2610 ');
      box.replaceWith(mark);
    }

    for (const code of clone.querySelectorAll('code')) {
      code.setAttribute('style', "font-family:'Cascadia Mono','Consolas',monospace;");
    }
    for (const table of clone.querySelectorAll('table')) {
      table.setAttribute('border', '1');
      table.setAttribute('style', 'border-collapse:collapse;width:100%;');
    }
    for (const cell of clone.querySelectorAll('th, td')) {
      cell.setAttribute('style', 'border:1px solid #c6ccd4;padding:4px 8px;');
    }
    for (const quote of clone.querySelectorAll('blockquote')) {
      quote.setAttribute('style', 'border-left:3px solid #c6ccd4;padding-left:12px;color:#444;');
    }

    const heading = title ? `<h1>${escapeHtml(title)}</h1>` : '';
    return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${escapeHtml(title || 'Document')}</title></head>` +
           `<body>${heading}${clone.innerHTML}</body></html>`;
  }

  function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  // A flat list with indentation, rather than nested <ul>s: it survives both
  // Word's converter and the print stylesheet without turning into bullets.
  function buildToc(container) {
    const headings = [...container.querySelectorAll('h1, h2, h3')]
      .map((h) => ({ el: h, label: headingLabel(h) }))
      .filter((h) => h.label);
    if (headings.length < 3) return null;

    const wrap = document.createElement('div');
    const title = document.createElement('h1');
    title.textContent = 'Contents';
    wrap.append(title);

    // Paragraphs rather than <ul>: Word's converter ignores list-style:none
    // and turns a styled list into bullets.
    const base = Math.min(...headings.map((h) => Number(h.el.tagName[1])));
    for (const { el: heading, label } of headings) {
      const depth = Number(heading.tagName[1]) - base;
      const line = document.createElement('p');
      line.setAttribute('style',
        `margin:3px 0;margin-left:${depth * 22}px;${depth === 0 ? 'font-weight:bold;' : ''}`);
      const link = document.createElement('a');
      link.href = `#${heading.id}`;
      link.textContent = label;
      line.append(link);
      wrap.append(line);
    }

    wrap.append(pageBreak());
    return wrap;
  }

  // Headings carry a "#" permalink in the viewer; it is not part of the title.
  function headingLabel(heading) {
    const copy = heading.cloneNode(true);
    copy.querySelectorAll('.anchor').forEach((n) => n.remove());
    return copy.textContent.trim();
  }

  // An explicit break paragraph: `break-before` on a container is honoured by
  // the print engine but not by Word's converter.
  function pageBreak() {
    const brk = document.createElement('p');
    brk.setAttribute('style',
      'page-break-before:always;break-before:page;margin:0;font-size:1pt;line-height:1pt;');
    brk.textContent = '\u00a0';
    return brk;
  }

  window.DocExport = { buildHtml, buildToc, pageBreak, fitDiagrams };
})();
