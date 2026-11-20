const $ = (id) => document.getElementById(id);

const CAT_ORDER = ['image', 'video', 'audio', 'document', 'ebook', 'comic', 'sheet'];
const CAT_LABEL = { image: 'Images', video: 'Videos', audio: 'Audio', document: 'Documents', ebook: 'Ebooks', comic: 'Comics', sheet: 'Spreadsheets' };
const CALIBRE_URL = 'https://calibre-ebook.com/download_windows';

const state = {
    settings: null,
    tools: {},       // { ffmpeg, calibre, rar } paths, or null when not installed
    files: [],       // { key, path, name, ext, size, category, targets, target, status, label, percent, error, outputs, thumb }
    busy: false,
    run: null,
    nextKey: 1,
    notice: '',
};

// ---------------------------------------------------------------- helpers
function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
}

function fmtSize(bytes) {
    if (!bytes) return '';
    const units = ['B', 'KB', 'MB', 'GB'];
    let i = 0, n = bytes;
    while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
    return `${n >= 10 || i === 0 ? Math.round(n) : n.toFixed(1)} ${units[i]}`;
}

const fileName = (p) => p.split(/[\\/]/).pop();

function saveSetting(patch) {
    Object.assign(state.settings, patch);
    window.api.setSettings(patch);
}

// --------------------------------------------------------------- titlebar
$('winMinimize').onclick = () => window.api.minimize();
$('winMaximize').onclick = () => window.api.maximize();
$('winClose').onclick = () => window.api.close();
window.api.onMaximized((max) => {
    $('winMaximize').innerHTML = max ? '&#10697;' : '&#9633;';
    $('winMaximize').title = max ? 'Restore' : 'Maximize';
});

// ------------------------------------------------------------- add files
function addFiles(list) {
    const known = new Set(state.files.map((f) => f.path.toLowerCase()));
    const unsupported = [];
    const needCalibre = [];
    let added = 0;
    for (const f of list) {
        if (f.needs === 'calibre') { needCalibre.push(f.name); continue; }
        if (!f.category || !f.targets.length) { unsupported.push(f.name); continue; }
        if (known.has(f.path.toLowerCase())) continue;
        known.add(f.path.toLowerCase());
        state.files.push({ ...f, key: String(state.nextKey++), status: 'waiting', label: 'Ready', percent: 0, error: null, outputs: null, thumb: null });
        added++;
    }
    const notes = [];
    if (needCalibre.length) notes.push(`${needCalibre.length} Kindle book${needCalibre.length > 1 ? 's' : ''} (AZW3/MOBI) ${needCalibre.length > 1 ? 'need' : 'needs'} the free Calibre app: install it, then press "Check again"`);
    if (unsupported.length) notes.push(`Skipped ${unsupported.length} file${unsupported.length > 1 ? 's' : ''} that can't be converted: ${unsupported.slice(0, 3).join(', ')}${unsupported.length > 3 ? '…' : ''}`);
    state.notice = notes.join('  ·  ');
    state.pendingKindle = needCalibre.length ? list.filter((f) => f.needs === 'calibre').map((f) => f.path) : [];
    if (!state.files.length && notes.length) $('emptyNotice').textContent = state.notice;
    paintToolHint();
    if (added || notes.length) render();
    loadThumbs();
}

$('addFilesBtn').onclick = async () => !state.busy && addFiles(await window.api.pickFiles());
$('addFolderBtn').onclick = async () => !state.busy && addFiles(await window.api.pickFilesFolder());

// Drag and drop anywhere on the window.
let dragDepth = 0;
window.addEventListener('dragenter', (e) => {
    if (!e.dataTransfer.types.includes('Files') || state.busy) return;
    e.preventDefault();
    dragDepth++;
    $('dropOverlay').classList.remove('hidden');
});
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('dragleave', () => {
    dragDepth = Math.max(0, dragDepth - 1);
    if (!dragDepth) $('dropOverlay').classList.add('hidden');
});
window.addEventListener('drop', async (e) => {
    e.preventDefault();
    dragDepth = 0;
    $('dropOverlay').classList.add('hidden');
    if (state.busy || !e.dataTransfer.files.length) return;
    const described = await window.api.describeDropped(e.dataTransfer.files);
    if (!described.length) {
        // e.g. an image dragged straight out of a web page: not a file on disk yet.
        state.notice = "Those items aren't files on your computer. Save them first, then add them.";
        if (state.files.length) updateHead(); else alert(state.notice);
        return;
    }
    addFiles(described);
});

