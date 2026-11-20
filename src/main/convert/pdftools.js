// PDF page tools: extract, remove, split, rotate and merge. Pages are copied
// as they are (pdf-lib), so text stays selectable, sizes stay the same and
// nothing is re-rendered or loses quality.

const fs = require('fs');
const path = require('path');
const { PDFDocument, degrees } = require('pdf-lib');
const { uniquePath } = require('../tools');

async function load(src) {
    try {
        return await PDFDocument.load(fs.readFileSync(src), { updateMetadata: false });
    } catch (err) {
        if (/encrypt/i.test(err.message)) throw new Error('This PDF is password-protected.');
        throw new Error('The PDF is damaged.');
    }
}

async function pageCount(src) {
    return (await load(src)).getPageCount();
}

// "1-3, 7, 10-" -> [0, 1, 2, 6, 9, 10, …] (0-based, in the order typed).
// Open ranges are allowed: "10-" runs to the end, "-5" starts at page 1.
function parsePages(text, total) {
    const spec = String(text || '').trim();
    if (!spec) throw new Error('Type which pages to use, e.g. 1-5, 8');
    const pages = [];
    for (const raw of spec.split(/[,;]+/)) {
        const part = raw.trim().toLowerCase();
        if (!part) continue;
        const m = /^(\d+|last)?\s*(?:(-|–|to)\s*(\d+|last)?)?$/.exec(part);
        if (!m || (!m[1] && !m[2])) throw new Error(`"${raw.trim()}" isn't a page or range (use e.g. 3 or 2-6)`);
        const num = (v, fallback) => (v === undefined ? fallback : v === 'last' ? total : Number(v));
        const from = num(m[1], 1);
        const to = m[2] ? num(m[3], total) : from;
        for (const p of [from, to]) {
            if (p < 1 || p > total) throw new Error(`Page ${p} doesn't exist: this PDF has ${total} page${total === 1 ? '' : 's'}.`);
        }
        const step = from <= to ? 1 : -1; // "5-1" gives the pages backwards
        for (let p = from; p !== to + step; p += step) pages.push(p - 1);
    }
    if (!pages.length) throw new Error('No pages were chosen.');
    return pages;
}

// Copies the chosen pages (0-based) of a loaded PDF into a new one.
async function copyInto(target, source, indices, rotate) {
    const copied = await target.copyPages(source, indices);
    for (const page of copied) {
        if (rotate) page.setRotation(degrees((page.getRotation().angle + rotate) % 360));
        target.addPage(page);
    }
}

// The pages a file contributes, after "extract"/"remove" (all pages otherwise).
function selectedPages(opts, total) {
    const all = [...Array(total).keys()];
    if (opts.mode === 'extract') return parsePages(opts.ranges, total);
    if (opts.mode === 'remove') {
        const drop = new Set(parsePages(opts.ranges, total));
        const keep = all.filter((i) => !drop.has(i));
        if (!keep.length) throw new Error('That would remove every page.');
        return keep;
    }
    return all;
}

async function save(doc, file) {
    fs.writeFileSync(file, await doc.save());
    return file;
}

// One PDF -> one or more PDFs, following the file's PDF tools settings.
// opts: { mode: 'all'|'extract'|'remove'|'split', ranges, split: 'each'|'every'|'ranges', every, rotate }
async function applyPdfTools(src, opts, { dir, base, taken }) {
    opts = opts || {};
    const rotate = Number(opts.rotate) || 0;
    const source = await load(src);
    const total = source.getPageCount();

    if (opts.mode === 'split') {
        let groups;
        if (opts.split === 'ranges') {
            groups = String(opts.ranges || '').split(/[,;]+/).map((r) => r.trim()).filter(Boolean)
                .map((r) => {
                    const pages = parsePages(r, total);
                    // Name parts by their real pages ("9-" becomes "9-10").
                    const label = pages.length === 1 ? `${pages[0] + 1}` : `${pages[0] + 1}-${pages[pages.length - 1] + 1}`;
                    return { label, pages };
                });
            if (!groups.length) throw new Error('Type the parts to split into, e.g. 1-3, 4-10');
        } else {
            const every = opts.split === 'every' ? Math.max(1, parseInt(opts.every, 10) || 1) : 1;
            groups = [];
            for (let i = 0; i < total; i += every) {
                const pages = [...Array(Math.min(every, total - i)).keys()].map((k) => i + k);
                groups.push({ label: pages.length === 1 ? `${pages[0] + 1}` : `${pages[0] + 1}-${pages[pages.length - 1] + 1}`, pages });
            }
        }
        if (groups.length === 1 && groups[0].pages.length === total && !rotate) {
            throw new Error('Splitting this way would give back the same PDF. Choose smaller parts.');
        }
        const width = String(total).length;
        const pad = (label) => label.replace(/\d+/g, (n) => n.padStart(width, '0'));
        const outputs = [];
        try {
            for (const g of groups) {
                const doc = await PDFDocument.create();
                await copyInto(doc, source, g.pages, rotate);
                const name = g.pages.length === 1 ? `${base} - page ${pad(g.label)}` : `${base} - pages ${pad(g.label)}`;
                outputs.push(await save(doc, uniquePath(dir, name, 'pdf', taken)));
            }
        } catch (err) {
            for (const f of outputs) fs.rmSync(f, { force: true });
            throw err;
        }
        return outputs;
    }

    const pages = selectedPages(opts, total);
    if (pages.length === total && pages.every((p, i) => p === i) && !rotate) {
        throw new Error('Nothing to change: choose pages to extract or remove, a split, or a rotation.');
    }
    const doc = await PDFDocument.create();
    await copyInto(doc, source, pages, rotate);
    const what = opts.mode === 'extract'
        ? `pages ${String(opts.ranges).replace(/\s+/g, '').replace(/[<>:"/\\|?*]/g, '_').slice(0, 40)}`
        : opts.mode === 'remove' ? 'edited' : 'rotated';
    return [await save(doc, uniquePath(dir, `${base} (${what})`, 'pdf', taken))];
}

// Several PDFs and/or pictures -> one PDF, in list order. Each PDF can bring
// only some pages (its PDF tools "extract"/"remove" settings) and a rotation.
async function combineToPdf(items, out, { addImagePage, imageOpts }) {
    const doc = await PDFDocument.create();
    for (const item of items) {
        if (/\.pdf$/i.test(item.path)) {
            const source = await load(item.path);
            const opts = item.pdf || {};
            await copyInto(doc, source, selectedPages(opts.mode === 'split' ? {} : opts, source.getPageCount()), Number(opts.rotate) || 0);
        } else {
            await addImagePage(doc, item.path, imageOpts);
        }
    }
    return save(doc, out);
}

module.exports = { pageCount, parsePages, applyPdfTools, combineToPdf };
