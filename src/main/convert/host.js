// Hidden Chromium windows used as conversion engines:
//  - htmlToPdf: lays out HTML and prints it to PDF (proper wrapping, any language)
//  - pdf.js worker: reads text from PDFs and renders their pages to images

const { BrowserWindow } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');

function hiddenWindow(extra = {}) {
    const win = new BrowserWindow({
        show: false,
        width: 1200,
        height: 1600,
        webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, ...extra },
    });
    // Documents being converted must never open windows or navigate away.
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', (e) => e.preventDefault());
    return win;
}

async function printToPdf(win, { landscape = false } = {}) {
    return win.webContents.printToPDF({
        pageSize: 'A4',
        landscape,
        printBackground: true,
        margins: { top: 0.6, bottom: 0.6, left: 0.6, right: 0.6 },
    });
}

async function htmlToPdf(html, out, opts = {}) {
    const tmp = path.join(os.tmpdir(), `unifiles-${process.pid}-${Date.now()}.html`);
    fs.writeFileSync(tmp, html, 'utf8');
    const win = hiddenWindow({ javascript: false });
    try {
        await win.loadFile(tmp);
        fs.writeFileSync(out, await printToPdf(win, opts));
    } finally {
        win.destroy();
        fs.rmSync(tmp, { force: true });
    }
}

// Opens the user's own .html file as-is (scripts allowed, still sandboxed).
async function withHtmlFile(src, fn) {
    const win = hiddenWindow();
    try {
        await win.loadFile(src);
        return await fn(win);
    } finally {
        win.destroy();
    }
}

async function htmlFileToPdf(src, out) {
    return withHtmlFile(src, async (win) => fs.writeFileSync(out, await printToPdf(win)));
}

async function htmlFileToText(src) {
    return withHtmlFile(src, (win) => win.webContents.executeJavaScript('document.body ? document.body.innerText : ""'));
}

// ---------------------------------------------------- DOM helpers (sandboxed)
// A blank hidden page whose only job is to run Chromium's HTML parser on
// book content. Nothing is loaded into it; markup is parsed with DOMParser,
// which never runs scripts or fetches anything.
let domWin = null;
async function domCall(fn, arg) {
    if (!domWin || domWin.isDestroyed()) {
        domWin = hiddenWindow();
        await domWin.loadURL('about:blank');
    }
    return domWin.webContents.executeJavaScript(`(${fn.toString()})(${JSON.stringify(arg)})`);
}

// Any HTML -> well-formed XHTML for EPUB (scripts, forms and frames removed).
function htmlToXhtml(html) {
    return domCall((src) => {
        const doc = new DOMParser().parseFromString(src, 'text/html');
        doc.querySelectorAll('script, iframe, object, embed, form, link, meta, style, base').forEach((n) => n.remove());
        doc.querySelectorAll('*').forEach((n) => {
            for (const a of [...n.attributes]) if (/^on/i.test(a.name)) n.removeAttribute(a.name);
        });
        const s = new XMLSerializer();
        return [...doc.body.childNodes].map((n) => s.serializeToString(n)).join('')
            .replace(/ xmlns="http:\/\/www\.w3\.org\/1999\/xhtml"/g, '');
    }, html);
}

// HTML -> [{ tag: 'h1'|'h2'|'h3'|'p'|'li', text }] for building Word files.
function htmlBlocks(html) {
    return domCall((src) => {
        const doc = new DOMParser().parseFromString(src, 'text/html');
        const out = [];
        doc.body.querySelectorAll('h1, h2, h3, h4, h5, h6, p, li, pre, blockquote, td').forEach((n) => {
            if (n.closest('li') && n.tagName !== 'LI') return; // text inside a list item counts once
            const text = n.innerText !== undefined ? n.textContent.replace(/\s+/g, ' ').trim() : '';
            if (text) out.push({ tag: n.tagName.toLowerCase(), text });
        });
        return out;
    }, html);
}

function htmlText(html) {
    return domCall((src) => {
        const doc = new DOMParser().parseFromString(src, 'text/html');
        doc.querySelectorAll('h1, h2, h3, h4, h5, h6, p, li, div, br, tr').forEach((n) => n.append('\n'));
        return doc.body.textContent.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
    }, html);
}

// ---------------------------------------------------------------- pdf.js
// Two workers: one for conversions, one for page previews, so showing a
// preview never interferes with a PDF that's being converted.
const pdfWins = {};

async function pdfWorker(name) {
    if (pdfWins[name] && !pdfWins[name].isDestroyed()) return pdfWins[name];
    // webSecurity off only here, so the worker page can read the local PDF
    // the user picked; it never loads anything but our own pdf.html.
    const win = hiddenWindow({ webSecurity: false });
    pdfWins[name] = win;
    await win.loadFile(path.join(__dirname, '..', '..', 'worker', 'pdf.html'));
    // The page's module script loads pdf.js; wait until its functions exist.
    await win.webContents.executeJavaScript(
        'new Promise((resolve, reject) => { let n = 0; const check = () => window.pdfText ? resolve(true) : ++n > 200 ? reject(new Error("pdf.js failed to load")) : setTimeout(check, 50); check(); })');
    return win;
}

async function pdfCall(code, name = 'convert') {
    const win = await pdfWorker(name);
    return win.webContents.executeJavaScript(code);
}

// Small page pictures for the PDF tools preview (pages from..to, 1-based).
let previewQueue = Promise.resolve();
function pdfThumbs(src, from, to) {
    const run = async () => {
        const url = JSON.stringify(pathToFileURL(src).href);
        const count = await pdfCall(`window.pdfOpen(${url})`, 'preview');
        const out = [];
        try {
            for (let i = Math.max(1, from); i <= Math.min(count, to); i++) {
                out.push(await pdfCall(`window.pdfRender(${i}, 0.35, "image/jpeg")`, 'preview'));
            }
        } finally {
            await pdfCall('window.pdfClose()', 'preview');
        }
        return { count, pages: out };
    };
    // One preview at a time (the worker holds one open document).
    const job = previewQueue.then(run, run);
    previewQueue = job.catch(() => {});
    return job;
}

// -> { pages: [{ paragraphs: [{ text, size, bold }] }] }
async function pdfText(src) {
    const url = JSON.stringify(pathToFileURL(src).href);
    return pdfCall(`window.pdfText(${url})`);
}

// Renders pages one at a time to keep memory low; returns written files.
async function pdfToImages(src, target, outFor, onProgress) {
    const url = JSON.stringify(pathToFileURL(src).href);
    const count = await pdfCall(`window.pdfOpen(${url})`);
    const mime = target === 'jpg' ? 'image/jpeg' : 'image/png';
    const outputs = [];
    try {
        for (let i = 1; i <= count; i++) {
            const dataUrl = await pdfCall(`window.pdfRender(${i}, 2, ${JSON.stringify(mime)})`);
            const out = outFor(i, count);
            fs.writeFileSync(out, Buffer.from(dataUrl.split(',')[1], 'base64'));
            outputs.push(out);
            if (onProgress) onProgress((i / count) * 100);
        }
    } finally {
        await pdfCall('window.pdfClose()');
    }
    return outputs;
}

function closeWorkers() {
    for (const [name, win] of Object.entries(pdfWins)) {
        if (win && !win.isDestroyed()) win.destroy();
        delete pdfWins[name];
    }
    if (domWin && !domWin.isDestroyed()) domWin.destroy();
    domWin = null;
}

module.exports = { htmlToPdf, htmlFileToPdf, htmlFileToText, pdfText, pdfToImages, pdfThumbs, htmlToXhtml, htmlBlocks, htmlText, closeWorkers };