// Thumbnails for images and videos, a few at a time.
let thumbsRunning = 0;
function loadThumbs() {
    while (thumbsRunning < 3) {
        const f = state.files.find((x) => x.thumb === null && ['image', 'video', 'comic', 'ebook'].includes(x.category));
        if (!f) return;
        f.thumb = false; // requested
        thumbsRunning++;
        window.api.thumb(f.path).then((url) => {
            thumbsRunning--;
            if (url) {
                f.thumb = url;
                const box = document.querySelector(`#item-${f.key} .thumb`);
                if (box) paintThumb(f, box);
            }
            loadThumbs();
        });
    }
}

// ----------------------------------------------------------------- render
function render() {
    const has = state.files.length > 0;
    $('emptyState').classList.toggle('hidden', has);
    $('workspace').classList.toggle('hidden', !has);
    if (!has) return;
    renderBulk();
    renderOptions();
    renderList();
    updateHead();
}

function presentCats() {
    return CAT_ORDER.filter((c) => state.files.some((f) => f.category === c));
}

function renderBulk() {
    const rows = $('bulkRows');
    rows.innerHTML = '';
    for (const cat of presentCats()) {
        const files = state.files.filter((f) => f.category === cat);
        const targets = [...new Set(files.flatMap((f) => f.targets))];
        const shared = files.every((f) => f.target === files[0].target) ? files[0].target : null;

        const row = el('div', 'bulk-row');
        const label = el('div', 'cat');
        const dot = el('span', 'dot');
        dot.style.background = `var(--c-${cat})`;
        label.append(dot, document.createTextNode(CAT_LABEL[cat]), el('small', null, `(${files.length})`));
        const seg = el('div', 'seg');
        for (const t of targets) {
            const b = el('button', t === shared ? 'on' : '', t);
            b.title = `Convert all ${CAT_LABEL[cat].toLowerCase()} to ${t.toUpperCase()}`;
            b.onclick = () => {
                if (state.busy) return;
                for (const f of files) if (f.targets.includes(t)) { f.target = t; resetIfDone(f); }
                render();
            };
            seg.appendChild(b);
        }
        row.append(label, seg);
        rows.appendChild(row);
    }
}

function resetIfDone(f) {
    if (f.status !== 'waiting') Object.assign(f, { status: 'waiting', label: 'Ready', percent: 0, error: null, outputs: null });
}

function renderOptions() {
    const cats = presentCats();
    document.querySelectorAll('.options-grid .opt').forEach((o) => o.classList.toggle('hidden', !cats.includes(o.dataset.cat)));
    $('optionsCard').classList.toggle('hidden', !cats.some((c) => ['image', 'video', 'audio'].includes(c)));
    const s = state.settings;
    const bits = [];
    if (cats.includes('image')) bits.push(`Quality ${s.quality}`, s.maxSize ? `max ${s.maxSize} px` : 'original size');
    if (cats.includes('video')) bits.push(`${{ high: 'high', balanced: 'balanced', small: 'smaller' }[s.videoQuality]} video`, s.resolution ? `${s.resolution}p` : 'original resolution');
    if (cats.includes('audio') || cats.includes('video')) bits.push(`${s.audioBitrate} kbps audio`);
    $('optionsSummary').textContent = bits.join('  ·  ');
    $('qualityValue').textContent = s.quality;
}

function renderList() {
    const list = $('items');
    list.innerHTML = '';
    for (const f of state.files) list.appendChild(renderItem(f));
}

