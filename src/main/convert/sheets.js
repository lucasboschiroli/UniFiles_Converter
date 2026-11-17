// Spreadsheet conversions with SheetJS: XLSX, XLS, ODS, CSV, TSV.

const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');
const host = require('./host');

const escapeHtml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function read(src) {
    const ext = path.extname(src).slice(1).toLowerCase();
    // CSV/TSV are read as UTF-8 text so accents survive.
    if (ext === 'csv' || ext === 'tsv') {
        const text = fs.readFileSync(src, 'utf8').replace(/^﻿/, '');
        // Keep every value exactly as written (SheetJS would otherwise turn dates
        // into timezone-shifted numbers), then make plain numbers numeric again.
        const wb = XLSX.read(text, { type: 'string', FS: ext === 'tsv' ? '\t' : undefined, raw: true });
        for (const name of wb.SheetNames) {
            for (const [ref, cell] of Object.entries(wb.Sheets[name])) {
                if (ref[0] !== '!' && cell.t === 's' && /^-?\d+(\.\d+)?$/.test(cell.v) && !/^-?0\d/.test(cell.v)) {
                    cell.t = 'n';
                    cell.v = Number(cell.v);
                }
            }
        }
        return wb;
    }
    // SheetJS reads almost anything as text, so check the file really is what
    // its extension says before converting it.
    const buf = fs.readFileSync(src);
    const zip = buf[0] === 0x50 && buf[1] === 0x4b;                         // XLSX / XLSM / ODS
    const ole = buf.readUInt32BE(0) === 0xd0cf11e0;                          // classic XLS
    const markup = /^\s*</.test(buf.subarray(0, 64).toString('utf8').replace(/^﻿/, '')); // HTML/XML saved as .xls
    if ((ext === 'xls' && !ole && !markup) || (ext !== 'xls' && !zip)) {
        throw new Error('The file is damaged or isn\'t really this format.');
    }
    return XLSX.read(buf, { type: 'buffer' });
}

function tablesHtml(wb, title) {
    const css = `body{font-family:'Segoe UI',Calibri,Arial,sans-serif;font-size:9pt;color:#1a1a1a;margin:0}
        h2{font-size:12pt;margin:0 0 6px}section{margin-bottom:18px;page-break-after:always}section:last-child{page-break-after:auto}
        table{border-collapse:collapse}td,th{border:1px solid #c8c8c8;padding:3px 6px;white-space:nowrap}tr:first-child td{background:#f0f0f2;font-weight:600}`;
    const sheets = wb.SheetNames.map((name) => {
        const html = XLSX.utils.sheet_to_html(wb.Sheets[name], { header: '', footer: '' });
        return `<section>${wb.SheetNames.length > 1 ? `<h2>${escapeHtml(name)}</h2>` : ''}${html}</section>`;
    }).join('');
    return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title><style>${css}</style></head><body>${sheets}</body></html>`;
}

async function convertSheet(src, target, out, opts, onProgress, outFor, outForSheet) {
    const wb = read(src);
    const title = path.basename(src, path.extname(src));

    switch (target) {
        case 'xlsx':
        case 'ods':
            return XLSX.writeFile(wb, out, { bookType: target, compression: true });
        case 'csv': {
            // One CSV per sheet (CSV can only hold one). UTF-8 with BOM so Excel shows accents.
            const names = wb.SheetNames.filter((n) => wb.Sheets[n]['!ref']);
            if (names.length <= 1) {
                fs.writeFileSync(out, '﻿' + XLSX.utils.sheet_to_csv(wb.Sheets[names[0] || wb.SheetNames[0]]), 'utf8');
                return out;
            }
            return names.map((n) => {
                const file = outForSheet(n);
                fs.writeFileSync(file, '﻿' + XLSX.utils.sheet_to_csv(wb.Sheets[n]), 'utf8');
                return file;
            });
        }
        case 'html':
            return fs.writeFileSync(out, tablesHtml(wb, title), 'utf8');
        case 'pdf':
            return host.htmlToPdf(tablesHtml(wb, title), out, { landscape: true });
        default:
            throw new Error(`Can't convert spreadsheets to ${target.toUpperCase()}`);
    }
}

module.exports = { convertSheet };
