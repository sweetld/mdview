'use strict';

/**
 * html-to-docx writes each image into the archive roughly twice and leaves one
 * copy with no relationship pointing at it, so a folder export carries several
 * hundred KB of parts Word never reads. This strips the orphans and collapses
 * byte-identical images onto a single part.
 *
 * Media parts are covered by a <Default Extension="png"> content type rather
 * than per-part overrides, so removing a part needs no [Content_Types] edit.
 */

const crypto = require('crypto');
const JSZip = require('jszip');

const DOCUMENT = 'word/document.xml';
const RELS = 'word/_rels/document.xml.rels';
const RELATIONSHIP = /<Relationship\b[\s\S]*?(?:\/>|<\/Relationship>)/g;

function attr(tag, name) {
  const found = tag.match(new RegExp(`${name}="([^"]*)"`));
  return found ? found[1] : null;
}

async function dedupeDocxMedia(buffer) {
  const zip = await JSZip.loadAsync(buffer);
  const documentFile = zip.file(DOCUMENT);
  const relsFile = zip.file(RELS);
  if (!documentFile || !relsFile) return { buffer, removed: 0, saved: 0 };

  const documentXml = await documentFile.async('string');
  const relsXml = await relsFile.async('string');

  // Every relationship id the document body actually draws.
  const referenced = new Set();
  for (const match of documentXml.matchAll(/r:(?:embed|link)="([^"]+)"/g)) {
    referenced.add(match[1]);
  }

  const tags = relsXml.match(RELATIONSHIP) || [];
  const kept = [];
  const canonical = new Map();  // content hash -> the part everyone will share
  const liveParts = new Set();
  let removed = 0;

  for (const tag of tags) {
    const type = attr(tag, 'Type') || '';
    if (!type.endsWith('/image')) {
      kept.push(tag);
      continue;
    }

    const id = attr(tag, 'Id');
    const target = attr(tag, 'Target') || '';
    const part = `word/${target.replace(/^\.?\//, '')}`;
    const file = zip.file(part);

    // Orphaned: no r:embed anywhere names this id.
    if (!referenced.has(id)) {
      removed++;
      continue;
    }
    if (!file) {
      kept.push(tag);
      continue;
    }

    const data = await file.async('nodebuffer');
    const hash = crypto.createHash('sha256').update(data).digest('hex');

    if (!canonical.has(hash)) {
      canonical.set(hash, part);
      liveParts.add(part);
      kept.push(tag);
    } else {
      const share = canonical.get(hash);
      liveParts.add(share);
      if (part !== share) removed++;
      kept.push(tag.replace(/Target="[^"]*"/, `Target="${share.replace(/^word\//, '')}"`));
    }
  }

  // Anything not now pointed at by a surviving relationship goes.
  let saved = 0;
  for (const name of Object.keys(zip.files)) {
    if (!name.startsWith('word/media/') || zip.files[name].dir) continue;
    if (liveParts.has(name)) continue;
    saved += (await zip.file(name).async('nodebuffer')).length;
    zip.remove(name);
  }

  if (!removed && !saved) return { buffer, removed: 0, saved: 0 };

  // `<Relationship` also matches the `<Relationships>` root, so the split has
  // to look for a child element specifically — otherwise the root opening tag
  // is sliced away and Word refuses to open the file.
  const firstChild = relsXml.search(/<Relationship\s/);
  const closing = relsXml.lastIndexOf('</Relationships>');
  if (firstChild === -1 || closing === -1) return { buffer, removed: 0, saved: 0 };

  const rewritten = relsXml.slice(0, firstChild) + kept.join('') + relsXml.slice(closing);

  // Never hand back something structurally worse than we were given.
  if (!rewritten.includes('<Relationships') || !rewritten.trimEnd().endsWith('</Relationships>')) {
    return { buffer, removed: 0, saved: 0 };
  }
  zip.file(RELS, rewritten);

  const out = await zip.generateAsync({
    type: 'nodebuffer',
    compression: 'DEFLATE',
    compressionOptions: { level: 6 },
  });
  return { buffer: out, removed, saved };
}

module.exports = { dedupeDocxMedia };
