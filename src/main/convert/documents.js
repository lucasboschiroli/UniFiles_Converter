// Document conversions: PDF, DOCX, TXT, Markdown and HTML.

const fs = require('fs');
const path = require('path');
const mammoth = require('mammoth');
const { Document, Packer, Paragraph, TextRun, HeadingLevel, PageBreak } = require('docx');
const host = require('./host');

const escapeHtml = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const PAGE_CSS = `
    @page { size: A4; }
    body { font-family: 'Segoe UI', Calibri, Arial, sans-serif; font-size: 11pt; line-height: 1.5; color: #1a1a1a; margin: 0; }
    h1, h2, h3, h4 { line-height: 1.25; margin: 1.2em 0 0.5em; }
    p { margin: 0 0 0.7em; }
    img { max-width: 100%; height: auto; }
    table { border-collapse: collapse; margin: 0.8em 0; max-width: 100%; }
    td, th { border: 1px solid #c8c8c8; padding: 4px 8px; vertical-align: top; }
    pre, code { font-family: Consolas, 'Courier New', monospace; font-size: 10pt; }
    pre { white-space: pre-wrap; word-wrap: break-word; margin: 0; }
    blockquote { border-left: 3px solid #ccc; margin: 0.8em 0; padding-left: 1em; color: #555; }`;

const page = (title, body) => `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title><style>${PAGE_CSS}</style></head><body>${body}</body></html>`;

const readText = (src) => fs.readFileSync(src, 'utf8').replace(/^﻿/, '');

// Small Markdown renderer: headings, bold/italic, code, lists, quotes, links.
function markdownToHtml(md) {
    const inline = (s) => escapeHtml(s)
        .replace(/`([^`]+)`/g, '<code>$1</code>')
        .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
        .replace(/(^|[^*])\*([^*]+)\*/g, '$1<em>$2</em>')
        .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
    const out = [];
    let list = null, para = [], code = null;
    const flush = () => {
        if (para.length) out.push(`<p>${inline(para.join(' '))}</p>`);
        para = [];
        if (list) { out.push(`</${list}>`); list = null; }
    };
    for (const line of md.split(/\r?\n/)) {
        if (code !== null) {
            if (/^```/.test(line)) { out.push(`<pre>${escapeHtml(code.join('\n'))}</pre>`); code = null; } else code.push(line);
            continue;
        }
        let m;
        if (/^```/.test(line)) { flush(); code = []; }
        else if ((m = /^(#{1,6})\s+(.*)$/.exec(line))) { flush(); out.push(`<h${m[1].length}>${inline(m[2])}</h${m[1].length}>`); }
        else if ((m = /^\s*([-*+]|\d+[.)])\s+(.*)$/.exec(line))) {
            const kind = /\d/.test(m[1]) ? 'ol' : 'ul';
            if (para.length) { out.push(`<p>${inline(para.join(' '))}</p>`); para = []; }
            if (list !== kind) { if (list) out.push(`</${list}>`); out.push(`<${kind}>`); list = kind; }
            out.push(`<li>${inline(m[2])}</li>`);
        }
        else if ((m = /^>\s?(.*)$/.exec(line))) { flush(); out.push(`<blockquote>${inline(m[1])}</blockquote>`); }
        else if (!line.trim()) flush();
        else para.push(line.trim());
    }
    if (code !== null) out.push(`<pre>${escapeHtml(code.join('\n'))}</pre>`);
    flush();
    return out.join('\n');
}

// Paragraph list -> .docx. Larger text in a PDF becomes headings.
async function writeDocx(out, pages) {
    const sizes = pages.flatMap((p) => p.paragraphs.map((x) => x.size)).filter(Boolean).sort((a, b) => a - b);
    const body = sizes.length ? sizes[Math.floor(sizes.length / 2)] : 11;
    const children = [];
    pages.forEach((pg, i) => {
        for (const p of pg.paragraphs) {
            if (p.heading) {
                children.push(new Paragraph({ text: p.text, heading: [HeadingLevel.HEADING_1, HeadingLevel.HEADING_2, HeadingLevel.HEADING_3][Math.min(p.heading, 3) - 1] }));
                continue;
            }
            const big = p.size && p.size > body * 1.25;
            children.push(new Paragraph({
                heading: big ? (p.size > body * 1.7 ? HeadingLevel.HEADING_1 : HeadingLevel.HEADING_2) : undefined,
                spacing: { after: 120 },
                children: [new TextRun({ text: p.text, bold: !big && p.bold })],
            }));
        }
        if (i < pages.length - 1) children.push(new Paragraph({ children: [new PageBreak()] }));
    });
    const doc = new Document({
        styles: { default: { document: { run: { font: 'Calibri', size: 22 } } } },
        sections: [{ children: children.length ? children : [new Paragraph('')] }],
    });
    fs.writeFileSync(out, await Packer.toBuffer(doc));
}

// Markdown symbols -> plain text (for Word output).
const plainMd = (s) => s
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/(^|[^*])\*([^*]+)\*/g, '$1$2')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 ($2)')
    .replace(/^\s*[-*+]\s+/, '• ')
    .replace(/^>\s?/, '');

function textToPages(text, markdown) {
    const paragraphs = [];
    let inCode = false;
    for (const block of text.split(/\r?\n/)) {
        if (markdown && /^```/.test(block)) { inCode = !inCode; continue; }
        const m = markdown && !inCode && /^(#{1,6})\s+(.*)$/.exec(block);
        if (m) paragraphs.push({ text: plainMd(m[2]), heading: m[1].length });
        else if (markdown && !inCode && !block.trim()) continue; // blank lines just separate paragraphs
        else paragraphs.push({ text: markdown && !inCode ? plainMd(block) : block });
    }
    return [{ paragraphs }];
}

