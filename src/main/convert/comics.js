// Comics: CBZ (a ZIP of page images) and CBR (a RAR of page images).
// CBR can be read by everyone (built-in RAR reader), but RAR files can only
// be *created* with WinRAR, so CBR output appears only when it's installed.

const fs = require('fs');
const os = require('os');
const path = require('path');
const sharp = require('sharp');
const { unzipSync, zipSync } = require('fflate');
const { PDFDocument } = require('pdf-lib');
const { findRar, runTool } = require('../tools');
const host = require('./host');
const { writeImageEpub } = require('./ebooks');

const PAGE_EXT = ['jpg', 'jpeg', 'png', 'webp', 'gif', 'avif', 'bmp', 'tif', 'tiff'];
const KEEP_EXT = ['jpg', 'jpeg', 'png', 'webp', 'gif']; // stored as-is; others become PNG/JPG
const byName = (a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
const isPage = (name) => {
    const n = name.replace(/\\/g, '/');
    if (/(^|\/)(__MACOSX|\.)|thumbs\.db$/i.test(n)) return false;
    return PAGE_EXT.includes(path.extname(n).slice(1).toLowerCase());
};

// What's really inside (many ".cbr" files are actually ZIPs, and vice versa).
function kind(buf) {
    if (buf[0] === 0x50 && buf[1] === 0x4b) return 'zip';
    if (buf.subarray(0, 4).toString('latin1') === 'Rar!') return 'rar';
    if (buf.subarray(0, 6).toString('hex') === '377abcaf271c') return '7z';
    return null;
}

async function readRar(buf) {
    const { createExtractorFromData } = require('node-unrar-js');
    const wasmBinary = fs.readFileSync(require.resolve('node-unrar-js/dist/js/unrar.wasm'));
    let extractor;
    try {
        extractor = await createExtractorFromData({ data: buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), wasmBinary });
    } catch (err) {
        throw new Error(/password/i.test(String(err && err.reason || err)) ? 'This comic is password-protected.' : 'The comic file is damaged.');
    }
    const pages = [];
    const { files } = extractor.extract({ files: (h) => !h.flags.directory && isPage(h.name) });
    for (const f of files) {
        if (f.extraction) pages.push({ name: f.fileHeader.name, data: Buffer.from(f.extraction) });
    }
    return pages;
}

async function readComic(src) {
    const buf = fs.readFileSync(src);
    const type = kind(buf);
    let pages;
    if (type === 'zip') {
        let files;
        try { files = unzipSync(new Uint8Array(buf), { filter: (f) => isPage(f.name) }); } catch { throw new Error('The comic file is damaged.'); }
        pages = Object.entries(files).map(([name, data]) => ({ name, data: Buffer.from(data) }));
    } else if (type === 'rar') {
        pages = await readRar(buf);
    } else if (type === '7z') {
        throw new Error('This comic is a 7-Zip archive (CB7), which isn\'t supported. Re-save it as CBZ.');
    } else {
        throw new Error('The file is damaged or isn\'t really a comic archive.');
    }
    if (!pages.length) throw new Error('No pages (pictures) were found inside this comic.');
    return pages.sort(byName);
}

// Pages in a format every reader shows, with their size (for PDF/EPUB).
async function normalise(pages) {
    const out = [];
    for (const p of pages) {
        const ext = path.extname(p.name).slice(1).toLowerCase();
        let data = p.data;
        let fmt = ext === 'jpeg' ? 'jpg' : ext;
        const meta = await sharp(data, { limitInputPixels: false }).metadata();
        if (!KEEP_EXT.includes(ext)) {
            data = meta.hasAlpha ? await sharp(data).png().toBuffer() : await sharp(data).jpeg({ quality: 92 }).toBuffer();
            fmt = meta.hasAlpha ? 'png' : 'jpg';
        }
        out.push({ data, ext: fmt, width: meta.width, height: meta.height });
    }
    return out;
}

