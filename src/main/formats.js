// Which files the app understands, and what each kind can be turned into.
// Some targets depend on optional programs found on the PC (see tools.js):
//   caps.rar     - WinRAR's Rar.exe, needed to *write* CBR (RAR is a closed format)
//   caps.calibre - Calibre's ebook-convert, needed for Kindle formats (AZW3, MOBI)

const KINDLE = ['azw3', 'mobi'];

const CATEGORIES = {
    image: {
        label: 'Images',
        inputs: ['jpg', 'jpeg', 'png', 'webp', 'gif', 'avif', 'tif', 'tiff', 'bmp', 'ico', 'svg', 'heic', 'heif'],
        targets: ['jpg', 'png', 'webp', 'avif', 'gif', 'tiff', 'bmp', 'ico', 'pdf', 'cbz'],
    },
    video: {
        label: 'Videos',
        inputs: ['mp4', 'm4v', 'mov', 'mkv', 'webm', 'avi', 'wmv', 'flv', 'mpeg', 'mpg', '3gp', 'ts', 'mts', 'm2ts'],
        targets: ['mp4', 'webm', 'mkv', 'mov', 'avi', 'gif', 'mp3', 'm4a', 'wav', 'flac', 'ogg', 'opus'],
    },
    audio: {
        label: 'Audio',
        inputs: ['mp3', 'wav', 'ogg', 'oga', 'flac', 'm4a', 'aac', 'wma', 'opus', 'aiff', 'aif', 'amr'],
        targets: ['mp3', 'wav', 'ogg', 'flac', 'm4a', 'aac', 'opus'],
    },
    document: {
        label: 'Documents',
        inputs: ['pdf', 'docx', 'txt', 'md', 'html', 'htm'],
        // What each document type can become.
        targetsByInput: {
            pdf: ['docx', 'txt', 'epub', 'cbz', 'png', 'jpg'],
            docx: ['pdf', 'txt', 'html', 'epub', ...KINDLE],
            txt: ['pdf', 'docx', 'epub', ...KINDLE],
            md: ['pdf', 'docx', 'epub', ...KINDLE],
            html: ['pdf', 'txt', 'epub', ...KINDLE],
            htm: ['pdf', 'txt', 'epub', ...KINDLE],
        },
    },
    ebook: {
        label: 'Ebooks',
        inputs: ['epub', 'fb2', 'azw3', 'azw', 'mobi', 'prc'],
        targets: ['epub', ...KINDLE, 'pdf', 'docx', 'txt', 'html'],
    },
    comic: {
        label: 'Comics',
        inputs: ['cbz', 'cbr'],
        // "images" = every page saved as a picture in a folder.
        targets: ['cbz', 'cbr', 'pdf', 'epub', 'images'],
    },
    sheet: {
        label: 'Spreadsheets',
        inputs: ['xlsx', 'xls', 'xlsm', 'ods', 'csv', 'tsv'],
        targets: ['xlsx', 'csv', 'ods', 'pdf', 'html'],
    },
};

const extOf = (file) => {
    const m = /\.([^.\\/]+)$/.exec(file);
    return m ? m[1].toLowerCase() : '';
};

function categoryOf(file) {
    const ext = extOf(file);
    for (const [key, cat] of Object.entries(CATEGORIES)) {
        if (cat.inputs.includes(ext)) return key;
    }
    return null;
}

// Why a file or target isn't available, if it isn't (for messages in the UI).
function missingTool(ext, caps = {}) {
    if ((KINDLE.includes(ext) || ext === 'azw' || ext === 'prc') && !caps.calibre) return 'calibre';
    if (ext === 'cbr' && !caps.rar) return 'rar';
    return null;
}

function targetsFor(file, caps = {}) {
    const ext = extOf(file);
    const cat = categoryOf(file);
    if (!cat) return [];
    // Kindle files can only be read with Calibre.
    if (['azw3', 'azw', 'mobi', 'prc'].includes(ext) && !caps.calibre) return [];
    const def = CATEGORIES[cat];
    let list = def.targetsByInput ? def.targetsByInput[ext] || [] : def.targets;
    list = list.filter((t) => !missingTool(t, caps) || t === 'cbr' && ext === 'cbr');
    // Re-saving in the same format is useful for images, video and audio
    // (resize, compress); for everything else it would just be a copy.
    const same = (e) => e === ext || (ext === 'jpeg' && e === 'jpg') || (ext === 'tif' && e === 'tiff') ||
        (['azw', 'azw3'].includes(ext) && e === 'azw3') || (['mobi', 'prc'].includes(ext) && e === 'mobi');
    return ['image', 'video', 'audio'].includes(cat) ? list : list.filter((t) => !same(t));
}

function defaultTarget(file, caps = {}) {
    const targets = targetsFor(file, caps);
    const ext = extOf(file);
    const cat = categoryOf(file);
    if (!cat || !targets.length) return null;
    const preferred = {
        image: ext === 'png' ? 'jpg' : 'png',
        video: ext === 'mp4' ? 'mp3' : 'mp4',
        audio: ext === 'mp3' ? 'wav' : 'mp3',
        document: ext === 'pdf' ? 'docx' : 'pdf',
        ebook: ext === 'epub' ? (caps.calibre ? 'azw3' : 'pdf') : 'epub',
        comic: ext === 'cbz' ? 'pdf' : 'cbz',
        sheet: ext === 'xlsx' ? 'csv' : 'xlsx',
    }[cat];
    return targets.includes(preferred) ? preferred : targets[0];
}

module.exports = { CATEGORIES, KINDLE, extOf, categoryOf, targetsFor, defaultTarget, missingTool };
