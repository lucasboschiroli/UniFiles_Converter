// Which files the app understands, and what each kind can be turned into.

const CATEGORIES = {
    image: {
        label: 'Images',
        inputs: ['jpg', 'jpeg', 'png', 'webp', 'gif', 'avif', 'tif', 'tiff', 'bmp', 'ico', 'svg', 'heic', 'heif'],
        targets: ['jpg', 'png', 'webp', 'avif', 'gif', 'tiff', 'bmp', 'ico', 'pdf'],
        default: 'png',
    },
    video: {
        label: 'Videos',
        inputs: ['mp4', 'm4v', 'mov', 'mkv', 'webm', 'avi', 'wmv', 'flv', 'mpeg', 'mpg', '3gp', 'ts', 'mts', 'm2ts'],
        targets: ['mp4', 'webm', 'mkv', 'mov', 'avi', 'gif', 'mp3', 'm4a', 'wav', 'flac', 'ogg', 'opus'],
        default: 'mp4',
    },
    audio: {
        label: 'Audio',
        inputs: ['mp3', 'wav', 'ogg', 'oga', 'flac', 'm4a', 'aac', 'wma', 'opus', 'aiff', 'aif', 'amr'],
        targets: ['mp3', 'wav', 'ogg', 'flac', 'm4a', 'aac', 'opus'],
        default: 'mp3',
    },
    document: {
        label: 'Documents',
        inputs: ['pdf', 'docx', 'txt', 'md', 'html', 'htm'],
        // What each document type can become (PDFs also turn into page images).
        targetsByInput: {
            pdf: ['docx', 'txt', 'png', 'jpg'],
            docx: ['pdf', 'txt', 'html'],
            txt: ['pdf', 'docx'],
            md: ['pdf', 'docx'],
            html: ['pdf', 'txt'],
            htm: ['pdf', 'txt'],
        },
        default: 'pdf',
    },
    sheet: {
        label: 'Spreadsheets',
        inputs: ['xlsx', 'xls', 'xlsm', 'ods', 'csv', 'tsv'],
        targets: ['xlsx', 'csv', 'ods', 'pdf', 'html'],
        default: 'xlsx',
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

function targetsFor(file) {
    const ext = extOf(file);
    const cat = categoryOf(file);
    if (!cat) return [];
    const def = CATEGORIES[cat];
    const list = def.targetsByInput ? def.targetsByInput[ext] || [] : def.targets;
    // Re-saving in the same format is useful for images, video and audio
    // (resize, compress); for documents and sheets it would just be a copy.
    const same = (e) => e === ext || (ext === 'jpeg' && e === 'jpg') || (ext === 'tif' && e === 'tiff');
    return ['image', 'video', 'audio'].includes(cat) ? list : list.filter((t) => !same(t));
}

function defaultTarget(file) {
    const targets = targetsFor(file);
    const ext = extOf(file);
    const cat = categoryOf(file);
    if (!cat || !targets.length) return null;
    const preferred = { image: ext === 'png' ? 'jpg' : 'png', video: ext === 'mp4' ? 'mp3' : 'mp4', audio: ext === 'mp3' ? 'wav' : 'mp3', document: ext === 'pdf' ? 'docx' : 'pdf', sheet: ext === 'xlsx' ? 'csv' : 'xlsx' }[cat];
    return targets.includes(preferred) ? preferred : targets[0];
}

module.exports = { CATEGORIES, extOf, categoryOf, targetsFor, defaultTarget };
