#!/usr/bin/env node
/**
 * generate-epub.mjs
 * node generate-epub.mjs
 *
 * Environment variables:
 *   JSON_URL, OUTPUT_FILENAME, BOOK_TITLE, BOOK_AUTHOR, BOOK_DESC
 * Optional:
 *   DRY_RUN=1
 */
import axios from 'axios';
import JSZip from 'jszip';
import fs from 'fs';
import path from 'path';
import { pipeline } from 'stream/promises';
import crypto from 'crypto';

/* ---------- helpers ---------- */
const xmlEscape = s =>
  s.replace(/[<>&'"]/g, c =>
    ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]));

const minifyCSS = css =>
  css
    .replace(/\s*([{}:;,>+~])\s*/g, '$1')
    .replace(/\s{2,}/g, ' ')
    .trim();

const minifyHTML = html =>
  html
    .replace(/\s{2,}/g, ' ')
    .replace(/>\s+</g, '><')
    .trim();

const html = (title, body) => minifyHTML(`<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml">
<head>
  <title>${xmlEscape(title)}</title>
  <meta charset="utf-8"/>
  <link rel="stylesheet" type="text/css" href="styles.css"/>
</head>
<body>
${body}
</body>
</html>`);

const css = minifyCSS(`
body{margin:0;padding:0;font-family:serif;line-height:1.5}
h1,h2,h3{font-family:sans-serif}
p{margin:0 0 1em;text-align:justify}
img{max-width:100%;height:auto}
`);

/* ---------- validation ---------- */
const env = (({
  JSON_URL,
  OUTPUT_FILENAME,
  BOOK_TITLE,
  BOOK_AUTHOR,
  BOOK_DESC,
}) => {
  const missing = Object.entries({
    JSON_URL,
    OUTPUT_FILENAME,
    BOOK_TITLE,
    BOOK_AUTHOR,
    BOOK_DESC,
  })
    .filter(([, v]) => !v)
    .map(([k]) => k);
  if (missing.length) {
    console.error('❌ Missing environment variables:', missing.join(', '));
    process.exit(1);
  }
  return { JSON_URL, OUTPUT_FILENAME, BOOK_TITLE, BOOK_AUTHOR, BOOK_DESC };
})(process.env);

/* ---------- fetch data ---------- */
const { data: chapters } = await axios.get(env.JSON_URL).catch(e => {
  console.error('❌ Could not fetch JSON_URL:', e.message);
  process.exit(1);
});

if (!Array.isArray(chapters) || !chapters.every(c => c.title && c.content)) {
  console.error('❌ JSON must be [{title, content}, …]');
  process.exit(1);
}

/* ---------- prepare content ---------- */
const mapped = chapters.map((c, idx) => {
  const paragraphs = c.content
    .replace(/\\n/g, '\n')
    .split(/\n{2,}/)
    .map(p => `<p>${xmlEscape(p.trim())}</p>`)
    .join('');
  const id = `c${idx + 1}`;
  const file = `${id}.xhtml`;
  return { ...c, body: paragraphs, id, file };
});

/* ---------- ZIP / EPUB ---------- */
const zip = new JSZip();

/* mimetype (must be first & uncompressed) */
zip.file('mimetype', 'application/epub+zip', { compression: 'STORE' });

/* META-INF/container.xml */
zip.folder('META-INF').file('container.xml', `<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>`);

const OEBPS = zip.folder('OEBPS');
OEBPS.file('styles.css', css);

/* cover image detection */
let coverFileName = null;
let coverMime = null;
for (const ext of ['jpg', 'jpeg', 'png']) {
  const fn = `cover.${ext}`;
  if (fs.existsSync(fn)) {
    coverFileName = fn;
    coverMime = ext === 'png' ? 'image/png' : 'image/jpeg';
    OEBPS.file(coverFileName, fs.createReadStream(fn));
    break;
  }
}

/* cover page */
let coverXhtml = null;
if (coverFileName) {
  coverXhtml = 'cover.xhtml';
  OEBPS.file(
    coverXhtml,
    html('Cover', `<img src="${coverFileName}" alt="Cover"/>`),
  );
}

/* chapters */
await Promise.all(
  mapped.map(ch =>
    OEBPS.file(ch.file, html(ch.title, ch.body)),
  ),
);

/* toc.xhtml */
const navToc = html(
  'Table of Contents',
  `
<nav epub:type="toc" id="toc">
  <h1>Table of Contents</h1>
  <ol>
${mapped
  .map(c => `    <li><a href="${c.file}">${xmlEscape(c.title)}</a></li>`)
  .join('\n')}
  </ol>
</nav>`,
);

OEBPS.file('toc.xhtml', navToc);

/* ---------- content.opf ---------- */
const uuid = crypto.randomUUID();
const manifestItems = [
  ...(coverFileName
    ? [`    <item id="cover-img" href="${coverFileName}" media-type="${coverMime}" properties="cover-image"/>`]
    : []),
  ...(coverXhtml
    ? [`    <item id="cover"     href="${coverXhtml}"    media-type="application/xhtml+xml"/>`]
    : []),
  `    <item id="styles" href="styles.css" media-type="text/css"/>`,
  ...mapped.map(
    ch => `    <item id="${ch.id}" href="${ch.file}" media-type="application/xhtml+xml"/>`,
  ),
  `    <item id="toc"    href="toc.xhtml" media-type="application/xhtml+xml" properties="nav"/>`,
].join('\n');

const spineItemrefs = [
  ...(coverXhtml ? [`    <itemref idref="cover"/>`] : []),
  ...mapped.map(ch => `    <itemref idref="${ch.id}"/>`),
].join('\n');

const opf = `
<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" xml:lang="en" unique-identifier="uid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="uid">urn:uuid:${uuid}</dc:identifier>
    <dc:title>${xmlEscape(env.BOOK_TITLE)}</dc:title>
    <dc:creator>${xmlEscape(env.BOOK_AUTHOR)}</dc:creator>
    <dc:description>${xmlEscape(env.BOOK_DESC)}</dc:description>
    <dc:language>en</dc:language>
    ${coverFileName ? '<meta name="cover" content="cover-img"/>' : ''}
    <meta property="dcterms:modified">${new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')}</meta>
  </metadata>
  <manifest>
${manifestItems}
  </manifest>
  <spine>
${spineItemrefs}
  </spine>
${coverXhtml ? `  <guide>
    <reference type="cover" title="Cover" href="${coverXhtml}"/>
  </guide>` : ''}
</package>`;

OEBPS.file('content.opf', opf);

/* ---------- write file ---------- */
const safeName = env.OUTPUT_FILENAME.replace(/\s+/g, '-');
await fs.promises.mkdir('results', { recursive: true });
const dest = `results/${safeName}.epub`;

if (process.env.DRY_RUN === '1') {
  console.log(`🏜️  Dry-run complete – would have written: ${dest}`);
} else {
  const buffer = await zip.generateAsync({
    type: 'nodebuffer',
    compression: 'DEFLATE',
    compressionOptions: { level: 9 },
  });
  await fs.promises.writeFile(dest, buffer);
  console.log(`✅ Created ${dest}`);
      }
