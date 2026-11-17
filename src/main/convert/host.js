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

// ---------------------------------------------------------------- pdf.js
let pdfWin = null;

async function pdfWorker() {
    if (pdfWin && !pdfWin.isDestroyed()) return pdfWin;
    // webSecurity off only here, so the worker page can read the local PDF
    // the user picked; it never loads anything but our own pdf.html.
    pdfWin = hiddenWindow({ webSecurity: false });
    await pdfWin.loadFile(path.join(__dirname, '..', '..', 'worker', 'pdf.html'));
    // The page's module script loads pdf.js; wait until its functions exist.
    await pdfWin.webContents.executeJavaScript(
        'new Promise((resolve, reject) => { let n = 0; const check = () => window.pdfText ? resolve(true) : ++n > 200 ? reject(new Error("pdf.js failed to load")) : setTimeout(check, 50); check(); })');
    return pdfWin;
}

async function pdfCall(code) {
    const win = await pdfWorker();
    return win.webContents.executeJavaScript(code);
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
    if (pdfWin && !pdfWin.isDestroyed()) pdfWin.destroy();
    pdfWin = null;
}

module.exports = { htmlToPdf, htmlFileToPdf, htmlFileToText, pdfText, pdfToImages, closeWorkers };