function paintThumb(f, box) {
    box.innerHTML = '';
    if (f.thumb) {
        const img = el('img');
        img.src = f.thumb;
        img.alt = '';
        box.appendChild(img);
        box.appendChild(el('span', 'tag', f.ext));
    } else {
        const ext = el('span', 'ext', f.ext);
        ext.style.background = `var(--c-${f.category})`;
        box.appendChild(ext);
    }
}

function renderItem(f) {
    const li = el('li', 'item');
    li.id = `item-${f.key}`;

    const thumb = el('div', 'thumb');
    paintThumb(f, thumb);

    const body = el('div', 'item-body');
    const name = el('div', 'item-name', f.name);
    name.title = f.path;
    const sub = el('div', 'item-sub');
    const bar = el('div', 'bar hidden');
    bar.appendChild(el('div', 'bar-fill'));
    body.append(name, sub, bar);

    const target = el('div', 'item-target');
    const select = el('select', 'pill-select');
    for (const t of f.targets) {
        const o = el('option', null, t.toUpperCase());
        o.value = t;
        select.appendChild(o);
    }
    select.value = f.target;
    select.onchange = () => { f.target = select.value; resetIfDone(f); renderBulk(); paintItem(f); updateHead(); };
    target.append(el('span', null, '→'), select);

    const status = el('span', 'status');
    const actions = el('div', 'item-actions');

    li.append(thumb, body, target, status, actions);
    paintItem(f, li);
    return li;
}

function statusClass(s) {
    return { working: 'active', done: 'done', error: 'error', cancelled: 'cancelled' }[s] || '';
}

function paintItem(f, li = $(`item-${f.key}`)) {
    if (!li) return;
    li.classList.toggle('active', f.status === 'working');
    const status = li.querySelector('.status');
    status.className = `status ${statusClass(f.status)}`;
    status.textContent = f.label;

    const sub = li.querySelector('.item-sub');
    sub.classList.toggle('err', f.status === 'error');
    if (f.status === 'error') sub.textContent = f.error;
    else if (f.status === 'done' && f.outputs) sub.textContent = `Saved as ${f.outputs.map(fileName).slice(0, 2).join(', ')}${f.outputs.length > 2 ? '…' : ''}`;
    else sub.textContent = [fmtSize(f.size), f.ext.toUpperCase()].filter(Boolean).join('  ·  ');

    // Media conversions report real progress; everything else is quick.
    const bar = li.querySelector('.bar');
    const media = f.category === 'video' || f.category === 'audio' || (f.category === 'document' && ['png', 'jpg'].includes(f.target));
    bar.classList.toggle('hidden', f.status !== 'working');
    bar.classList.toggle('indeterminate', f.status === 'working' && !(media && f.percent > 0));
    bar.firstChild.style.width = `${f.percent || 0}%`;

    const actions = li.querySelector('.item-actions');
    actions.innerHTML = '';
    if (f.status === 'done' && f.outputs) {
        const open = el('button', 'ghost-btn small', 'Open');
        open.onclick = () => window.api.openFile(f.outputs[0]);
        const show = el('button', 'ghost-btn small', 'Show');
        show.title = 'Show in folder';
        show.onclick = () => window.api.showItem(f.outputs[0]);
        actions.append(open, show);
    } else if (f.status !== 'working') {
        const rm = el('button', 'remove-btn', '✕');
        rm.title = 'Remove from list';
        rm.onclick = () => {
            if (state.busy) return;
            state.files = state.files.filter((x) => x !== f);
            render();
        };
        actions.appendChild(rm);
    }
    li.querySelector('select').value = f.target;
}

function pending() {
    return state.files.filter((f) => f.status !== 'done');
}

function updateHead() {
    const n = state.files.length;
    $('listTitle').textContent = `${n} file${n === 1 ? '' : 's'}`;
    const total = state.files.reduce((s, f) => s + (f.size || 0), 0);
    $('listMeta').textContent = state.notice || fmtSize(total);
    $('listMeta').style.color = state.notice ? 'var(--err)' : '';
    const todo = pending().length;
    $('convertBtn').textContent = todo === 0 ? 'Convert again' : todo === n ? `Convert ${n === 1 ? 'file' : `all ${n}`}` : `Convert ${todo} remaining`;
    $('convertBtn').disabled = state.busy || n === 0;
    $('clearBtn').disabled = state.busy;
}

