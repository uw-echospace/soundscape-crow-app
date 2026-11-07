/* CROW: Community Recording Online Workflow */

'use strict';

const { app, BrowserWindow, dialog, ipcMain, net, powerSaveBlocker, shell } = require('electron');
const { execFile, spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const util = require('util');
const audiomoth = require('audiomoth-hid');
const exifr = require('exifr');
const { SerialPort } = require('serialport');

// AudioMoth Configuration Settings

const GAIN_MEDIUM = 2;
const SLEEP_DURATION_S = 5 * 60;
const RECORD_DURATION_S = 5 * 60;
const LED_ENABLED = true;
const BATTERY_LEVEL_ENABLED = true;
const REQUIRE_CHIME = true;
const RECORDING_PERIODS = [[0, 24 * 60]];
const TIMEZONE_OFFSET_MINS = 0;

const SAMPLE_RATE_CONFIGURATION = { clockDivider: 4, acquisitionCycles: 16, oversampleRate: 1, sampleRate: 384000, sampleRateDivider: 2 };

// Configure AudioMoth Packet

const PACKET_LENGTH = 62;
const MAX_RECORDING_PERIODS = 5;
const PRERECORDING_PREP_TIME = 2;

function buildPacket (sendTime) {

    const packet = Buffer.alloc(PACKET_LENGTH);
    const c = SAMPLE_RATE_CONFIGURATION;
    let i = 0;

    i = packet.writeUInt32LE(sendTime, i);
    i = packet.writeUInt8(GAIN_MEDIUM, i);
    i = packet.writeUInt8(c.clockDivider, i);
    i = packet.writeUInt8(c.acquisitionCycles, i);
    i = packet.writeUInt8(c.oversampleRate, i);
    i = packet.writeUInt32LE(c.sampleRate, i);
    i = packet.writeUInt8(c.sampleRateDivider, i);
    i = packet.writeUInt16LE(SLEEP_DURATION_S, i);
    i = packet.writeUInt16LE(RECORD_DURATION_S, i);
    i = packet.writeUInt8(LED_ENABLED ? 1 : 0, i);

    i = packet.writeUInt8(RECORDING_PERIODS.length, i);
    for (let p = 0; p < MAX_RECORDING_PERIODS; p++) {
        const [start, end] = RECORDING_PERIODS[p] || [0, 0];
        i = packet.writeUInt16LE(start, i);
        i = packet.writeUInt16LE(end, i);
    }

    const tzHours = Math.trunc(TIMEZONE_OFFSET_MINS / 60);
    i = packet.writeInt8(tzHours, i);
    i = packet.writeUInt8(1, i);
    i = packet.writeUInt8((BATTERY_LEVEL_ENABLED ? 0 : 1) | (PRERECORDING_PREP_TIME << 4), i);
    i = packet.writeInt8(TIMEZONE_OFFSET_MINS - tzHours * 60, i);
    i = packet.writeUInt8(0, i);
    i = packet.writeUInt32LE(0, i);
    i = packet.writeUInt32LE(0, i);
    i = packet.writeUInt16LE(0, i);
    i = packet.writeUInt16LE(0, i);
    i = packet.writeUInt16LE(0, i);
    i = packet.writeUInt8(REQUIRE_CHIME ? 1 : 0, i);

    return packet;

}


// Configure using HID

const MAXIMUM_RETRIES = 10;
const RETRY_INTERVAL_MS = 100;

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function hid (fn, ...args) {

    let lastError;

    for (let attempt = 0; attempt < MAXIMUM_RETRIES; attempt++) {
        try {
            return await util.promisify(fn)(...args);
        } catch (err) {
            lastError = err;
            await delay(RETRY_INTERVAL_MS);
        }
    }

    throw new Error('Could not flash AudioMoth (' + lastError + ')');

}


// Download AudioMoth Firmware

const RELEASES_URL = 'https://api.github.com/repos/OpenAcousticDevices/AudioMoth-Firmware-Basic/releases/latest';
const FIRMWARE_DESCRIPTION = 'AudioMoth-Firmware-Basic';

const BOOTLOADER_VENDOR_IDS = ['10C4', '2544'];
const BOOTLOADER_PRODUCT_ID = '0003';

const parseVersion = (text) => (text.match(/\d+/g) || []).slice(0, 3).map(Number);
const versionString = (version) => version.join('.');
const sameVersion = (a, b) => versionString(a) === versionString(b);

function firmwareDirectory () {

    const directory = path.join(app.getPath('userData'), 'firmware');
    fs.mkdirSync(directory, { recursive: true });
    return directory;

}

async function getLatestFirmware () {

    const directory = firmwareDirectory();

    try {

        const response = await net.fetch(RELEASES_URL, { headers: { Accept: 'application/vnd.github+json' } });
        if (!response.ok) throw new Error('GitHub responded ' + response.status);
        const release = await response.json();
        const asset = release.assets.find((a) => a.name.endsWith('.bin'));
        const firmwarePath = path.join(directory, asset.name);

        if (!fs.existsSync(firmwarePath)) {
            const download = await net.fetch(asset.browser_download_url);
            if (!download.ok) throw new Error('Download responded ' + download.status);
            fs.writeFileSync(firmwarePath + '.part', Buffer.from(await download.arrayBuffer()));
            fs.renameSync(firmwarePath + '.part', firmwarePath);
        }

        return { path: firmwarePath, version: parseVersion(release.tag_name) };

    } catch (err) {

        const cached = fs.readdirSync(directory).filter((f) => f.endsWith('.bin'));
        if (cached.length === 0) throw new Error('Could not download the AudioMoth firmware. Check your internet connection and try again.');

        const newest = cached.map((f) => ({ path: path.join(directory, f), version: parseVersion(f) }))
            .sort((a, b) => a.version[0] - b.version[0] || a.version[1] - b.version[1] || a.version[2] - b.version[2])
            .pop();
        return newest;

    }

}

async function findBootloaderPort () {

    const ports = await SerialPort.list();
    const port = ports.find((p) => p.vendorId && p.productId &&
        BOOTLOADER_VENDOR_IDS.includes(p.vendorId.toUpperCase()) && p.productId === BOOTLOADER_PRODUCT_ID);

    return port ? port.path.replace('/dev/cu.', '/dev/tty.') : null;

}

function flashToolPath () {

    const name = process.platform === 'win32' ? 'flash.exe' : 'flash';
    if (app.isPackaged) return path.join(process.resourcesPath, 'bin', name);
    const platformDirectory = { win32: 'windows', darwin: 'macos' }[process.platform] || 'linux';
    return path.join(__dirname, 'bin', platformDirectory, name);

}

// Flash AudioMoth

const FLASH_SETTLE_DELAY_MS = 1000;
const MAX_READY_ATTEMPTS = 7;
const READY_RETRY_BASE_DELAY_MS = 200;
const READY_TIMEOUT_ERROR = 'Timed out waiting for send confirmation from AudioMoth';

async function flashFirmware (port, firmwarePath) {

    await delay(FLASH_SETTLE_DELAY_MS);

    for (let attempt = 1; ; attempt++) {

        const { stdout } = await util.promisify(execFile)(flashToolPath(), ['-u', port, firmwarePath], { timeout: 300000, windowsHide: true });

        const error = stdout.match(/ERROR: (.*)/);
        if (!error) {
            if (!stdout.includes('Programmed:')) throw new Error('Unexpected response from the flash tool: ' + stdout.trim());
            return;
        }

        const message = error[1].trim();
        if (message !== READY_TIMEOUT_ERROR || attempt === MAX_READY_ATTEMPTS) throw new Error(message + ' (attempt ' + attempt + ')');

        await delay(READY_RETRY_BASE_DELAY_MS * Math.pow(2, attempt));

    }

}

const BOOTLOADER_SWITCH_TIMEOUT_MS = 10000;
const RESTART_TIMEOUT_MS = 15000;

async function waitFor (check, timeout) {

    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
        const result = await check().catch(() => null);
        if (result) return result;
        await delay(250);
    }
    return null;

}

