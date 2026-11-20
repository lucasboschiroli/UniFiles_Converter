// Ebooks. EPUB and FB2 are read, and EPUB is written, right here; Kindle
// formats (AZW3, MOBI) go through Calibre's ebook-convert when it's installed.
//
// Everything is turned into a simple "book": { title, author, lang,
// chapters: [{ title, html }] } with images inlined as data: URIs.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { unzipSync, zipSync, strToU8, strFromU8 } = require('fflate');
const host = require('./host');
const { findCalibre, runTool } = require('../tools');

const MIME = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', avif: 'image/avif', bmp: 'image/bmp' };
const escapeXml = (s) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const decodeEntities = (s) => String(s || '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n))).replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16))).replace(/&amp;/g, '&');
const attr = (tag, name) => { const m = new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, 'i').exec(tag); return m ? decodeEntities(m[2] ?? m[3]) : null; };
const stripTags = (s) => decodeEntities(String(s || '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();

// ------------------------------------------------------------------ EPUB in
function readEpub(src) {
    let files;
    try {
        files = unzipSync(new Uint8Array(fs.readFileSync(src)));
    } catch {
        throw new Error('The file is damaged or isn\'t really an EPUB.');
    }
    const text = (p) => (files[p] ? strFromU8(files[p]) : null);

    // DRM: Adobe/Apple/Kindle-style encryption of the content (font obfuscation is fine).
    const enc = text('META-INF/encryption.xml');
    if (enc && /<EncryptedData/i.test(enc) && !/http:\/\/www\.idpf\.org\/2008\/embedding|http:\/\/ns\.adobe\.com\/pdf\/enc#RC/i.test(enc)) {
        throw new Error('This ebook is DRM-protected, so it can\'t be converted.');
    }

    const container = text('META-INF/container.xml') || '';
    const opfPath = attr((/<rootfile\b[^>]*>/i.exec(container) || [''])[0], 'full-path');
    const opf = opfPath && text(opfPath);
    if (!opf) throw new Error('The file is damaged or isn\'t really an EPUB.');
    const base = path.posix.dirname(opfPath);
    const resolve = (from, href) => path.posix.normalize(path.posix.join(from === '.' ? '' : from, decodeURIComponent(href.split('#')[0])));

    const manifest = {};
    for (const tag of opf.match(/<item\b[^>]*>/gi) || []) {
        manifest[attr(tag, 'id')] = { href: resolve(base, attr(tag, 'href') || ''), type: attr(tag, 'media-type') || '', props: attr(tag, 'properties') || '' };
    }
    const spine = (opf.match(/<itemref\b[^>]*>/gi) || [])
        .filter((t) => attr(t, 'linear') !== 'no')
        .map((t) => manifest[attr(t, 'idref')])
        .filter((m) => m && /html|xml/.test(m.type));

    // Chapter names from the table of contents (EPUB 3 nav, else EPUB 2 NCX).
    const tocNames = {};
    const nav = Object.values(manifest).find((m) => /\bnav\b/.test(m.props));
    const ncx = Object.values(manifest).find((m) => m.type === 'application/x-dtbncx+xml');
    if (nav && text(nav.href)) {
        for (const a of text(nav.href).match(/<a\b[^>]*href=[^>]*>[\s\S]*?<\/a>/gi) || []) {
            const href = resolve(path.posix.dirname(nav.href), attr(a, 'href') || '');
            if (!tocNames[href]) tocNames[href] = stripTags(a);
        }
    } else if (ncx && text(ncx.href)) {
        for (const p of text(ncx.href).match(/<navPoint\b[\s\S]*?<content\b[^>]*>/gi) || []) {
            const label = stripTags((/<text>([\s\S]*?)<\/text>/i.exec(p) || [])[1]);
            const href = resolve(path.posix.dirname(ncx.href), attr((/<content\b[^>]*>/i.exec(p) || [''])[0], 'src') || '');
            if (label && !tocNames[href]) tocNames[href] = label;
        }
    }

    const dataUri = (p) => {
        const data = files[p];
        if (!data) return null;
        const ext = path.posix.extname(p).slice(1).toLowerCase();
        return `data:${MIME[ext] || 'application/octet-stream'};base64,${Buffer.from(data).toString('base64')}`;
    };

    const chapters = spine.map((item) => {
        let html = text(item.href) || '';
        const body = /<body\b[^>]*>([\s\S]*)<\/body>/i.exec(html);
        html = body ? body[1] : html;
        const dir = path.posix.dirname(item.href);
        // Inline pictures (img src, SVG href / xlink:href) so the book is self-contained.
        html = html.replace(/<script[\s\S]*?<\/script>/gi, '')
            .replace(/(<img\b[^>]*?\bsrc\s*=\s*)(["'])([^"']+)\2/gi, (m, pre, q, src) => (/^(data|https?):/i.test(src) ? m : `${pre}${q}${dataUri(resolve(dir, src)) || src}${q}`))
            .replace(/(<image\b[^>]*?\b(?:xlink:)?href\s*=\s*)(["'])([^"']+)\2/gi, (m, pre, q, src) => (/^(data|https?):/i.test(src) ? m : `${pre}${q}${dataUri(resolve(dir, src)) || src}${q}`));
        const heading = /<h[1-3]\b[^>]*>([\s\S]*?)<\/h[1-3]>/i.exec(html);
        return { title: tocNames[item.href] || (heading ? stripTags(heading[1]) : ''), html };
    });

    const meta = (name) => stripTags((new RegExp(`<dc:${name}\\b[^>]*>([\\s\\S]*?)<\\/dc:${name}>`, 'i').exec(opf) || [])[1]);
    return {
        title: meta('title') || path.basename(src, path.extname(src)),
        author: meta('creator'),
        lang: meta('language') || 'en',
        chapters: chapters.filter((c) => stripTags(c.html) || /<(img|image|svg)\b/i.test(c.html)),
    };
}

// ------------------------------------------------------------------- FB2 in
function readFb2(src) {
    const raw = fs.readFileSync(src);
    // FictionBook files are often in Windows-1251 (Cyrillic) rather than UTF-8.
    const declared = (/encoding=["']([\w-]+)["']/i.exec(raw.subarray(0, 200).toString('latin1')) || [])[1] || 'utf-8';
    let xml;
    try { xml = new TextDecoder(declared.toLowerCase()).decode(raw); } catch { xml = raw.toString('utf8'); }
    if (!/<FictionBook\b/i.test(xml)) throw new Error('The file is damaged or isn\'t really an FB2 book.');

    const binaries = {};
    for (const m of xml.matchAll(/<binary\b([^>]*)>([\s\S]*?)<\/binary>/gi)) {
        binaries[attr(m[1], 'id')] = `data:${attr(m[1], 'content-type') || 'image/jpeg'};base64,${m[2].replace(/\s+/g, '')}`;
    }
    const titleInfo = (/<title-info>([\s\S]*?)<\/title-info>/i.exec(xml) || [])[1] || '';
    const author = ['first-name', 'middle-name', 'last-name']
        .map((t) => stripTags((new RegExp(`<${t}>([\\s\\S]*?)<\\/${t}>`, 'i').exec((/<author>([\s\S]*?)<\/author>/i.exec(titleInfo) || [])[1] || '') || [])[1]))
        .filter(Boolean).join(' ');

    const toHtml = (s) => s
        .replace(/<image\b[^>]*?href\s*=\s*["']#([^"']+)["'][^>]*\/?>/gi, (_, id) => (binaries[id] ? `<img src="${binaries[id]}" alt=""/>` : ''))
        .replace(/<title\b[^>]*>([\s\S]*?)<\/title>/gi, (_, t) => `<h2>${stripTags(t)}</h2>`)
        .replace(/<subtitle\b[^>]*>/gi, '<h3>').replace(/<\/subtitle>/gi, '</h3>')
        .replace(/<emphasis\b[^>]*>/gi, '<em>').replace(/<\/emphasis>/gi, '</em>')
        .replace(/<strikethrough\b[^>]*>/gi, '<s>').replace(/<\/strikethrough>/gi, '</s>')
        .replace(/<empty-line\s*\/>/gi, '<br/>')
        .replace(/<(epigraph|cite|annotation)\b[^>]*>/gi, '<blockquote>').replace(/<\/(epigraph|cite|annotation)>/gi, '</blockquote>')
        .replace(/<poem\b[^>]*>|<stanza\b[^>]*>/gi, '<div class="poem">').replace(/<\/poem>|<\/stanza>/gi, '</div>')
        .replace(/<v\b[^>]*>/gi, '<p class="verse">').replace(/<\/v>/gi, '</p>')
        .replace(/<text-author\b[^>]*>/gi, '<p class="author">').replace(/<\/text-author>/gi, '</p>')
        .replace(/<\/?(section|body)\b[^>]*>/gi, '')
        .replace(/<a\b[^>]*>([\s\S]*?)<\/a>/gi, '$1');

    // Each top-level section is a chapter (notes bodies are skipped).
    const mainBody = (/<body(?![^>]*name=["']notes["'])[^>]*>([\s\S]*?)<\/body>/i.exec(xml) || [])[1] || '';
    const sections = mainBody.split(/<section\b[^>]*>/i).slice(1);
    const parts = sections.length ? sections : [mainBody];
    const chapters = parts.map((s) => {
        const t = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(s);
        return { title: t ? stripTags(t[1]) : '', html: toHtml(s) };
    }).filter((c) => stripTags(c.html) || /<img\b/.test(c.html));

    const cover = (/<coverpage>[\s\S]*?href\s*=\s*["']#([^"']+)["']/i.exec(titleInfo) || [])[1];
    if (cover && binaries[cover] && chapters.length) chapters[0].html = `<p class="cover"><img src="${binaries[cover]}" alt=""/></p>` + chapters[0].html;

    return {
        title: stripTags((/<book-title>([\s\S]*?)<\/book-title>/i.exec(titleInfo) || [])[1]) || path.basename(src, path.extname(src)),
        author,
        lang: stripTags((/<lang>([\s\S]*?)<\/lang>/i.exec(titleInfo) || [])[1]) || 'en',
        chapters,
    };
}

// --------------------------------------------------------- book -> outputs
const BOOK_CSS = `
    body { font-family: Georgia, 'Times New Roman', serif; font-size: 12pt; line-height: 1.55; color: #1a1a1a; margin: 0; }
    h1, h2, h3 { font-family: 'Segoe UI', Arial, sans-serif; line-height: 1.25; }
    img { max-width: 100%; height: auto; }
    blockquote { margin: 1em 2em; font-style: italic; }
    .chapter { page-break-before: always; }
    .chapter:first-of-type { page-break-before: auto; }
    .book-title { text-align: center; margin: 30% 0 0.4em; font-size: 26pt; }
    .book-author { text-align: center; font-size: 14pt; color: #555; }
    .verse { margin: 0; } .poem { margin: 1em 2em; }`;

function bookToHtml(book) {
    const head = `<h1 class="book-title">${escapeXml(book.title)}</h1>${book.author ? `<p class="book-author">${escapeXml(book.author)}</p>` : ''}`;
    const body = book.chapters.map((c) => `<section class="chapter">${c.html}</section>`).join('\n');
    return `<!DOCTYPE html><html lang="${escapeXml(book.lang || 'en')}"><head><meta charset="utf-8"><title>${escapeXml(book.title)}</title><style>${BOOK_CSS}</style></head><body><section class="chapter">${head}</section>${body}</body></html>`;
}

// Reflowable EPUB 3 (with an EPUB 2 NCX so older readers get a table of contents too).
async function writeEpub(book, out) {
    const id = `urn:uuid:${crypto.randomUUID()}`;
    const files = { mimetype: [strToU8('application/epub+zip'), { level: 0 }] };
    files['META-INF/container.xml'] = strToU8('<?xml version="1.0" encoding="UTF-8"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>');
    files['OEBPS/style.css'] = strToU8(BOOK_CSS.replace(/\.chapter[^}]*}/g, ''));

    // Pull inlined pictures back out into real files (EPUB readers expect that).
    const images = [];
    const extract = (html) => html.replace(/data:(image\/[\w+.-]+);base64,([A-Za-z0-9+/=]+)/g, (_, mime, b64) => {
        const ext = { 'image/jpeg': 'jpg', 'image/svg+xml': 'svg' }[mime] || mime.split('/')[1];
        const name = `img${String(images.length + 1).padStart(4, '0')}.${ext}`;
        images.push({ name, mime });
        files[`OEBPS/images/${name}`] = [Buffer.from(b64, 'base64'), { level: 0 }];
        return `images/${name}`;
    });

    const chapters = [];
    for (const [i, c] of book.chapters.entries()) {
        const body = extract(await host.htmlToXhtml(c.html));
        const title = c.title || `Chapter ${i + 1}`;
        const name = `ch${String(i + 1).padStart(3, '0')}.xhtml`;
        files[`OEBPS/${name}`] = strToU8(`<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE html>\n<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="${escapeXml(book.lang)}" xml:lang="${escapeXml(book.lang)}"><head><title>${escapeXml(title)}</title><link rel="stylesheet" type="text/css" href="style.css"/></head><body>${body}</body></html>`);
        chapters.push({ name, title });
    }

    files['OEBPS/nav.xhtml'] = strToU8(`<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE html>\n<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>Contents</title></head><body><nav epub:type="toc" id="toc"><h1>Contents</h1><ol>${chapters.map((c) => `<li><a href="${c.name}">${escapeXml(c.title)}</a></li>`).join('')}</ol></nav></body></html>`);
    files['OEBPS/toc.ncx'] = strToU8(`<?xml version="1.0" encoding="UTF-8"?><ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1"><head><meta name="dtb:uid" content="${id}"/></head><docTitle><text>${escapeXml(book.title)}</text></docTitle><navMap>${chapters.map((c, i) => `<navPoint id="np${i + 1}" playOrder="${i + 1}"><navLabel><text>${escapeXml(c.title)}</text></navLabel><content src="${c.name}"/></navPoint>`).join('')}</navMap></ncx>`);

    const modified = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
    files['OEBPS/content.opf'] = strToU8(`<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid">
<metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
<dc:identifier id="bookid">${id}</dc:identifier><dc:title>${escapeXml(book.title)}</dc:title><dc:language>${escapeXml(book.lang || 'en')}</dc:language>${book.author ? `<dc:creator>${escapeXml(book.author)}</dc:creator>` : ''}<meta property="dcterms:modified">${modified}</meta>
</metadata>
<manifest>
<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/><item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/><item id="css" href="style.css" media-type="text/css"/>
${chapters.map((c, i) => `<item id="c${i + 1}" href="${c.name}" media-type="application/xhtml+xml"/>`).join('\n')}
${images.map((im, i) => `<item id="i${i + 1}" href="images/${im.name}" media-type="${im.mime}"/>`).join('\n')}
</manifest>
<spine toc="ncx">${chapters.map((c, i) => `<itemref idref="c${i + 1}"/>`).join('')}</spine>
</package>`);
    fs.writeFileSync(out, zipSync(files, { level: 6 }));
}

// Fixed-layout EPUB: one picture per page (used for comics).
function writeImageEpub(pages, out, title) {
    const id = `urn:uuid:${crypto.randomUUID()}`;
    const files = { mimetype: [strToU8('application/epub+zip'), { level: 0 }] };
    files['META-INF/container.xml'] = strToU8('<?xml version="1.0" encoding="UTF-8"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>');
    const items = pages.map((p, i) => {
        const n = String(i + 1).padStart(4, '0');
        const img = `p${n}.${p.ext}`;
        files[`OEBPS/images/${img}`] = [p.data, { level: 0 }];
        files[`OEBPS/p${n}.xhtml`] = strToU8(`<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE html>\n<html xmlns="http://www.w3.org/1999/xhtml"><head><title>${escapeXml(title)} - ${i + 1}</title><meta name="viewport" content="width=${p.width}, height=${p.height}"/><style>html,body{margin:0;padding:0}img{display:block;width:${p.width}px;height:${p.height}px}</style></head><body><img src="images/${img}" alt=""/></body></html>`);
        return { n, img, mime: MIME[p.ext] || 'image/jpeg' };
    });
    files['OEBPS/nav.xhtml'] = strToU8(`<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE html>\n<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>Contents</title></head><body><nav epub:type="toc"><ol><li><a href="p0001.xhtml">${escapeXml(title)}</a></li></ol></nav></body></html>`);
    files['OEBPS/content.opf'] = strToU8(`<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid" prefix="rendition: http://www.idpf.org/vocab/rendition/#">
<metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="bookid">${id}</dc:identifier><dc:title>${escapeXml(title)}</dc:title><dc:language>en</dc:language><meta property="dcterms:modified">${new Date().toISOString().replace(/\.\d+Z$/, 'Z')}</meta><meta property="rendition:layout">pre-paginated</meta><meta property="rendition:spread">auto</meta><meta name="cover" content="img0001"/></metadata>
<manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
${items.map((it, i) => `<item id="img${it.n}" href="images/${it.img}" media-type="${it.mime}"${i === 0 ? ' properties="cover-image"' : ''}/><item id="p${it.n}" href="p${it.n}.xhtml" media-type="application/xhtml+xml"/>`).join('\n')}
</manifest>
<spine>${items.map((it) => `<itemref idref="p${it.n}"/>`).join('')}</spine>
</package>`);
    fs.writeFileSync(out, zipSync(files, { level: 0 }));
}

// ------------------------------------------------------------------ Calibre
async function calibreConvert(src, out, onProgress) {
    const exe = findCalibre();
    if (!exe) throw new Error('Kindle formats (AZW3, MOBI) need the free Calibre app. Install it from calibre-ebook.com, then try again.');
    const args = [src, out];
    if (/\.pdf$/i.test(out)) args.push('--paper-size', 'a4', '--pdf-page-numbers');
    await runTool(exe, args, {
        onLine: (line) => {
            const m = /^(\d{1,3})%/.exec(line);
            if (m && onProgress) onProgress(Math.min(99, Number(m[1])));
        },
    });
    if (!fs.existsSync(out)) throw new Error('Calibre didn\'t produce a file. The book may be DRM-protected.');
}

// --------------------------------------------------------------- entry point
const KINDLE_IN = ['azw3', 'azw', 'mobi', 'prc'];

async function readBook(src) {
    const ext = path.extname(src).slice(1).toLowerCase();
    if (ext === 'epub') return readEpub(src);
    if (ext === 'fb2') return readFb2(src);
    throw new Error(`Can't read ${ext.toUpperCase()} books`);
}

async function writeBookAs(book, target, out, writeDocx) {
    if (!book.chapters.length) throw new Error('This book has no readable text.');
    switch (target) {
        case 'epub': return writeEpub(book, out);
        case 'html': return fs.writeFileSync(out, bookToHtml(book), 'utf8');
        case 'pdf': return host.htmlToPdf(bookToHtml(book), out);
        case 'txt': return fs.writeFileSync(out, `${book.title}\n${book.author ? `${book.author}\n` : ''}\n${await host.htmlText(book.chapters.map((c) => c.html).join('<hr/>'))}\n`, 'utf8');
        case 'docx': {
            const blocks = await host.htmlBlocks(book.chapters.map((c) => c.html).join(''));
            const paragraphs = blocks.map((b) => ({ text: b.text, heading: /^h[1-3]$/.test(b.tag) ? Number(b.tag[1]) : (/^h[4-6]$/.test(b.tag) ? 3 : 0) }));
            return writeDocx(out, [{ paragraphs: [{ text: book.title, heading: 1 }, ...(book.author ? [{ text: book.author }] : []), ...paragraphs] }]);
        }
        default: throw new Error(`Can't convert books to ${target.toUpperCase()}`);
    }
}

async function convertEbook(src, target, out, opts, onProgress, { writeDocx }) {
    const ext = path.extname(src).slice(1).toLowerCase();

    // Kindle in or out: Calibre does the whole conversion.
    if (KINDLE_IN.includes(ext) || target === 'azw3' || target === 'mobi') {
        return calibreConvert(src, out, onProgress);
    }
    return writeBookAs(await readBook(src), target, out, writeDocx);
}

// Turns a document (already converted to HTML) into chapters, split at the
// top heading level so the EPUB gets a useful table of contents.
function bookFromHtml(html, title, author = '') {
    const level = /<h1\b/i.test(html) ? 1 : /<h2\b/i.test(html) ? 2 : 0;
    let chapters;
    if (!level) chapters = [{ title, html }];
    else {
        const parts = html.split(new RegExp(`(?=<h${level}\\b)`, 'i')).filter((p) => p.trim());
        chapters = parts.map((p) => {
            const h = new RegExp(`<h${level}\\b[^>]*>([\\s\\S]*?)<\\/h${level}>`, 'i').exec(p);
            return { title: h ? stripTags(h[1]) : title, html: p };
        });
    }
    return { title, author, lang: 'en', chapters };
}

// Documents -> EPUB (natively) or AZW3/MOBI (via Calibre, going through EPUB
// for formats Calibre can't read well on its own, like Markdown).
async function documentToEbook(src, target, out, onProgress, html, title) {
    const book = bookFromHtml(html, title);
    if (target === 'epub') return writeEpub(book, out);
    const tmp = path.join(os.tmpdir(), `unifiles-${process.pid}-${Date.now()}.epub`);
    try {
        await writeEpub(book, tmp);
        return await calibreConvert(tmp, out, onProgress);
    } finally {
        fs.rmSync(tmp, { force: true });
    }
}

// The book's cover (or first picture) as a small image for the file list.
async function ebookThumb(src) {
    const ext = path.extname(src).slice(1).toLowerCase();
    if (!['epub', 'fb2'].includes(ext)) return null;
    let data = null;
    if (ext === 'epub') {
        const files = unzipSync(new Uint8Array(fs.readFileSync(src)));
        const opfPath = attr((/<rootfile\b[^>]*>/i.exec(strFromU8(files['META-INF/container.xml'] || new Uint8Array())) || [''])[0], 'full-path');
        const opf = opfPath && files[opfPath] ? strFromU8(files[opfPath]) : '';
        const items = (opf.match(/<item\b[^>]*>/gi) || []);
        const coverId = attr((/<meta\b[^>]*name=["']cover["'][^>]*>/i.exec(opf) || [''])[0], 'content');
        const pick = items.find((t) => /cover-image/.test(attr(t, 'properties') || '')) || items.find((t) => coverId && attr(t, 'id') === coverId) || items.find((t) => /^image\//.test(attr(t, 'media-type') || ''));
        if (pick) data = files[path.posix.normalize(path.posix.join(path.posix.dirname(opfPath), decodeURIComponent(attr(pick, 'href'))))];
    } else {
        const book = readFb2(src);
        const m = /src="data:image\/[\w+.-]+;base64,([^"]+)"/.exec(book.chapters.map((c) => c.html).join(''));
        if (m) data = Buffer.from(m[1], 'base64');
    }
    if (!data) return null;
    const sharp = require('sharp');
    const buf = await sharp(Buffer.from(data)).resize(160, 120, { fit: 'cover', position: 'top' }).jpeg({ quality: 70 }).toBuffer();
    return `data:image/jpeg;base64,${buf.toString('base64')}`;
}

module.exports = { ebookThumb, convertEbook, documentToEbook, writeImageEpub, readEpub, readFb2, bookFromHtml, writeEpub };
