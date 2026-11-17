const { app, BrowserWindow, Menu, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const formats = require('./formats');
const converter = require('./converter');
const updater = require('./updater');
const { findTool } = require('./tools');
const { imageThumb } = require('./convert/images');
const { videoThumb } = require('./convert/media');
const { closeWorkers } = require('./convert/host');

let mainWindow = null;

// ---------------------------------------------------------------- settings
const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');
const defaultSettings = () => ({
    outMode: 'same',                // 'same' = next to the original, 'folder' = outDir
    outDir: path.join(app.getPath('documents'), 'UniFiles Converter'),
    quality: 90,                    // JPG / WebP / AVIF
    maxSize: 0,                     // longest side in px, 0 = keep
    videoQuality: 'balanced',
    resolution: 0,                  // max height, 0 = keep
    audioBitrate: 192,
    mergePdf: true,
});

function loadSettings() {
    try {
        return { ...defaultSettings(), ...JSON.parse(fs.readFileSync(settingsFile(), 'utf8')) };
    } catch {
        return defaultSettings();
    }
}

// Write to a temp file and rename, so a read never sees a half-written file
// (which would silently fall back to the defaults).
function saveSettings(s) {
    const file = settingsFile();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(`${file}.tmp`, JSON.stringify(s, null, 2));
    fs.renameSync(`${file}.tmp`, file);
}

// ------------------------------------------------------------------ files
function describe(file) {
    let size = 0;
    try { size = fs.statSync(file).size; } catch { /* gone */ }
    const category = formats.categoryOf(file);
    return {
        path: file,
        name: path.basename(file),
        ext: formats.extOf(file),
        size,
        category,
        targets: formats.targetsFor(file),
        target: formats.defaultTarget(file),
    };
}

// Files and folders (a folder adds the supported files directly inside it).
function expand(paths) {
    const out = [];
    for (const p of paths) {
        let stat;
        try { stat = fs.statSync(p); } catch { continue; }
        if (stat.isDirectory()) {
            for (const name of fs.readdirSync(p).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))) {
                const full = path.join(p, name);
                try { if (fs.statSync(full).isFile() && formats.categoryOf(full)) out.push(full); } catch { /* skip */ }
            }
        } else if (stat.isFile()) out.push(p);
    }
    return out.map(describe);
}

// ------------------------------------------------------------------ window
function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1180,
        height: 800,
        minWidth: 820,
        minHeight: 560,
        show: false,
        backgroundColor: '#0b0c0f',
        frame: false,
        icon: path.join(__dirname, '..', '..', 'build', 'icon.png'),
        webPreferences: {
            preload: path.join(__dirname, '..', 'preload', 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
        },
    });

    mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
    mainWindow.once('ready-to-show', () => mainWindow.show());

    mainWindow.on('restore', () => {
        const [w, h] = mainWindow.getSize();
        mainWindow.setSize(w, h + 1);
        mainWindow.setSize(w, h);
    });
    mainWindow.on('maximize', () => mainWindow.webContents.send('window:maximized', true));
    mainWindow.on('unmaximize', () => mainWindow.webContents.send('window:maximized', false));

    mainWindow.webContents.on('before-input-event', (_e, input) => {
        if (input.key === 'F12' || (input.control && input.shift && input.key.toLowerCase() === 'i')) {
            mainWindow.webContents.toggleDevTools();
        }
    });
    mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    // Dropping a file on the window must not navigate to it.
    mainWindow.webContents.on('will-navigate', (e) => e.preventDefault());

    mainWindow.on('close', (e) => {
        if (!converter.isBusy()) return;
        const choice = dialog.showMessageBoxSync(mainWindow, {
            type: 'warning',
            buttons: ['Keep converting', 'Quit'],
            defaultId: 0,
            cancelId: 0,
            title: 'UniFiles Converter',
            message: 'Files are still being converted. Quit anyway?',
        });
        if (choice === 0) e.preventDefault();
        else converter.cancel();
    });
}

// --------------------------------------------------------------------- IPC
function registerIpc() {
    ipcMain.handle('window:minimize', () => mainWindow?.minimize());
    ipcMain.handle('window:maximize', () => {
        if (!mainWindow) return;
        mainWindow.isMaximized() ? mainWindow.unmaximize() : mainWindow.maximize();
    });
    ipcMain.handle('window:close', () => mainWindow?.close());

    ipcMain.handle('settings:get', () => loadSettings());
    ipcMain.handle('settings:set', (_e, patch) => {
        const next = { ...loadSettings(), ...patch };
        saveSettings(next);
        return next;
    });

    ipcMain.handle('files:pick', async () => {
        const all = Object.values(formats.CATEGORIES).flatMap((c) => c.inputs);
        const res = await dialog.showOpenDialog(mainWindow, {
            title: 'Add files to convert',
            properties: ['openFile', 'multiSelections'],
            filters: [
                { name: 'All supported files', extensions: all },
                ...Object.values(formats.CATEGORIES).map((c) => ({ name: c.label, extensions: c.inputs })),
            ],
        });
        return res.canceled ? [] : expand(res.filePaths);
    });
    ipcMain.handle('files:pickFolder', async () => {
        const res = await dialog.showOpenDialog(mainWindow, { title: 'Add every file in a folder', properties: ['openDirectory'] });
        return res.canceled ? [] : expand(res.filePaths);
    });
    ipcMain.handle('files:describe', (_e, paths) => expand(paths));
    ipcMain.handle('files:thumb', async (_e, file) => {
        const cat = formats.categoryOf(file);
        try {
            if (cat === 'image') return await imageThumb(file);
            if (cat === 'video') return await videoThumb(file);
        } catch { /* no preview */ }
        return null;
    });

    ipcMain.handle('folder:pick', async (_e, current) => {
        const res = await dialog.showOpenDialog(mainWindow, {
            title: 'Choose where to save converted files',
            defaultPath: current,
            properties: ['openDirectory', 'createDirectory'],
        });
        return res.canceled ? null : res.filePaths[0];
    });
    ipcMain.handle('shell:showItem', (_e, file) => shell.showItemInFolder(file));
    ipcMain.handle('shell:open', (_e, file) => shell.openPath(file));

    ipcMain.handle('tools:status', () => ({ ffmpeg: findTool('ffmpeg') }));
    ipcMain.handle('convert:start', (_e, { jobs, options }) => {
        converter.convertAll(jobs, options, (event) => {
            if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('convert:event', event);
        });
        return true;
    });
    ipcMain.handle('convert:cancel', () => converter.cancel());
}

app.whenReady().then(() => {
    Menu.setApplicationMenu(null);
    registerIpc();
    createWindow();
    updater.init(() => mainWindow);
});

app.on('window-all-closed', () => {
    closeWorkers();
    app.quit();
});