async function installFirmware (port, firmwarePath, report) {

    report('Installing firmware. Do not unplug the AudioMoth...');
    await flashFirmware(port, firmwarePath);

    report('Waiting for the AudioMoth to restart...');
    const restarted = await waitFor(() => hid(audiomoth.getFirmwareVersion), RESTART_TIMEOUT_MS);
    if (!restarted) throw new Error('The AudioMoth did not restart after installing firmware. Unplug it, plug it back in, and try again.');

}

async function applySettings (report) {

    report('Configuring settings...');

    let sendTime = Math.floor(Date.now() / 1000) + 1;
    if (sendTime * 1000 - Date.now() < 100) sendTime += 1;
    const packet = buildPacket(sendTime);
    await delay(sendTime * 1000 - Date.now());

    const response = await hid(audiomoth.setPacket, packet);
    if (response === null) throw new Error('The AudioMoth was disconnected while applying settings. Reconnect it and try again.');

    const echoed = Buffer.from(response.slice(1, 1 + PACKET_LENGTH));
    if (!echoed.equals(packet)) throw new Error('The AudioMoth did not configure properly. Unplug it, plug it back in, and try again.');

}

async function flashAudioMoth (report) {

    report('Checking for the latest firmware...');
    const firmware = await getLatestFirmware();

    report('Looking for an AudioMoth...');
    const current = await hid(audiomoth.getFirmwareVersion);

    if (current === null) {

        const port = await findBootloaderPort();
        if (!port) throw new Error('No AudioMoth found. Set the switch to USB/OFF, connect the AudioMoth to this computer with a USB cable, and try again.');
        await installFirmware(port, firmware.path, report);

    } else if (sameVersion(current, firmware.version) && await hid(audiomoth.getFirmwareDescription) === FIRMWARE_DESCRIPTION) {

        report('Firmware ' + versionString(firmware.version) + ' is already installed.');

    } else {

        // For non-HID compatible devices
        const supportsSwitch = await hid(audiomoth.queryBootloader).catch(() => false);
        if (!supportsSwitch) throw new Error('This AudioMoth\'s current firmware cannot be updated automatically. Update it once with the official AudioMoth Flash App, then try again.');

        report('Switching the AudioMoth to flash mode...');
        if (!await hid(audiomoth.switchToBootloader)) throw new Error('The AudioMoth refused to switch to flash mode. Unplug it, plug it back in, and try again.');

        const port = await waitFor(findBootloaderPort, BOOTLOADER_SWITCH_TIMEOUT_MS);
        if (!port) throw new Error('The AudioMoth did not enter flash mode. Unplug it, plug it back in, and try again.');
        await installFirmware(port, firmware.path, report);

    }

    const installed = await hid(audiomoth.getFirmwareVersion);
    if (!installed || !sameVersion(installed, firmware.version)) throw new Error('The firmware could not be verified after installing. Unplug the AudioMoth, plug it back in, and try again.');

    await applySettings(report);

    const deviceID = await hid(audiomoth.getID) || 'unknown';
    return 'AudioMoth ' + deviceID + ' is running firmware ' + versionString(firmware.version) +
        ' with configured settings. You can now unplug it.';

}