// ---------------------------------------------------------------- options
function bindSeg(segId, key, { numeric = false } = {}) {
    const seg = $(segId);
    const paint = () => seg.querySelectorAll('button').forEach((b) =>
        b.classList.toggle('on', String(state.settings[key]) === b.dataset.value));
    seg.classList.add('lower');
    seg.addEventListener('click', (e) => {
        const b = e.target.closest('button');
        if (!b || state.busy) return;
        saveSetting({ [key]: numeric ? Number(b.dataset.value) : b.dataset.value });
        paint();
        renderOptions();
        if (key === 'outMode') paintFolder();
    });
    paint();
}

function paintFolder() {
    const folder = state.settings.outMode === 'folder';
    $('folderBtn').classList.toggle('hidden', !folder);
    $('folderBtn').textContent = state.settings.outDir;
    $('folderBtn').title = state.settings.outDir;
}

async function initOptions() {
    state.settings = await window.api.getSettings();
    bindSeg('maxSizeSeg', 'maxSize', { numeric: true });
    bindSeg('videoQualitySeg', 'videoQuality');
    bindSeg('resolutionSeg', 'resolution', { numeric: true });
    bindSeg('audioBitrateSeg', 'audioBitrate', { numeric: true });
    bindSeg('outModeSeg', 'outMode');
    paintFolder();

    $('qualityRange').value = state.settings.quality;
    $('qualityRange').oninput = (e) => { state.settings.quality = Number(e.target.value); renderOptions(); };
    $('qualityRange').onchange = (e) => saveSetting({ quality: Number(e.target.value) });
    $('mergePdfChk').checked = state.settings.mergePdf;
    $('mergePdfChk').onchange = (e) => saveSetting({ mergePdf: e.target.checked });

    $('folderBtn').onclick = async () => {
        const dir = await window.api.pickFolder(state.settings.outDir);
        if (dir) { saveSetting({ outDir: dir }); paintFolder(); }
    };
}

// "Get Calibre" / "Check again": Kindle formats appear once Calibre is installed.
function paintToolHint() {
    const want = !state.tools.calibre && (state.pendingKindle?.length || state.files.some((f) => ['ebook', 'document'].includes(f.category)));
    $('toolHint').classList.toggle('hidden', !want);
}
$('getCalibreBtn').onclick = () => window.api.openLink(CALIBRE_URL);
$('recheckBtn').onclick = async () => {
    const { status, files } = await window.api.refreshTools([...state.files.map((f) => f.path), ...(state.pendingKindle || [])]);
    state.tools = status;
    // Refresh every file's list of formats with what's available now.
    const fresh = new Map(files.map((f) => [f.path.toLowerCase(), f]));
    for (const f of state.files) {
        const n = fresh.get(f.path.toLowerCase());
        if (n) { f.targets = n.targets; if (!f.targets.includes(f.target)) f.target = n.target; }
    }
    const pending = files.filter((f) => (state.pendingKindle || []).some((p) => p.toLowerCase() === f.path.toLowerCase()));
    state.pendingKindle = [];
    state.notice = status.calibre ? '' : 'Calibre still wasn’t found. If you just installed it, try again in a moment.';
    if (pending.length) addFiles(pending); else { paintToolHint(); render(); }
};

async function initTools() {
    const t = await window.api.toolStatus();
    state.tools = t;
    const badge = $('toolBadge');
    if (t.ffmpeg) {
        badge.textContent = 'Ready';
        badge.title = [`ffmpeg: ${t.ffmpeg}`, `Calibre (Kindle formats): ${t.calibre || 'not installed'}`, `WinRAR (CBR output): ${t.rar || 'not installed'}`].join('\n');
    } else {
        badge.textContent = 'ffmpeg missing';
        badge.classList.add('bad');
        badge.title = 'Video and audio conversions need ffmpeg. Install it with: winget install ffmpeg';
    }
}