function writeCbz(pages, out) {
    const width = Math.max(3, String(pages.length).length);
    const files = {};
    pages.forEach((p, i) => { files[`${String(i + 1).padStart(width, '0')}.${p.ext}`] = [p.data, { level: 0 }]; });
    fs.writeFileSync(out, zipSync(files));
}

async function writeCbr(pages, out) {
    const rar = findRar();
    if (!rar) throw new Error('Creating CBR files needs WinRAR. CBZ works in every comic reader.');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'unifiles-cbr-'));
    try {
        const width = Math.max(3, String(pages.length).length);
        pages.forEach((p, i) => fs.writeFileSync(path.join(tmp, `${String(i + 1).padStart(width, '0')}.${p.ext}`), p.data));
        // a = add, -ep1 = no folder names, -m0 = store (pictures are already compressed), -idq = quiet
        await runTool(rar, ['a', '-ep1', '-m0', '-idq', '-y', out, path.join(tmp, '*')]);
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
}

async function writePdf(pages, out) {
    const pdf = await PDFDocument.create();
    for (const p of pages) {
        let data = p.data, ext = p.ext;
        if (ext === 'webp' || ext === 'gif') { data = await sharp(data).png().toBuffer(); ext = 'png'; }
        const img = ext === 'jpg' ? await pdf.embedJpg(data) : await pdf.embedPng(data);
        const w = img.width * 0.75, h = img.height * 0.75;
        pdf.addPage([w, h]).drawImage(img, { x: 0, y: 0, width: w, height: h });
    }
    fs.writeFileSync(out, await pdf.save());
}

function uniqueDir(dir, base) {
    let candidate = path.join(dir, base);
    for (let n = 1; fs.existsSync(candidate); n++) candidate = path.join(dir, `${base} (${n})`);
    return candidate;
}

async function writePages(pages, target, out, title) {
    switch (target) {
        case 'cbz': return writeCbz(pages, out);
        case 'cbr': return writeCbr(pages, out);
        case 'pdf': return writePdf(pages, out);
        case 'epub': return writeImageEpub(pages, out, title);
        case 'images': {
            fs.mkdirSync(out, { recursive: true });
            const width = Math.max(3, String(pages.length).length);
            pages.forEach((p, i) => fs.writeFileSync(path.join(out, `${String(i + 1).padStart(width, '0')}.${p.ext}`), p.data));
            return [out];
        }
        default: throw new Error(`Can't convert comics to ${target.toUpperCase()}`);
    }
}

async function convertComic(src, target, out, opts, onProgress) {
    const pages = await normalise(await readComic(src));
    if (onProgress) onProgress(50);
    return writePages(pages, target, out, path.basename(src, path.extname(src)));
}

// Pictures -> one comic (CBZ/CBR), in the given order.
async function imagesToComic(sources, target, out) {
    const pages = await normalise(sources.map((s) => ({ name: path.basename(s), data: fs.readFileSync(s) })));
    return writePages(pages, target, out, path.basename(sources[0], path.extname(sources[0])));
}

// PDF -> CBZ: every page rendered as a picture.
async function pdfToComic(src, out, onProgress) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'unifiles-pdf-'));
    try {
        const files = await host.pdfToImages(src, 'jpg', (i) => path.join(tmp, `${String(i).padStart(5, '0')}.jpg`), (p) => onProgress && onProgress(p * 0.9));
        const pages = files.map((f) => ({ name: path.basename(f), data: fs.readFileSync(f), ext: 'jpg' }));
        writeCbz(pages, out);
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
}

// First page as a small picture for the file list.
async function comicThumb(src) {
    const [first] = await readComic(src);
    const buf = await sharp(first.data).resize(160, 120, { fit: 'cover', position: 'top' }).jpeg({ quality: 70 }).toBuffer();
    return `data:image/jpeg;base64,${buf.toString('base64')}`;
}

module.exports = { convertComic, imagesToComic, pdfToComic, uniqueDir, comicThumb };