// Analyze Data (see analyze.py)

const RESULTS_FOLDER_NAME = 'SoundscapeResults';

let analysisProcess = null;

function analyzerCommand () {

    if (app.isPackaged) {
        const executable = path.join(process.resourcesPath, 'analyzer', process.platform === 'win32' ? 'analyzer.exe' : 'analyzer');
        return { command: executable, args: [], models: path.join(process.resourcesPath, 'models') };
    }

    const python = process.platform === 'win32' ? path.join(__dirname, '.venv', 'Scripts', 'python.exe') : path.join(__dirname, '.venv', 'bin', 'python');
    return { command: python, args: [path.join(__dirname, 'analyze.py')], models: path.join(__dirname, 'models') };

}

ipcMain.handle('choose-recordings', async (event) => {

    const result = await dialog.showOpenDialog(BrowserWindow.fromWebContents(event.sender), {
        title: 'Choose the AudioMoth SD card or recordings folder',
        properties: ['openDirectory']
    });

    if (result.canceled) return null;

    return result.filePaths[0];

});

const PHOTO_EXTENSIONS = ['jpg', 'jpeg', 'heic', 'heif', 'png', 'tif', 'tiff'];

function photoTime (exif) {

    const parts = (text) => String(text).split(/[: ]/).map(Number);
    if (exif.GPSDateStamp && Array.isArray(exif.GPSTimeStamp)) {
        const [y, m, d] = parts(exif.GPSDateStamp);
        const [hh, mm, ss] = exif.GPSTimeStamp;
        return { time: new Date(Date.UTC(y, m - 1, d, hh, mm, Math.floor(ss))), source: 'gps' };
    }
    if (!exif.DateTimeOriginal) return null;
    const [y, m, d, hh, mm, ss] = parts(exif.DateTimeOriginal);
    const offset = /^([+-])(\d\d):(\d\d)$/.exec(exif.OffsetTimeOriginal || '');
    if (offset) {
        const minutes = (offset[1] === '-' ? -1 : 1) * (Number(offset[2]) * 60 + Number(offset[3]));
        return { time: new Date(Date.UTC(y, m - 1, d, hh, mm, ss) - minutes * 60000), source: 'camera_offset' };
    }
    return { time: new Date(y, m - 1, d, hh, mm, ss), source: 'camera_local' };

}

ipcMain.handle('choose-photo', async (event, title) => {

    const result = await dialog.showOpenDialog(BrowserWindow.fromWebContents(event.sender), {
        title,
        filters: [{ name: 'Photos', extensions: PHOTO_EXTENSIONS }],
        properties: ['openFile']
    });
    if (result.canceled) return null;

    const file = result.filePaths[0];
    const photo = { path: file, name: path.basename(file), lat: null, lon: null, taken_utc: null, time_source: null };
    const exif = await exifr.parse(file, { gps: true, reviveValues: false }).catch(() => null) || {};
    if (Number.isFinite(exif.latitude) && Number.isFinite(exif.longitude)) {
        photo.lat = exif.latitude;
        photo.lon = exif.longitude;
    }
    const taken = photoTime(exif);
    if (taken && !isNaN(taken.time)) {
        photo.taken_utc = taken.time.toISOString().replace('.000Z', 'Z');
        photo.time_source = taken.source;
    }
    return photo;

});

const OUTPUT_SETTING_FILE = () => path.join(app.getPath('userData'), 'save-folder.txt');

