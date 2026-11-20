// Runs a batch of conversions one after another and reports progress.

const fs = require('fs');
const path = require('path');
const { categoryOf } = require('./formats');
const { uniquePath, killCurrent } = require('./tools');
const { convertImage, imagesToPdf } = require('./convert/images');
const { convertMedia } = require('./convert/media');
const { convertDocument, writeDocx } = require('./convert/documents');
const { convertEbook } = require('./convert/ebooks');
const { convertComic, imagesToComic, uniqueDir } = require('./convert/comics');
const { convertSheet } = require('./convert/sheets');

let cancelled = false;
let busy = false;

const safeName = (s) => String(s).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').trim() || 'Sheet';

function friendly(err) {
    const msg = String(err && err.message || err);
    if (/unsupported image format|Input file contains unsupported/i.test(msg)) return 'This image format or file is not supported, or the file is damaged.';
    if (/Invalid data found when processing input|moov atom not found|could not find codec parameters/i.test(msg)) return 'The file is damaged or isn\'t really this format.';
    if (/Error while opening encoder|Unknown encoder|codec not currently supported/i.test(msg)) return 'This file\'s audio or video can\'t be stored in the chosen format. Try another format.';
    if (/EBUSY|EPERM|EACCES/i.test(msg)) return 'The file is open in another program or the folder is read-only.';
    if (/ENOSPC/i.test(msg)) return 'The disk is full.';
    if (/end of central directory|Corrupted zip|Can't find end/i.test(msg)) return 'The file is damaged or isn\'t really this format.';
    if (/Invalid PDF|PasswordException/i.test(msg)) return /password/i.test(msg) ? 'This PDF is password-protected.' : 'The PDF is damaged.';
    // Calibre (Python) errors for files that aren't really the format they claim.
    if (/struct\.error|Unknown book type|not a MOBI file|Invalid (MOBI|EPUB|AZW)|BadZipFile|No Book header|No such file or directory.*META-INF/i.test(msg)) {
        return "The file is damaged or isn't really this format.";
    }
    if (/DRM|DRMError|encrypted/i.test(msg) && !/password/i.test(msg)) return "This ebook is DRM-protected (copy-protected), so it can't be converted.";
    return msg.replace(/^Error:\s*/, '');
}

async function convertAll(jobs, options, emit) {
    busy = true;
    cancelled = false;
    const taken = new Set();
    let ok = 0, failed = 0;
    const firstOutputs = [];
    emit({ type: 'start', count: jobs.length });

    const dirFor = (src) => (options.outMode === 'folder' && options.outDir ? options.outDir : path.dirname(src));

    let queue = jobs;

    // All images going to PDF (or to a comic) become one file, in list order.
    if (options.mergePdf) {
        for (const kind of ['pdf', 'cbz', 'cbr']) {
            const group = queue.filter((j) => j.target === kind && categoryOf(j.path) === 'image');
            if (group.length < 2) continue;
            queue = queue.filter((j) => !group.includes(j));
            const first = group[0];
            const dir = dirFor(first.path);
            fs.mkdirSync(dir, { recursive: true });
            const out = uniquePath(dir, `${path.parse(first.path).name} (combined)`, kind, taken);
            group.forEach((j) => emit({ type: 'item', key: j.key, status: 'working', label: 'Combining' }));
            try {
                if (kind === 'pdf') await imagesToPdf(group.map((j) => j.path), out, options);
                else await imagesToComic(group.map((j) => j.path), kind, out);
                ok += group.length;
                firstOutputs.push(out);
                group.forEach((j) => emit({ type: 'item', key: j.key, status: 'done', label: 'Done', outputs: [out] }));
            } catch (err) {
                fs.rmSync(out, { force: true });
                failed += group.length;
                group.forEach((j) => emit({ type: 'item', key: j.key, status: 'error', label: 'Failed', error: friendly(err) }));
            }
        }
    }

    for (const job of queue) {
        if (cancelled) break;
        const src = job.path;
        const target = job.target;
        const category = categoryOf(src);
        const dir = dirFor(src);
        const base = path.parse(src).name;
        const created = [];

        const out = target === 'images' ? uniqueDir(dir, `${base} (pages)`) : uniquePath(dir, base, target, taken);
        const outFor = (i, count) => {
            const file = count === 1 ? out : uniquePath(dir, `${base} - page ${String(i).padStart(String(count).length, '0')}`, target, taken);
            created.push(file);
            return file;
        };
        const outForSheet = (name) => {
            const file = uniquePath(dir, `${base} - ${safeName(name)}`, 'csv', taken);
            created.push(file);
            return file;
        };
        const onProgress = (percent) => emit({ type: 'progress', key: job.key, percent });

        emit({ type: 'item', key: job.key, status: 'working', label: 'Converting' });
        try {
            if (!fs.existsSync(src)) throw new Error('The file was moved or deleted.');
            fs.mkdirSync(dir, { recursive: true });
            let result;
            if (category === 'image' && ['cbz', 'cbr'].includes(target)) result = await imagesToComic([src], target, out);
            else if (category === 'image') result = await convertImage(src, target, out, options);
            else if (category === 'video' || category === 'audio') result = await convertMedia(src, target, out, options, onProgress);
            else if (category === 'document') result = await convertDocument(src, target, out, options, onProgress, outFor);
            else if (category === 'ebook') result = await convertEbook(src, target, out, options, onProgress, { writeDocx });
            else if (category === 'comic') result = await convertComic(src, target, out, options, onProgress);
            else if (category === 'sheet') result = await convertSheet(src, target, out, options, onProgress, outFor, outForSheet);
            else throw new Error('This file type is not supported.');

            const outputs = Array.isArray(result) ? result : [out];
            ok++;
            firstOutputs.push(outputs[0]);
            emit({ type: 'item', key: job.key, status: 'done', label: outputs.length > 1 ? `Done · ${outputs.length} files` : 'Done', outputs });
        } catch (err) {
            // Remove half-written files so nothing broken is left behind.
            for (const f of [out, ...created]) fs.rmSync(f, { force: true, recursive: true });
            if (cancelled) {
                emit({ type: 'item', key: job.key, status: 'cancelled', label: 'Cancelled' });
                break;
            }
            failed++;
            emit({ type: 'item', key: job.key, status: 'error', label: 'Failed', error: friendly(err) });
        }
    }

    busy = false;
    emit({ type: 'finished', ok, failed, cancelled, firstOutput: firstOutputs[0] || null });
}

function cancel() {
    cancelled = true;
    killCurrent();
}

module.exports = { convertAll, cancel, isBusy: () => busy };