// ---------------------------------------------------------------- convert
function setBusy(on) {
    state.busy = on;
    document.body.classList.toggle('busy', on);
    $('cancelBtn').classList.toggle('hidden', !on);
    $('convertBtn').classList.toggle('hidden', on);
    $('addFilesBtn').disabled = on;
    $('addFolderBtn').disabled = on;
    document.querySelectorAll('.seg, #qualityRange, #mergePdfChk, #folderBtn')
        .forEach((x) => { x.style.pointerEvents = on ? 'none' : ''; x.style.opacity = on ? '0.55' : ''; });
    updateHead();
}

function findFile(key) {
    return state.files.find((f) => f.key === key);
}

function paintOverall() {
    const r = state.run;
    if (!r || r.finished) return;
    const cur = state.files.find((f) => f.status === 'working');
    const partial = cur ? (cur.percent || 0) / 100 : 0;
    $('overallFill').style.width = `${Math.min(100, ((r.done + partial) / r.count) * 100)}%`;
    $('overallText').textContent = `Converting ${Math.min(r.done + 1, r.count)} of ${r.count}…`;
}

$('convertBtn').onclick = async () => {
    if (state.busy || !state.files.length) return;
    let jobs = pending();
    if (!jobs.length) jobs = state.files; // "Convert again"
    for (const f of jobs) {
        Object.assign(f, { status: 'waiting', label: 'Waiting', percent: 0, error: null, outputs: null });
        paintItem(f);
    }
    state.notice = '';
    state.run = { count: jobs.length, done: 0, finished: false, firstOutput: null };
    $('overall').classList.remove('hidden');
    $('overallShow').classList.add('hidden');
    setBusy(true);
    paintOverall();
    const s = state.settings;
    await window.api.startConvert(jobs.map((f) => ({ key: f.key, path: f.path, target: f.target })), {
        outMode: s.outMode, outDir: s.outDir, quality: s.quality, maxSize: s.maxSize,
        videoQuality: s.videoQuality, resolution: s.resolution, audioBitrate: s.audioBitrate, mergePdf: s.mergePdf,
    });
};

$('cancelBtn').onclick = () => {
    if (!state.busy) return;
    $('overallText').textContent = 'Cancelling…';
    window.api.cancelConvert();
};

$('clearBtn').onclick = () => {
    if (state.busy) return;
    state.files = [];
    state.notice = '';
    $('overall').classList.add('hidden');
    render();
};

$('overallShow').onclick = () => state.run && state.run.firstOutput && window.api.showItem(state.run.firstOutput);

window.api.onConvertEvent((ev) => {
    const r = state.run;
    if (!r) return;
    if (ev.type === 'start') return;
    if (ev.type === 'finished') {
        r.finished = true;
        r.firstOutput = ev.firstOutput;
        const parts = [`${ev.ok} converted`];
        if (ev.failed) parts.push(`${ev.failed} failed`);
        $('overallText').textContent = `${ev.cancelled ? 'Cancelled' : 'Finished'} — ${parts.join(', ')}`;
        $('overallFill').style.width = ev.cancelled ? $('overallFill').style.width : '100%';
        $('overallShow').classList.toggle('hidden', !ev.firstOutput);
        for (const f of state.files) if (f.status === 'waiting' && ev.cancelled) { f.label = 'Ready'; paintItem(f); }
        setBusy(false);
        return;
    }
    const f = findFile(ev.key);
    if (!f) return;
    if (ev.type === 'progress') {
        f.percent = ev.percent;
        f.label = `${Math.floor(ev.percent)}%`;
    } else if (ev.type === 'item') {
        f.status = ev.status;
        f.label = ev.label;
        if (ev.error) f.error = ev.error;
        if (ev.outputs) f.outputs = ev.outputs;
        if (ev.status === 'working') $(`item-${f.key}`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
        if (['done', 'error'].includes(ev.status)) r.done++;
    }
    paintItem(f);
    paintOverall();
    if (ev.type === 'item' && ev.status !== 'working') updateHead();
});

// ------------------------------------------------------------------- boot
initOptions().then(render);
initTools();