function outputFolder () {

    try {
        return fs.readFileSync(OUTPUT_SETTING_FILE(), 'utf8').trim() || path.join(app.getPath('documents'), RESULTS_FOLDER_NAME);
    } catch {
        return path.join(app.getPath('documents'), RESULTS_FOLDER_NAME);
    }

}

ipcMain.handle('output-folder', () => {

    const folder = outputFolder();
    const missing = folder !== path.join(app.getPath('documents'), RESULTS_FOLDER_NAME) && !fs.existsSync(folder);
    return { folder, missing };

});

ipcMain.handle('choose-output', async (event) => {

    const result = await dialog.showOpenDialog(BrowserWindow.fromWebContents(event.sender), {
        title: 'Choose where to save the upload folder',
        defaultPath: outputFolder(),
        properties: ['openDirectory', 'createDirectory']
    });

    if (result.canceled) return null;
    fs.writeFileSync(OUTPUT_SETTING_FILE(), result.filePaths[0]);
    return { folder: result.filePaths[0], missing: false };

});

// Threading for analysis

const THREADS_SETTING_FILE = () => path.join(app.getPath('userData'), 'threads.txt');

function savedThreads () {

    try {
        return Math.max(0, parseInt(fs.readFileSync(THREADS_SETTING_FILE(), 'utf8'), 10) || 0);
    } catch {
        return 0;
    }

}

ipcMain.handle('threads', () => {

    const cores = os.availableParallelism();
    return { cores, automatic: Math.max(1, cores - 1), saved: Math.min(savedThreads(), cores) };

});

ipcMain.handle('set-threads', (_event, threads) => fs.writeFileSync(THREADS_SETTING_FILE(), String(threads)));

ipcMain.handle('analyze', (event, { folder, output, location, device, photos, extraModels = [] }) => {

    const locationSlug = slug(location.name);
    const deviceSlug = slug(device.name);
    if (!locationSlug || !deviceSlug) return { ok: false, message: 'This location or AudioMoth name has no letters or numbers.' };

    if (process.platform === 'darwin' && process.arch === 'x64') {
        return { ok: false, message: 'Detection needs a Mac with Apple silicon (M1 or newer). Please use a different computer.' };
    }

    if (output === path.join(app.getPath('documents'), RESULTS_FOLDER_NAME)) fs.mkdirSync(output, { recursive: true });
    if (!fs.existsSync(output)) return { ok: false, message: 'The save folder could not be found: ' + output + '. Choose another save folder.' };

    const { command, args, models } = analyzerCommand();
    if (benchmarkProcess) benchmarkProcess.kill();

    const zooArgs = [];
    if (extraModels.length) {
        if (addonProcess) return { ok: false, message: 'Wait for the add-on download to finish first.' };
        const catalog = addonModels();
        const level = installedAddonLevel();
        const chosen = [];
        for (const { id, threshold } of extraModels) {
            const model = catalog.models.find((m) => m.id === id);
            if (!model) return { ok: false, message: 'Unknown model: ' + id };
            if (!level || ADDON_LEVELS.indexOf(level) < ADDON_LEVELS.indexOf(model.addon)) return { ok: false, message: model.name + ' needs the model add-on. Download it before running detections.' };
            const value = Number(threshold);
            if (!(value > 0 && value < 1)) return { ok: false, message: 'The threshold for ' + model.name + ' must be between 0 and 1.' };
            chosen.push({ id: model.id, name: model.name, folder: model.folder, scores: model.scores, threshold: value });
        }
        zooArgs.push('--zoo', JSON.stringify({ python: addonPython(), runner: path.join(addonResources(), 'zoo_runner.py'), zoo_version: catalog.zoo_version, models: chosen }));
    }

    return new Promise((resolve) => {

        let result = { ok: false, message: 'Detection stopped unexpectedly.' };
        let stderr = '';
        let pending = '';

        analysisProcess = spawn(command, [...args, '--input', folder, '--output', output, '--location', locationSlug, '--device', deviceSlug,
            '--models', models, '--threads', String(savedThreads()), ...zooArgs, '--context', JSON.stringify({
                app: { name: app.getName(), version: app.getVersion(), platform: process.platform, arch: process.arch },
                user, location, device, photos
            })], { windowsHide: true, env: { ...process.env, ...addonEnv() } });

        const awake = powerSaveBlocker.start('prevent-app-suspension');

        analysisProcess.stdout.on('data', (data) => {
            pending += data.toString();
            const lines = pending.split('\n');
            pending = lines.pop();
            for (const line of lines) {
                let message;
                try { message = JSON.parse(line); } catch { continue; }
                if (message.type === 'progress') event.sender.send('analysis-progress', message);
                if (message.type === 'done') {
                    learnFromRun(message.timings, message.threads);
                    const failed = message.failed_models && message.failed_models.length ? ' These models could not run and are not included: ' + message.failed_models.join(', ') + '.' : '';
                    result = { ok: true, path: message.path, message: 'Done! ' + message.analyzed + (message.analyzed === 1 ? ' recording' : ' recordings') + ' checked' + (message.skipped ? ' (' + message.skipped + ' could not be read)' : '') + '. Your upload folder is ready.' + failed };
                }
                if (message.type === 'error') result = { ok: false, message: message.message };
            }
        });

        analysisProcess.stderr.on('data', (data) => { stderr = (stderr + data.toString()).slice(-2000); });

        analysisProcess.on('error', (err) => { result = { ok: false, message: 'Could not start the detection engine: ' + err.message }; });

        analysisProcess.on('close', (code, signal) => {
            analysisProcess = null;
            powerSaveBlocker.stop(awake);
            if (signal) result = { ok: false, message: 'Detection cancelled.' };
            else if (!result.ok && code !== 0 && result.message === 'Detection stopped unexpectedly.') result.message += ' ' + stderr.trim().split('\n').pop();
            resolve(result);
        });

    });

});

