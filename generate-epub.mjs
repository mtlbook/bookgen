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
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
<head>
  <title>${xmlEscape(title)}</title>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <style type="text/css">
    body { margin: 5% auto; max-width: 40em; line-height: 1.6; font-size: 1.1em; }
    h1 { text-align: center; margin-bottom: 2em; }
    p { text-align: justify; hyphens: auto; }
  </style>
</head>
<body>
${body}
</body>
</html>`;
}

// ---------- fetch data ----------
let chapters = [];
try {
  const response = await axios.get(process.env.JSON_URL);
  chapters = response.data;
  
  if (!Array.isArray(chapters)) {
    throw new Error('Fetched data is not an array');
  }
} catch (error) {
  console.error('Error fetching chapters:', error.message);
  process.exit(1);
}

// ---------- prepare content ----------
const mapped = chapters.map((c, idx) => {  // Only declare this once
  let raw = c.content.replace(/\\n/g, '\n')
                     .replace(/\n{2,}/g, '\n\n');
  const paragraphs = raw
    .split(/\n{2,}/)
    .map(p => `<p>${xmlEscape(p.trim())}</p>`)
    .join('\n');

  const id   = `c${idx + 1}`;
  const file = `${id}.xhtml`;
  return { 
    title: c.title, 
    body: `<h1>${xmlEscape(c.title)}</h1>\n${paragraphs}`, 
    id, 
    file 
  };
});

// ---------- Enhanced EPUB Features ----------
// Add table of contents (nav.xhtml)
const toc = `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
<head>
  <title>Table of Contents</title>
  <meta charset="utf-8"/>
</head>
<body>
  <nav epub:type="toc">
    <h1>Table of Contents</h1>
    <ol>
      ${mapped.map(ch => `<li><a href="${ch.file}">${xmlEscape(ch.title)}</a></li>`).join('\n      ')}
    </ol>
  </nav>
</body>
</html>`;

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

// Add CSS file for consistent styling
OEBPS.file('styles.css', `body {
  margin: 5% auto;
  max-width: 40em;
  line-height: 1.6;
  font-size: 1.1em;
  font-family: serif;
  color: #333;
}

h1 {
  text-align: center;
  margin-bottom: 2em;
  font-size: 1.5em;
  page-break-after: avoid;
}

p {
  text-align: justify;
  hyphens: auto;
  margin: 0 0 1em 0;
  page-break-inside: avoid;
  widows: 2;
  orphans: 2;
}`);

// cover
if (fs.existsSync('cover.jpg')) {
  OEBPS.file('cover.jpg', fs.readFileSync('cover.jpg'));
  // Add cover XHTML
  OEBPS.file('cover.xhtml', html('Cover', `
    <section id="cover">
      <img src="cover.jpg" alt="Cover" style="height: 100%; width: auto; max-width: 100%;"/>
    </section>
  `));
}

// chapters
mapped.forEach(ch => {
  OEBPS.file(ch.file, html(ch.title, ch.body));
});

// Add table of contents
OEBPS.file('nav.xhtml', toc);

// content.opf - Enhanced version
const today = new Date();
const opf = `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="uid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:opf="http://www.idpf.org/2007/opf">
    <dc:identifier id="uid">urn:uuid:${crypto.randomUUID()}</dc:identifier>
    <dc:title>${xmlEscape(process.env.BOOK_TITLE)}</dc:title>
    <dc:creator id="creator">${xmlEscape(process.env.BOOK_AUTHOR)}</dc:creator>
    <dc:language>en</dc:language>
    <dc:description>${xmlEscape(process.env.BOOK_DESC)}</dc:description>
    <dc:publisher>Generated EPUB</dc:publisher>
    <dc:date>${today.toISOString()}</dc:date>
    <meta property="dcterms:modified">${today.toISOString()}</meta>
    ${fs.existsSync('cover.jpg') ? `
    <meta name="cover" content="cover-image"/>
    <meta property="rendition:cover">cover.xhtml</meta>` : ''}
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="css" href="styles.css" media-type="text/css"/>
    ${fs.existsSync('cover.jpg') ? `
    <item id="cover-image" href="cover.jpg" media-type="image/jpeg" properties="cover-image"/>
    <item id="cover" href="cover.xhtml" media-type="application/xhtml+xml"/>` : ''}
    ${mapped.map(ch => `
    <item id="${ch.id}" href="${ch.file}" media-type="application/xhtml+xml"/>`).join('')}
  </manifest>
  <spine toc="nav">
    ${fs.existsSync('cover.jpg') ? '<itemref idref="cover" linear="no"/>' : ''}
    ${mapped.map(ch => `
    <itemref idref="${ch.id}"/>`).join('')}
  </spine>
  <guide>
    ${fs.existsSync('cover.jpg') ? '<reference type="cover" title="Cover" href="cover.xhtml"/>' : ''}
    <reference type="toc" title="Table of Contents" href="nav.xhtml"/>
  </guide>
</package>`;

OEBPS.file('content.opf', opf);

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
