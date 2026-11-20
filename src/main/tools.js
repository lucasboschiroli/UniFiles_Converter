// Shared helpers: finding ffmpeg, running it with progress, safe output names.

const { app } = require('electron');
const { spawn, spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const isWin = process.platform === 'win32';
const exe = (name) => (isWin ? `${name}.exe` : name);

function binDir() {
    return app.isPackaged ? path.join(process.resourcesPath, 'bin') : path.join(__dirname, '..', '..', 'bin');
}

const toolCache = {};
function findTool(name) {
    if (name in toolCache) return toolCache[name];
    const bundled = path.join(binDir(), exe(name));
    let found = null;
    if (fs.existsSync(bundled)) found = bundled;
    else {
        const r = spawnSync(isWin ? 'where' : 'which', [name], { encoding: 'utf8', windowsHide: true });
        if (r.status === 0) found = r.stdout.split(/\r?\n/)[0].trim() || null;
    }
    toolCache[name] = found;
    return found;
}

// Optional programs installed on the PC, looked up in their usual places.
function findInstalled(name, candidates) {
    const key = `installed:${name}`;
    if (key in toolCache) return toolCache[key];
    const roots = [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs')].filter(Boolean);
    let found = null;
    for (const root of roots) {
        for (const rel of candidates) {
            const p = path.join(root, rel);
            if (fs.existsSync(p)) { found = p; break; }
        }
        if (found) break;
    }
    if (!found) {
        const r = spawnSync(isWin ? 'where' : 'which', [name], { encoding: 'utf8', windowsHide: true });
        if (r.status === 0) found = r.stdout.split(/\r?\n/)[0].trim() || null;
    }
    toolCache[key] = found;
    return found;
}

// Calibre's converter: the only practical way to read and write Kindle formats.
const findCalibre = () => findInstalled('ebook-convert', ['Calibre2\\ebook-convert.exe', 'Calibre\\ebook-convert.exe']);
// WinRAR's command-line tool: needed to create .cbr (RAR) files.
const findRar = () => findInstalled('rar', ['WinRAR\\Rar.exe']);

function capabilities() {
    return { calibre: !!findCalibre(), rar: !!findRar() };
}

// Forget what was found, so programs installed while the app is open are noticed.
function refreshTools() {
    for (const k of Object.keys(toolCache)) delete toolCache[k];
}

// Runs any helper program, tracked so Cancel can stop it.
function runTool(cmd, args, { onLine } = {}) {
    return new Promise((resolve, reject) => {
        const child = spawn(cmd, args, { windowsHide: true });
        current = child;
        let out = '';
        const feed = (chunk) => {
            const text = chunk.toString();
            out += text;
            if (onLine) text.split(/\r?\n/).forEach((l) => l.trim() && onLine(l.trim()));
        };
        child.stdout.on('data', feed);
        child.stderr.on('data', feed);
        child.on('error', (err) => { current = null; reject(err); });
        child.on('close', (code) => {
            current = null;
            if (code === 0) return resolve(out);
            const lines = out.trim().split(/\r?\n/).filter(Boolean);
            const reason = [...lines].reverse().find((l) => /error|cannot|failed|not |invalid|unsupported|drm/i.test(l));
            reject(new Error((reason || lines[lines.length - 1] || `${path.basename(cmd)} exited with code ${code}`).trim()));
        });
    });
}

// Never overwrite: "photo.png" -> "photo (1).png" -> "photo (2).png"…
function uniquePath(dir, base, ext, taken = new Set()) {
    let candidate = path.join(dir, `${base}.${ext}`);
    for (let n = 1; fs.existsSync(candidate) || taken.has(candidate.toLowerCase()); n++) {
        candidate = path.join(dir, `${base} (${n}).${ext}`);
    }
    taken.add(candidate.toLowerCase());
    return candidate;
}

let current = null;

function killCurrent() {
    if (current && current.pid) {
        if (isWin) spawnSync('taskkill', ['/pid', String(current.pid), '/T', '/F'], { windowsHide: true });
        else current.kill('SIGTERM');
    }
}

// Runs ffmpeg and reports progress (0–100) using the input's duration.
function runFfmpeg(args, { duration, onProgress, track = true } = {}) {
    const ffmpeg = findTool('ffmpeg');
    if (!ffmpeg) return Promise.reject(new Error('ffmpeg was not found. Install it with: winget install ffmpeg'));
    return new Promise((resolve, reject) => {
        const child = spawn(ffmpeg, ['-hide_banner', '-nostdin', '-y', '-progress', 'pipe:1', '-nostats', ...args], { windowsHide: true });
        if (track) current = child;
        let stderr = '';
        let total = duration || 0;
        child.stdout.on('data', (chunk) => {
            const m = /out_time_us=(\d+)/g;
            let last;
            for (let r; (r = m.exec(chunk.toString())); ) last = r;
            if (last && total && onProgress) onProgress(Math.min(99, (Number(last[1]) / 1e6 / total) * 100));
        });
        child.stderr.on('data', (chunk) => {
            stderr += chunk.toString();
            if (!total) {
                const d = /Duration: (\d+):(\d+):(\d+\.?\d*)/.exec(stderr);
                if (d) total = Number(d[1]) * 3600 + Number(d[2]) * 60 + Number(d[3]);
            }
        });
        child.on('error', (err) => { if (track) current = null; reject(err); });
        child.on('close', (code) => {
            if (track) current = null;
            if (code === 0) return resolve();
            // Prefer the line that names the problem over progress/summary noise.
            const lines = stderr.trim().split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !/^(frame=|size=|video:|\[out|Conversion failed)/.test(l));
            const reason = [...lines].reverse().find((l) => /error|invalid|not found|unsupported|could not|unable|no such|does not|failed/i.test(l));
            const err = new Error((reason || lines[lines.length - 1] || `ffmpeg exited with code ${code}`).replace(/^\[[^\]]+\]\s*/, ''));
            err.killed = code === null || code === 1 && /Exiting normally, received signal|Immediate exit/.test(stderr);
            reject(err);
        });
    });
}

function probeDuration(file) {
    const ffprobe = findTool('ffprobe');
    if (!ffprobe) return 0;
    const r = spawnSync(ffprobe, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', file],
        { encoding: 'utf8', windowsHide: true, timeout: 15000 });
    return parseFloat(r.stdout) || 0;
}

module.exports = { binDir, findTool, uniquePath, runFfmpeg, probeDuration, killCurrent, findCalibre, findRar, capabilities, refreshTools, runTool };