ipcMain.handle('cancel-analysis', () => {

    if (analysisProcess) analysisProcess.kill();

});

const UV_VERSION = '0.13.5';
const UV_DOWNLOADS = {
    'darwin-arm64': { file: 'uv-aarch64-apple-darwin.tar.gz', sha256: '743f85035a1996ecb350659e01cd9faea9709829be09b1b4b03c73eaf3c9cd73' },
    'win32-x64': { file: 'uv-x86_64-pc-windows-msvc.zip', sha256: 'a38b8d1902b7cfbc76b423ba1bb456f623f42064cdc72628b6075b89afd1019a' },
    'linux-x64': { file: 'uv-x86_64-unknown-linux-gnu.tar.gz', sha256: 'f68d291c75783122dad58ab77def0e13f3233f358731db5d6d7e8715603b928f' },
    'linux-arm64': { file: 'uv-aarch64-unknown-linux-gnu.tar.gz', sha256: '4bb69cf95ed13f23713bb7bc09f241896ea0c75b7c557e615a20604b82f9c403' }
};
const ADDON_PYTHON_VERSION = '3.12';
const ADDON_LEVELS = ['base', 'full'];

const addonDir = () => path.join(app.getPath('userData'), 'addon');
const addonResources = () => (app.isPackaged ? path.join(process.resourcesPath, 'addon') : path.join(__dirname, 'addon'));
const addonPython = () => path.join(addonDir(), 'env', process.platform === 'win32' ? path.join('Scripts', 'python.exe') : path.join('bin', 'python'));
const addonLock = (level) => path.join(addonResources(), level + '.txt');
const addonStatusFile = () => path.join(addonDir(), 'installed.json');

const fileSha256 = (file) => require('crypto').createHash('sha256').update(fs.readFileSync(file)).digest('hex');

let addonProcess = null;

function addonModels () {

    return JSON.parse(fs.readFileSync(path.join(addonResources(), 'models.json'), 'utf8'));

}

function installedAddonLevel () {

    try {
        const status = JSON.parse(fs.readFileSync(addonStatusFile(), 'utf8'));
        if (!fs.existsSync(addonPython()) || status.lock_sha256 !== fileSha256(addonLock(status.level))) return null;
        return status.level;
    } catch {
        return null;
    }

}

ipcMain.handle('addon-status', () => ({
    supported: Boolean(UV_DOWNLOADS[process.platform + '-' + process.arch]),
    level: installedAddonLevel(),
    models: addonModels()
}));

function runAddonCommand (command, args, env, onLine) {

    return new Promise((resolve, reject) => {
        addonProcess = spawn(command, args, { windowsHide: true, env: { ...process.env, ...env } });
        let tail = '';
        const read = (data) => {
            for (const line of data.toString().split(/\r?\n/)) {
                if (!line.trim()) continue;
                tail = line.trim();
                onLine(tail);
            }
        };
        addonProcess.stdout.on('data', read);
        addonProcess.stderr.on('data', read);
        addonProcess.on('error', reject);
        addonProcess.on('close', (code, signal) => {
            addonProcess = null;
            if (signal) reject(new Error('cancelled'));
            else if (code !== 0) reject(new Error(tail));
            else resolve();
        });
    });

}

async function downloadUv (directory) {

    const download = UV_DOWNLOADS[process.platform + '-' + process.arch];
    const response = await net.fetch('https://github.com/astral-sh/uv/releases/download/' + UV_VERSION + '/' + download.file);
    if (!response.ok) throw new Error('Could not download the installer (' + response.status + ').');
    const data = Buffer.from(await response.arrayBuffer());
    if (require('crypto').createHash('sha256').update(data).digest('hex') !== download.sha256) throw new Error('The installer download was damaged. Please try again.');

    const archive = path.join(directory, download.file);
    fs.writeFileSync(archive, data);
    await util.promisify(execFile)('tar', ['-xf', archive, '-C', directory]);
    fs.rmSync(archive);

    const name = process.platform === 'win32' ? 'uv.exe' : 'uv';
    const found = [path.join(directory, name), path.join(directory, download.file.replace(/\.(tar\.gz|zip)$/, ''), name)].find((file) => fs.existsSync(file));
    if (!found) throw new Error('The installer could not be unpacked.');
    return found;

}

