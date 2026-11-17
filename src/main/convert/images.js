// Image conversions with sharp. Formats sharp can't read (BMP, ICO, HEIC…)
// are first decoded to PNG with ffmpeg; BMP and ICO are written by hand.

const sharp = require('sharp');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { PDFDocument } = require('pdf-lib');
const { runFfmpeg } = require('../tools');

sharp.cache(false); // don't keep files locked on Windows after converting

async function decodeWithFfmpeg(src) {
    const tmp = path.join(os.tmpdir(), `unifiles-${process.pid}-${Date.now()}.png`);
    try {
        await runFfmpeg(['-i', src, '-frames:v', '1', tmp]);
        return fs.readFileSync(tmp);
    } finally {
        fs.rmSync(tmp, { force: true });
    }
}

// Opens any supported image as a sharp pipeline (auto-rotated per EXIF).
async function open(src, { animated = false } = {}) {
    try {
        const img = sharp(src, { animated, limitInputPixels: false });
        await img.metadata();
        return img.rotate();
    } catch {
        try {
            return sharp(await decodeWithFfmpeg(src)).rotate();
        } catch {
            throw new Error('This image is damaged or in a format that can\'t be read.');
        }
    }
}

function resized(img, maxSize) {
    if (!maxSize) return img;
    return img.resize({ width: maxSize, height: maxSize, fit: 'inside', withoutEnlargement: true });
}

// 24-bit BMP (transparent areas become white, which every viewer supports).
async function toBmp(img) {
    const { data, info } = await img.flatten({ background: '#ffffff' }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    const { width, height } = info;
    const rowSize = Math.ceil((width * 3) / 4) * 4;
    const out = Buffer.alloc(54 + rowSize * height);
    out.write('BM', 0);
    out.writeUInt32LE(out.length, 2);
    out.writeUInt32LE(54, 10);
    out.writeUInt32LE(40, 14);
    out.writeInt32LE(width, 18);
    out.writeInt32LE(height, 22);
    out.writeUInt16LE(1, 26);
    out.writeUInt16LE(24, 28);
    out.writeUInt32LE(rowSize * height, 34);
    out.writeInt32LE(2835, 38);
    out.writeInt32LE(2835, 42);
    for (let y = 0; y < height; y++) {
        const row = 54 + (height - 1 - y) * rowSize; // bottom-up
        for (let x = 0; x < width; x++) {
            const s = (y * width + x) * 3;
            out[row + x * 3] = data[s + 2];
            out[row + x * 3 + 1] = data[s + 1];
            out[row + x * 3 + 2] = data[s];
        }
    }
    return out;
}

// Multi-size ICO with PNG-compressed entries (16 up to 256 px).
async function toIco(img) {
    const png = await img.png().toBuffer();
    const { width, height } = await sharp(png).metadata();
    const largest = Math.max(width, height);
    const sizes = [256, 128, 64, 48, 32, 16].filter((s) => s <= Math.max(16, largest));
    const images = await Promise.all(sizes.map((s) => sharp(png)
        .resize(s, s, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toBuffer()));
    const header = Buffer.alloc(6 + 16 * images.length);
    header.writeUInt16LE(0, 0);
    header.writeUInt16LE(1, 2);
    header.writeUInt16LE(images.length, 4);
    let offset = header.length;
    images.forEach((buf, i) => {
        const e = 6 + i * 16;
        header[e] = sizes[i] >= 256 ? 0 : sizes[i];
        header[e + 1] = sizes[i] >= 256 ? 0 : sizes[i];
        header.writeUInt16LE(1, e + 4);
        header.writeUInt16LE(32, e + 6);
        header.writeUInt32LE(buf.length, e + 8);
        header.writeUInt32LE(offset, e + 12);
        offset += buf.length;
    });
    return Buffer.concat([header, ...images]);
}

// Adds one image as a page sized to the picture (at 96 dpi).
async function addPdfPage(pdf, src, opts) {
    const img = resized(await open(src), opts.maxSize);
    const { hasAlpha } = await img.metadata();
    const buf = hasAlpha ? await img.png().toBuffer() : await img.jpeg({ quality: opts.quality }).toBuffer();
    const embedded = hasAlpha ? await pdf.embedPng(buf) : await pdf.embedJpg(buf);
    const w = embedded.width * 0.75, h = embedded.height * 0.75;
    const page = pdf.addPage([w, h]);
    page.drawImage(embedded, { x: 0, y: 0, width: w, height: h });
}

async function imagesToPdf(sources, out, opts) {
    const pdf = await PDFDocument.create();
    for (const src of sources) await addPdfPage(pdf, src, opts);
    fs.writeFileSync(out, await pdf.save());
}

async function convertImage(src, target, out, opts) {
    const quality = opts.quality || 90;
    if (target === 'pdf') return imagesToPdf([src], out, opts);

    const ext = path.extname(src).slice(1).toLowerCase();
    const animated = ['gif', 'webp'].includes(ext) && ['gif', 'webp'].includes(target);
    const img = resized(await open(src, { animated }), opts.maxSize);

    let buf;
    switch (target) {
        case 'jpg': buf = await img.flatten({ background: '#ffffff' }).jpeg({ quality, mozjpeg: true }).toBuffer(); break;
        case 'png': buf = await img.png({ compressionLevel: 9, adaptiveFiltering: true }).toBuffer(); break;
        case 'webp': buf = await img.webp({ quality }).toBuffer(); break;
        case 'avif': buf = await img.avif({ quality: Math.max(30, Math.round(quality * 0.65)) }).toBuffer(); break;
        case 'gif': buf = await img.gif().toBuffer(); break;
        case 'tiff': buf = await img.tiff({ compression: 'lzw' }).toBuffer(); break;
        case 'bmp': buf = await toBmp(img); break;
        case 'ico': buf = await toIco(img); break;
        default: throw new Error(`Can't convert images to ${target.toUpperCase()}`);
    }
    fs.writeFileSync(out, buf);
}

async function imageThumb(src) {
    const img = await open(src);
    const buf = await img.resize(160, 120, { fit: 'cover' }).jpeg({ quality: 70 }).toBuffer();
    return `data:image/jpeg;base64,${buf.toString('base64')}`;
}

module.exports = { convertImage, imagesToPdf, imageThumb };
