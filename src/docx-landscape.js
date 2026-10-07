'use strict';

/**
 * Turns the sentinel paragraphs the renderer emits around a wide diagram into
 * real Word section breaks, so that diagram gets a landscape page of its own.
 *
 * Word has no per-element orientation: orientation belongs to a section. A
 * paragraph whose pPr carries a sectPr *ends* a section, so a landscape page
 * is made by closing the portrait section before the figure and closing a
 * landscape section after it.
 */

const JSZip = require('jszip');

const DOCUMENT = 'word/document.xml';
const START = '[[MDV-LANDSCAPE-START]]';
const END = '[[MDV-LANDSCAPE-END]]';

// Finds the <w:p> element that contains `marker` and swaps it for `replacement`.
function replaceParagraphContaining(xml, marker, replacement) {
  const at = xml.indexOf(marker);
  if (at === -1) return null;

  const open = Math.max(xml.lastIndexOf('<w:p>', at), xml.lastIndexOf('<w:p ', at));
  const close = xml.indexOf('</w:p>', at);
  if (open === -1 || close === -1) return null;

  return xml.slice(0, open) + replacement + xml.slice(close + '</w:p>'.length);
}

function toLandscape(sectPr) {
  return sectPr.replace(
    /<w:pgSz\b([^>]*)\/>/,
    (whole, attrs) => {
      const width = (attrs.match(/w:w="(\d+)"/) || [])[1];
      const height = (attrs.match(/w:h="(\d+)"/) || [])[1];
      if (!width || !height) return whole;
      return `<w:pgSz w:w="${height}" w:h="${width}" w:orient="landscape"/>`;
    });
}

async function applyLandscapeSections(buffer) {
  const zip = await JSZip.loadAsync(buffer);
  const file = zip.file(DOCUMENT);
  if (!file) return { buffer, sections: 0 };

  let xml = await file.async('string');
  if (!xml.includes(START)) return { buffer, sections: 0 };

  const found = xml.match(/<w:sectPr\b[\s\S]*?<\/w:sectPr>/);
  if (!found) return { buffer, sections: 0 };
  const portrait = found[0];
  const landscape = toLandscape(portrait);
  if (landscape === portrait) return { buffer, sections: 0 };

  // html-to-docx writes the body's sectPr first; OOXML wants the final section
  // properties last, and section breaks only read correctly from there.
  xml = xml.replace(portrait, '');
  xml = xml.replace('</w:body>', `${portrait}\n</w:body>`);

  let sections = 0;
  for (;;) {
    const opened = replaceParagraphContaining(
      xml, START, `<w:p><w:pPr>${portrait}</w:pPr></w:p>`);
    if (!opened) break;
    const closed = replaceParagraphContaining(
      opened, END, `<w:p><w:pPr>${landscape}</w:pPr></w:p>`);
    if (!closed) break;
    xml = closed;
    sections++;
  }

  if (!sections) return { buffer, sections: 0 };

  zip.file(DOCUMENT, xml);
  const out = await zip.generateAsync({
    type: 'nodebuffer',
    compression: 'DEFLATE',
    compressionOptions: { level: 6 },
  });
  return { buffer: out, sections };
}

module.exports = { applyLandscapeSections, START, END };