ipcMain.handle('install-addon', async (event, level) => {

    if (!ADDON_LEVELS.includes(level)) return { ok: false, message: 'Unknown add-on.' };

    const send = (message) => { if (!event.sender.isDestroyed()) event.sender.send('addon-progress', message); };
    const directory = addonDir();
    const env = { UV_CACHE_DIR: path.join(directory, 'cache'), UV_PYTHON_INSTALL_DIR: path.join(directory, 'python'), UV_NO_PROGRESS: '1' };

    try {
        fs.mkdirSync(directory, { recursive: true });
        send('Downloading the installer...');
        const uv = await downloadUv(directory);

        if (!fs.existsSync(addonPython())) {
            send('Downloading Python...');
            await runAddonCommand(uv, ['venv', '--python', ADDON_PYTHON_VERSION, '--python-preference', 'only-managed', path.join(directory, 'env')], env, () => {});
        }

        send('Downloading model packages (this can take a while)...');
        await runAddonCommand(uv, ['pip', 'sync', '--python', addonPython(), '--torch-backend', 'cpu', addonLock(level)], env, (line) => {
            if (/^(Downloading|Downloaded|Prepared|Installed)/.test(line)) send(line);
        });

        fs.rmSync(env.UV_CACHE_DIR, { recursive: true, force: true });
        fs.writeFileSync(addonStatusFile(), JSON.stringify({ level, lock_sha256: fileSha256(addonLock(level)), installed_utc: new Date().toISOString() }));
        return { ok: true, level };
    } catch (error) {
        if (error.message === 'cancelled') return { ok: false, message: 'Download cancelled.' };
        return { ok: false, message: 'The add-on could not be installed: ' + error.message + ' Check your internet connection and try again.' };
    }

});

ipcMain.handle('cancel-addon', () => {

    if (addonProcess) addonProcess.kill();

});

ipcMain.handle('remove-addon', async () => {

    if (addonProcess || analysisProcess) return { ok: false };
    await fs.promises.rm(addonDir(), { recursive: true, force: true });
    return { ok: true };

});

const SPEED_FILE = () => path.join(app.getPath('userData'), 'speed.json');
let speedTest = null;
let benchmarkProcess = null;

function expectedCompute (catalog, timing) {

    if (timing.model === 'builtin') {
        const [bird, bat] = catalog.builtin;
        return timing.audio_s * bird.cost + timing.bat_audio_s * bat.cost;
    }
    const model = catalog.models.find((m) => m.id === timing.model);
    return model ? timing.audio_s * model.cost : null;

}

function readSpeed () {

    try {
        return JSON.parse(fs.readFileSync(SPEED_FILE(), 'utf8'));
    } catch {
        return { learned: {} };
    }

}

function learnFromRun (timings, threads) {

    const catalog = addonModels();
    const speed = readSpeed();
    for (const timing of timings || []) {
        const expected = expectedCompute(catalog, timing);
        if (!expected || timing.audio_s < 60) continue;
        const factor = timing.compute_s / expected;
        const old = speed.learned[timing.model];
        speed.learned[timing.model] = { factor: old ? (old.factor + factor) / 2 : factor, threads, runs: (old ? old.runs : 0) + 1 };
    }
    try { fs.writeFileSync(SPEED_FILE(), JSON.stringify(speed)); } catch {}

}

ipcMain.handle('speed', () => ({ test: speedTest, learned: readSpeed().learned }));

ipcMain.handle('speed-test', () => {

    if (analysisProcess || (process.platform === 'darwin' && process.arch === 'x64')) return null;
    if (benchmarkProcess) benchmarkProcess.kill();

    const { command, args, models } = analyzerCommand();
    return new Promise((resolve) => {
        let output = '';
        const child = benchmarkProcess = spawn(command, [...args, '--benchmark', '--models', models, '--threads', String(savedThreads())], { windowsHide: true });
        child.stdout.on('data', (data) => { output += data.toString(); });
        child.on('error', () => resolve(null));
        child.on('close', () => {
            if (benchmarkProcess === child) benchmarkProcess = null;
            const line = output.split('\n').find((l) => l.includes('"benchmark"'));
            if (!line) return resolve(null);
            const result = JSON.parse(line);
            speedTest = { factor: result.compute_s / addonModels().speed_test_reference_s, threads: result.threads };
            resolve(speedTest);
        });
    });

});