async function convertDocument(src, target, out, opts, onProgress, outFor) {
    const ext = path.extname(src).slice(1).toLowerCase();
    const title = path.basename(src, path.extname(src));

    if (ext === 'pdf') {
        if (target === 'png' || target === 'jpg') return host.pdfToImages(src, target, outFor, onProgress);
        const { pages } = await host.pdfText(src);
        if (!pages.some((p) => p.paragraphs.length)) {
            throw new Error('This PDF has no selectable text (it is probably scanned). Try converting it to PNG or JPG instead.');
        }
        if (target === 'txt') {
            return fs.writeFileSync(out, pages.map((p) => p.paragraphs.map((x) => x.text).join('\n\n')).join('\n\n\f\n\n'), 'utf8');
        }
        if (target === 'docx') return writeDocx(out, pages);
    }

    if (ext === 'docx') {
        if (target === 'txt') return fs.writeFileSync(out, (await mammoth.extractRawText({ path: src })).value, 'utf8');
        const { value } = await mammoth.convertToHtml({ path: src });
        if (target === 'html') return fs.writeFileSync(out, page(title, value), 'utf8');
        if (target === 'pdf') return host.htmlToPdf(page(title, value), out);
    }

    if (ext === 'txt' || ext === 'md') {
        const text = readText(src);
        if (target === 'pdf') {
            const body = ext === 'md' ? markdownToHtml(text) : `<pre style="font-family: Consolas, 'Courier New', monospace">${escapeHtml(text)}</pre>`;
            return host.htmlToPdf(page(title, body), out);
        }
        if (target === 'docx') return writeDocx(out, textToPages(text, ext === 'md'));
    }

    if (ext === 'html' || ext === 'htm') {
        if (target === 'pdf') return host.htmlFileToPdf(src, out);
        if (target === 'txt') return fs.writeFileSync(out, await host.htmlFileToText(src), 'utf8');
    }

    throw new Error(`Can't convert ${ext.toUpperCase()} to ${target.toUpperCase()}`);
}

module.exports = { convertDocument };
