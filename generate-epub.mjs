/*
 * generate-epub.mjs
 * node generate-epub.mjs
 *
 * Environment variables expected:
 *   JSON_URL, OUTPUT_FILENAME, BOOK_TITLE, BOOK_AUTHOR, BOOK_DESC
 */
import axios   from 'axios';
import JSZip   from 'jszip';
import fs      from 'fs';
import path    from 'path';

// ---------- helpers ----------
function html(title, body) {
  return `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
xmlns="http://www.w3.org/1999/xhtml"
<head>
  <title>${title}</title>
  <meta charset="utf-8"/>
</head>
<body>
${body}
</body>
</html>`;
}

function xmlEscape(str) {
  return str.replace(/[<>&'"]/g, c =>
    ({'<':'&lt;','>':'&gt;','&':'&amp;','\'':'&apos;','"':'&quot;'}[c]));
}

// ---------- fetch data ----------
const { data: chapters } = await axios.get(process.env.JSON_URL);

// ---------- prepare content ----------
const mapped = chapters.map((c, idx) => {
  // same cleaning logic you already had
  let raw = c.content.replace(/\\n/g, '\n')
                     .replace(/\n{2,}/g, '\n\n');
  const paragraphs = raw
    .split(/\n{2,}/)
    .map(p => `<p>${xmlEscape(p.trim())}</p>`)
    .join('\n');

  const id   = `c${idx + 1}`;
  const file = `${id}.xhtml`;
  return { title: c.title, body: paragraphs, id, file };
});

// ---------- ZIP / EPUB ----------
const zip = new JSZip();

// mimetype (must be first & uncompressed)
zip.file('mimetype', 'application/epub+zip', { compression: 'STORE' });

// META-INF/container.xml
zip.folder('META-INF').file('container.xml', `<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>`);

const OEBPS = zip.folder('OEBPS');

// cover
let coverMime = null;
if (fs.existsSync('cover.jpg')) {
  coverMime = 'image/jpeg';
  OEBPS.file('cover.jpg', fs.readFileSync('cover.jpg'));
} else if (fs.existsSync('cover.jpeg')) {
  coverMime = 'image/jpeg';
  OEBPS.file('cover.jpeg', fs.readFileSync('cover.jpeg'));
}

// chapters
mapped.forEach(ch => {
  OEBPS.file(ch.file, html(ch.title, ch.body));
});

// content.opf
const opf = `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" xml:lang="en" unique-identifier="uid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/   ">
    <dc:identifier id="uid">urn:uuid:${crypto.randomUUID()}</dc:identifier>
    <dc:title>${xmlEscape(process.env.BOOK_TITLE)}</dc:title>
    <dc:creator>${xmlEscape(process.env.BOOK_AUTHOR)}</dc:creator>
    <dc:description>${xmlEscape(process.env.BOOK_DESC)}</dc:description>
    <dc:language>en</dc:language>
${coverMime ? '<meta name="cover" content="cover-img"/>' : ''}
<meta property="dcterms:modified">${new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')}</meta>
  </metadata>
  <manifest>
${coverMime ? `<item id="cover-img" href="cover.jpg" media-type="${coverMime}" properties="cover-image"/>` : ''}
${mapped.map(ch => `    <item id="${ch.id}" href="${ch.file}" media-type="application/xhtml+xml"/>`).join('\n')}
 <item id="toc"  href="toc.xhtml"  media-type="application/xhtml+xml" properties="nav"/>
 <item id="ncx"  href="toc.ncx"    media-type="application/x-dtbncx+xml"/>
  </manifest>
  <spine toc="ncx">
${mapped.map(ch => `    <itemref idref="${ch.id}"/>`).join('\n')}
  </spine>
</package>`;
OEBPS.file('content.opf', opf);
// Navigation Document (OEBPS/toc.xhtml)
function navToc(chapters) {
  const lis = chapters.map((c, idx) =>
    `<li><a href="${c.file}">${xmlEscape(c.title)}</a></li>`).join('\n');

  return `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
<head>
  <title>Table of Contents</title>
</head>
<body>
  <nav epub:type="toc" id="toc">
    <h1>Table of Contents</h1>
    <ol>${lis}</ol>
  </nav>
</body>
</html>`;
}
OEBPS.file('toc.xhtml', navToc(mapped));
// legacy noc
function ncxToc(chapters) {
  const navPoints = chapters.map((c, idx) => `
  <navPoint id="np-${c.id}" playOrder="${idx + 1}">
    <navLabel><text>${xmlEscape(c.title)}</text></navLabel>
    <content src="${c.file}"/>
  </navPoint>`).join('\n');

  return `<?xml version="1.0" encoding="utf-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
  <head>
    <meta name="dtb:uid" content="urn:uuid:${crypto.randomUUID()}"/>
    <meta name="dtb:depth" content="1"/>
    <meta name="dtb:totalPageCount" content="0"/>
    <meta name="dtb:maxPageNumber" content="0"/>
  </head>
  <docTitle><text>${xmlEscape(process.env.BOOK_TITLE)}</text></docTitle>
  <navMap>${navPoints}</navMap>
</ncx>`;
}
OEBPS.file('toc.ncx', ncxToc(mapped));


// ---------- write file ----------
const safeName = process.env.OUTPUT_FILENAME.replace(/\s+/g, '-');
await fs.promises.mkdir('results', { recursive: true });
const buffer = await zip.generateAsync({
  type: 'nodebuffer',
  compression: 'DEFLATE',
  compressionOptions: { level: 9 }
});
await fs.promises.writeFile(`results/${safeName}.epub`, buffer);
console.log(`✅ Created results/${safeName}.epub`);