const MODEL_SETTINGS_FILE = () => path.join(app.getPath('userData'), 'models.json');

ipcMain.handle('model-settings', () => {

    try {
        return JSON.parse(fs.readFileSync(MODEL_SETTINGS_FILE(), 'utf8'));
    } catch {
        return { selected: [], thresholds: {} };
    }

});

ipcMain.handle('set-model-settings', (_event, settings) => fs.writeFileSync(MODEL_SETTINGS_FILE(), JSON.stringify(settings)));

function wavInfo (file) {

    const fd = fs.openSync(file, 'r');
    try {
        const header = Buffer.alloc(8192);
        const length = fs.readSync(fd, header, 0, header.length, 0);
        if (length < 12 || header.toString('ascii', 0, 4) !== 'RIFF' || header.toString('ascii', 8, 12) !== 'WAVE') return null;
        let offset = 12;
        let format = null;
        while (offset + 8 <= length) {
            const id = header.toString('ascii', offset, offset + 4);
            const size = header.readUInt32LE(offset + 4);
            if (id === 'fmt ') format = { channels: header.readUInt16LE(offset + 10), rate: header.readUInt32LE(offset + 12), bits: header.readUInt16LE(offset + 22) };
            if (id === 'data') {
                if (!format || format.channels !== 1 || format.bits !== 16) return null;
                const dataBytes = Math.min(size, fs.fstatSync(fd).size - offset - 8);
                return { rate: format.rate, seconds: dataBytes / 2 / format.rate };
            }
            offset += 8 + size + (size % 2);
        }
        return null;
    } finally {
        fs.closeSync(fd);
    }

}

ipcMain.handle('scan-recordings', (_event, folder) => {

    const summary = { files: 0, readable: 0, audio_s: 0, bat_audio_s: 0, audio_bytes: 0 };
    const walk = (directory) => {
        for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
            if (entry.name.startsWith('.')) continue;
            const file = path.join(directory, entry.name);
            if (entry.isDirectory()) walk(file);
            else if (entry.name.toLowerCase().endsWith('.wav')) {
                summary.files++;
                let info = null;
                try { info = wavInfo(file); } catch {}
                if (!info) continue;
                summary.readable++;
                summary.audio_s += info.seconds;
                summary.audio_bytes += fs.statSync(file).size;
                if (info.rate >= 96000) summary.bat_audio_s += info.seconds;
            }
        }
    };
    try { walk(folder); } catch { return null; }
    return summary;

});

const addonEnv = () => {
    const models = path.join(addonDir(), 'models');
    return { HF_HOME: path.join(models, 'huggingface'), TORCH_HOME: path.join(models, 'torch'), KAGGLEHUB_CACHE: path.join(models, 'kaggle'),
        XDG_CACHE_HOME: path.join(models, 'cache'), CROW_MODEL_CACHE: path.join(models, 'zoo'), PYTHONIOENCODING: 'utf-8' };
};

ipcMain.handle('show-folder', (_event, folder) => shell.showItemInFolder(folder));

// Soundscape Webportal Login

const API_URL = 'https://seattle-soundscape.uw.edu/api/v1';

let token = null;
let user = null;

async function portal (route, options = {}) {

    let response;
    try {
        response = await net.fetch(API_URL + route, {
            method: options.body ? 'POST' : (options.method || 'GET'),
            headers: { 'Content-Type': 'application/json', ...(token && { Authorization: 'Bearer ' + token }) },
            body: options.body && JSON.stringify(options.body)
        });
    } catch {
        throw new Error('Could not connect to login service. Check your internet connection and try again.');
    }

    if (response.status === 204) return null;
    const data = await response.json().catch(() => ({}));

    if (response.status === 401 && token) {
        token = null;
        user = null;
        const err = new Error('You have been signed out. Please sign in again.');
        err.signedOut = true;
        throw err;
    }

    if (response.status === 503) throw new Error(data.error || 'The service is unavailable right now. Please try again later.');
    if (!response.ok) throw new Error(data.error || 'The service returned an error (' + response.status + ').');

    return data;

}

function slug (name) {

    return name.normalize('NFKD').split(/[^A-Za-z0-9-]+/).map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join('');

}

function handlePortal (channel, handler) {

    ipcMain.handle(channel, async (_event, ...args) => {
        try {
            return await handler(...args);
        } catch (err) {
            return { error: err.message, signedOut: Boolean(err.signedOut) };
        }
    });

}

handlePortal('login', async ({ email, password }) => {

    const data = await portal('/auth/login', { body: { email, password, label: app.getName() + ' (' + process.platform + ')' } });
    token = data.token;
    user = data.user;
    return { user };

});

handlePortal('logout', async () => {

    await portal('/auth/logout', { method: 'POST' }).catch(() => {});
    token = null;
    user = null;
    return {};

});

handlePortal('locations', async () => (await portal('/locations')).locations);

handlePortal('audiomoths', async (locationID) => (await portal('/audiomoths?location_id=' + encodeURIComponent(locationID))).audiomoths);

// App Window

let flashing = false;

ipcMain.handle('flash', async (event) => {

    flashing = true;
    try {
        const message = await flashAudioMoth((text) => event.sender.send('flash-progress', text));
        return { ok: true, message };
    } catch (err) {
        return { ok: false, message: err.message || String(err) };
    } finally {
        flashing = false;
    }

});

// Battery Voltage Test

const BATTERY_OK_VOLTS = 4.5;

ipcMain.handle('battery', async () => {

    if (flashing) return null;
    const state = await util.promisify(audiomoth.getBatteryState)().catch(() => null);
    if (!state) return null;
    const volts = parseFloat(state.replace(/[^\d.]/g, ''));
    const ok = state.startsWith('>') || (!state.startsWith('<') && volts >= BATTERY_OK_VOLTS);
    return { state, ok };

});

app.whenReady().then(() => {

    if (process.platform === 'darwin' && !app.isPackaged) app.dock.setIcon(path.join(__dirname, 'assets', 'icon.png'));

    const window = new BrowserWindow({
        width: 780,
        height: 500,
        minWidth: 640,
        minHeight: 420,
        title: 'CROW',
        autoHideMenuBar: true,
        icon: path.join(__dirname, 'assets', 'icon.png'),
        webPreferences: { nodeIntegration: true, contextIsolation: false }
    });

    window.loadFile('index.html');
    window.on('close', (event) => { if (!confirmStopAnalysis(window)) event.preventDefault(); });
    window.webContents.once('did-finish-load', () => (canAutoUpdate() ? autoUpdate(window) : checkForUpdate(window)));

});

const APP_RELEASES_URL = 'https://api.github.com/repos/uw-echospace/soundscape-crow-app/releases/latest';

const newerVersion = (a, b) => {

    for (let i = 0; i < 3; i++) {

        if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) > (b[i] || 0);

    }

    return false;

};

async function checkForUpdate (window) {

    let release;

    try {

        const response = await net.fetch(APP_RELEASES_URL, { headers: { Accept: 'application/vnd.github+json' } });
        if (!response.ok) return;
        release = await response.json();

    } catch (error) {

        return;

    }

    if (!release.tag_name || !newerVersion(parseVersion(release.tag_name), parseVersion(app.getVersion()))) return;
    if (window.isDestroyed()) return;

    const { response } = await dialog.showMessageBox(window, {
        type: 'info',
        buttons: ['Open GitHub', 'Later'],
        defaultId: 0,
        cancelId: 1,
        message: 'A new version of CROW is available',
        detail: 'Version ' + versionString(parseVersion(release.tag_name)) + ' is now available. You have version ' + app.getVersion() + '. Download the new version from GitHub and install it.'
    });

    if (response === 0) shell.openExternal(release.html_url);

}

const canAutoUpdate = () => app.isPackaged && (process.platform === 'win32' || (process.platform === 'linux' && !!process.env.APPIMAGE));

function autoUpdate (window) {

    const { autoUpdater } = require('electron-updater');

    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;

    autoUpdater.on('error', () => checkForUpdate(window));

    autoUpdater.on('update-downloaded', async (info) => {

        if (analysisProcess || window.isDestroyed()) return;

        const { response } = await dialog.showMessageBox(window, {
            type: 'info',
            buttons: ['Restart now', 'Later'],
            defaultId: 0,
            cancelId: 1,
            message: 'A new version of CROW is ready',
            detail: 'Version ' + info.version + ' has been downloaded. Restart CROW to finish updating, or it will update the next time you close it.'
        });

        if (response === 0 && !analysisProcess) autoUpdater.quitAndInstall();

    });

    autoUpdater.checkForUpdates().catch(() => {});

}

let stopConfirmed = false;

function confirmStopAnalysis (window) {

    if (!analysisProcess || stopConfirmed) return true;
    const choice = dialog.showMessageBoxSync(window || BrowserWindow.getAllWindows()[0], {
        type: 'warning',
        buttons: ['Keep running', 'Stop and quit'],
        defaultId: 0,
        cancelId: 0,
        message: 'Detection is still running',
        detail: 'If you quit now, detection will cancel and you will need to start over again.'
    });
    if (choice === 0) return false;
    stopConfirmed = true;
    return true;

}

app.on('will-quit', () => { if (analysisProcess) analysisProcess.kill(); });

app.on('before-quit', (event) => {

    if (!confirmStopAnalysis()) {
        event.preventDefault();
        return;
    }
    if (!token) return;
    event.preventDefault();
    const timeout = new Promise((resolve) => setTimeout(resolve, 2000));
    Promise.race([portal('/auth/logout', { method: 'POST' }).catch(() => {}), timeout]).then(() => {
        token = null;
        app.quit();
    });

});

app.on('window-all-closed', () => app.quit());
