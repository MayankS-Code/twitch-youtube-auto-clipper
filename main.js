const { app, BrowserWindow, ipcMain, shell, session } = require('electron');
const path = require('path');
const fs = require('fs');
const configManager = require('./src/services/config-manager');
const ffmpegProcessor = require('./src/services/ffmpeg-processor');

let mainWindow = null;

// Keep the player + recorder running at full speed even when the Clipper window is hidden
// behind a fullscreen game or minimized. By default Chromium throttles background/covered
// windows, which drops frames from the recording (clips look laggy).
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion,IntensiveWakeUpThrottling');

const CLIPS_DIR = path.join(__dirname, 'clips');
const RAW_DIR = path.join(CLIPS_DIR, 'raw');
const FRAMES_DIR = path.join(CLIPS_DIR, 'frames');
// Finished clips go to the configured output folder (default: <home>/Videos/Clipper Clips);
// falls back to clips/final if that folder can't be created
function resolveFinalDir() {
  const wanted = (configManager.get().output || {}).finalDir;
  if (wanted) {
    try { fs.mkdirSync(wanted, { recursive: true }); return wanted; } catch (e) {}
  }
  return path.join(CLIPS_DIR, 'final');
}
const FINAL_DIR = resolveFinalDir();
const BUFFER_ROOT = path.join(CLIPS_DIR, 'buffer');
// Each running Clipper instance gets its own buffer folder, so instances never touch each other's
const BUFFER_DIR = path.join(BUFFER_ROOT, `pid_${process.pid}`);
const LOG_PATH = path.join(__dirname, 'clipper.log');
const { spawn } = require('child_process');
const PRELOAD_PATH = path.join(__dirname, 'src', 'preload-yt.js');

function log(...parts) {
  const line = `[${new Date().toISOString()}] ${parts.map(p => (typeof p === 'string' ? p : JSON.stringify(p))).join(' ')}\n`;
  try { fs.appendFileSync(LOG_PATH, line); } catch (e) {}
  console.log(line.trim());
}

process.on('uncaughtException', (err) => log('MAIN uncaughtException', err.stack || err.message));

function ensureDirectories() {
  // Live-buffer segments are temporary: remove folders left by instances that are no longer running
  try {
    for (const name of fs.existsSync(BUFFER_ROOT) ? fs.readdirSync(BUFFER_ROOT) : []) {
      const full = path.join(BUFFER_ROOT, name);
      const m = name.match(/^pid_(\d+)$/);
      let alive = false;
      if (m) {
        try { process.kill(Number(m[1]), 0); alive = true; } catch (e) { alive = e.code === 'EPERM'; }
      } else {
        // folder from an older Clipper version: only remove it once it has been idle 10+ minutes
        try { alive = Date.now() - fs.statSync(full).mtimeMs < 10 * 60 * 1000; } catch (e) {}
      }
      if (!alive) fs.rmSync(full, { recursive: true, force: true });
    }
  } catch (e) {}
  [CLIPS_DIR, RAW_DIR, FRAMES_DIR, FINAL_DIR, BUFFER_ROOT, BUFFER_DIR].forEach(dir => {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  });
}

// ---------- Live replay buffer storage (segments on disk, pruned to the last ~60s)
const liveSessions = new Map(); // sessionId -> { dir, segs: [{ idx, file, duration }] }
const safeId = (s) => String(s || 'x').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80);
const sumDur = (segs) => segs.reduce((a, s) => a + s.duration, 0);

function liveSession(sessionId) {
  let s = liveSessions.get(sessionId);
  if (!s) {
    s = { dir: path.join(BUFFER_DIR, safeId(sessionId)), segs: [] };
    fs.mkdirSync(s.dir, { recursive: true });
    liveSessions.set(sessionId, s);
  }
  return s;
}

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    // background helper: idle priority + few threads so it never steals time from playback/recording
    const p = spawn('ffmpeg', ['-threads', '2', ...args], { windowsHide: true });
    try { require('os').setPriority(p.pid, require('os').constants.priority.PRIORITY_LOW); } catch (e) {}
    let err = '';
    p.stderr.on('data', d => { err = (err + d).slice(-2000); });
    p.on('error', reject);
    p.on('close', code => (code === 0 ? resolve() : reject(new Error(`ffmpeg ${code}: ${err}`))));
  });
}

// Validity check of a recorded segment + the timestamp of its first video frame (reads the
// first packet only; a few ms). Returns null if the file is unreadable / has no video.
function probeSegment(file) {
  return new Promise(resolve => {
    const p = spawn('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-read_intervals', '%+#1',
      '-show_entries', 'packet=pts_time', '-of', 'csv=p=0', file], { windowsHide: true });
    let out = '';
    p.stdout.on('data', d => { out += d; });
    p.on('error', () => resolve(null));
    p.on('close', code => {
      const t = parseFloat(out.trim().split(/\r?\n/)[0]);
      resolve(code === 0 && Number.isFinite(t) ? { firstPts: Math.max(0, t) } : null);
    });
  });
}
const probeOk = async (file) => !!(await probeSegment(file));

function writeFrame(framePath, dataUrl) {
  if (!dataUrl) return false;
  fs.writeFileSync(framePath, dataUrl.replace(/^data:image\/\w+;base64,/, ''), 'base64');
  return true;
}

const sanitize = (t) => (t || 'clip').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 40);

function createWindow() {
  ensureDirectories();

  // Look like regular Chrome (some sites, e.g. Twitch, treat the Electron identifier as unsupported)
  session.defaultSession.setUserAgent(session.defaultSession.getUserAgent().replace(/\s(Electron|clipper)\/\S+/gi, ''));
  session.defaultSession.setPermissionRequestHandler((wc, permission, cb) => cb(true));
  session.defaultSession.setPermissionCheckHandler(() => true);

  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1024,
    minHeight: 700,
    backgroundColor: '#0c0d12',
    title: 'Clipper',
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      webviewTag: true,
      backgroundThrottling: false
    }
  });

  // Attach the YouTube hook script as the webview's real preload.
  // (Setting the attribute from the renderer / re-injecting with executeJavaScript was
  //  unreliable and ran the script twice — that was the source of the Record errors.)
  mainWindow.webContents.on('will-attach-webview', (event, webPreferences) => {
    webPreferences.preload = PRELOAD_PATH;
    webPreferences.contextIsolation = false;
    webPreferences.nodeIntegration = false;
    webPreferences.backgroundThrottling = false; // the YouTube/Twitch player itself must never be throttled
  });

  mainWindow.webContents.on('render-process-gone', (e, details) => log('RENDERER gone', details));

  mainWindow.loadFile(path.join(__dirname, 'src', 'renderer', 'index.html'));
  mainWindow.on('closed', () => { mainWindow = null; });
}

function send(channel, data) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, data);
}

function setupIpcHandlers() {
  ipcMain.handle('get-config', () => configManager.get());
  ipcMain.handle('save-config', (e, cfg) => configManager.save(cfg));
  ipcMain.handle('log', (e, msg) => { log('UI', msg); return true; });

  // A finished 10s live segment from the YouTube page -> disk, then prune old ones
  ipcMain.handle('live-segment', async (e, { sessionId, idx, duration, bytes, keepSec, info }) => {
    const s = liveSession(sessionId);
    const file = path.join(s.dir, `seg_${String(idx).padStart(6, '0')}.webm`);
    await fs.promises.mkdir(s.dir, { recursive: true }); // self-heal if the folder was removed
    const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    try {
      await fs.promises.writeFile(file, buf);
    } catch (err) {
      fs.promises.unlink(file).catch(() => {});
      if (err.code === 'ENOSPC') {
        if (!s.diskFullWarned) { s.diskFullWarned = true; log('Live buffer: disk full', s.dir); send('disk-full', { dir: s.dir }); }
        return { bufferedSec: sumDur(s.segs), diskFull: true };
      }
      throw err;
    }
    s.diskFullWarned = false;
    // Never let a damaged segment into the buffer: one bad piece would make every clip fail
    const probe = await probeSegment(file);
    if (!probe) {
      log('Dropped damaged live segment', path.basename(file), `${buf.length} bytes, ${duration.toFixed(1)}s, ${info || ''}, head:`,
        buf.subarray(0, 48).toString('hex').replace(/(..)/g, '$1 ').trim());
      fs.promises.unlink(file).catch(() => {});
      return { bufferedSec: sumDur(s.segs), dropped: true };
    }
    s.segs.push({ idx, file, duration, firstPts: probe.firstPts });
    s.segs.sort((a, b) => a.idx - b.idx);
    // keep just enough segments to cover keepSec
    while (s.segs.length > 1 && sumDur(s.segs.slice(1)) >= keepSec) {
      const old = s.segs.shift();
      fs.promises.unlink(old.file).catch(() => {});
    }
    return { bufferedSec: sumDur(s.segs) };
  });

  ipcMain.handle('live-reset', (e, sessionId) => {
    const s = liveSessions.get(sessionId);
    if (s) {
      liveSessions.delete(sessionId);
      fs.promises.rm(s.dir, { recursive: true, force: true }).catch(() => {});
    }
    return true;
  });

  // Stitch the buffered segments into one file (stream copy = instant, no re-encode)
  ipcMain.handle('live-clip', async (e, d) => {
    try {
      const s = liveSessions.get(d.sessionId);
      if (!s || !s.segs.length) return { success: false, error: 'Nothing buffered yet' };
      // only the newest segments needed to cover the requested length (30s clips stitch less)
      const want = d.seconds || 60;
      const pick = () => {
        const out = [];
        for (let i = s.segs.length - 1; i >= 0 && sumDur(out) < want; i--) out.unshift(s.segs[i]);
        return out;
      };
      let segs = pick();
      const timestamp = Date.now();
      const base = `${sanitize(d.title)}_${timestamp}`;
      const rawPath = path.join(RAW_DIR, `live_${base}.mkv`);
      const framePath = path.join(FRAMES_DIR, `frame_${base}.jpg`);
      const listPath = path.join(s.dir, `list_${timestamp}.txt`);
      // Seamless joins: each segment recorded ~1s past its join point. A segment's first video
      // frame arrives a little after its start (encoder warm-up), so the previous segment fills
      // exactly up to that moment, and the next one starts there. Audio + video are cut together.
      const JOIN_OVERLAP = 1.0;
      const spanOf = (g, i, list) => {
        const inp = g.firstPts || 0;
        const next = list[i + 1];
        const out = g.duration + Math.min(JOIN_OVERLAP, next ? (next.firstPts || 0) : 0);
        return { inp, out: Math.max(inp + 0.05, out) };
      };
      const writeList = () => fs.writeFileSync(listPath, segs.map((g, i) => {
        const { inp, out } = spanOf(g, i, segs);
        return `file '${g.file.replace(/\\/g, '/').replace(/'/g, "'\\''")}'\ninpoint ${inp.toFixed(3)}\noutpoint ${out.toFixed(3)}\nduration ${(out - inp).toFixed(3)}`;
      }).join('\n'));
      const copyArgs = () => ['-v', 'error', '-f', 'concat', '-safe', '0', '-i', listPath, '-map', '0:v', '-map', '0:a?', '-c', 'copy', '-y', rawPath];

      writeList();
      try {
        await runFfmpeg(copyArgs());
      } catch (err) {
        // Find and remove any unreadable segment, then retry with the good ones
        log('live concat failed, checking segments', err.message.split('\n')[0]);
        const bad = [];
        for (const g of segs) if (!(await probeOk(g.file))) bad.push(g);
        if (bad.length) {
          log('Removing damaged segments', bad.map(b => path.basename(b.file)).join(', '));
          s.segs = s.segs.filter(g => !bad.includes(g));
          bad.forEach(b => fs.promises.unlink(b.file).catch(() => {}));
          segs = pick();
          if (!segs.length) throw new Error('No readable video in the buffer yet');
          writeList();
        }
        try {
          await runFfmpeg(copyArgs());
        } catch (err2) {
          log('live concat copy failed again, re-encoding', err2.message.split('\n')[0]);
          await runFfmpeg(['-v', 'error', '-f', 'concat', '-safe', '0', '-i', listPath, '-map', '0:v', '-map', '0:a?',
            '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '16', '-threads', '2', '-c:a', 'aac', '-b:a', '192k', '-y', rawPath]);
        }
      }
      fs.promises.unlink(listPath).catch(() => {});
      const total = segs.reduce((a, g, i) => { const sp = spanOf(g, i, segs); return a + (sp.out - sp.inp); }, 0);

      if (!writeFrame(framePath, d.snapshotDataUrl)) {
        try { await ffmpegProcessor.extractSnapshot(rawPath, framePath, Math.max(0, total - 1)); } catch (err) {}
      }
      const seconds = d.seconds || 60;
      log('Live clip', rawPath, `${total.toFixed(1)}s buffered`);
      return {
        success: true,
        id: `clip_${timestamp}`,
        title: d.title || 'YouTube Clip',
        videoId: d.videoId || null,
        rawPath,
        framePath: fs.existsSync(framePath) ? framePath : null,
        trimStart: Math.max(0, total - seconds),
        duration: Math.min(seconds, total),
        videoWidth: d.videoWidth || 1920,
        videoHeight: d.videoHeight || 1080,
        timestamp
      };
    } catch (err) {
      log('live-clip failed', err.stack || err.message);
      return { success: false, error: 'Could not build the clip from the buffer — details in clipper.log' };
    }
  });

  ipcMain.handle('save-raw-clip', async (event, { buffer, title, duration, videoWidth, videoHeight, snapshotDataUrl, videoId }) => {
    try {
      const timestamp = Date.now();
      const base = `${sanitize(title)}_${timestamp}`;
      const rawPath = path.join(RAW_DIR, `raw_${base}.webm`);
      const framePath = path.join(FRAMES_DIR, `frame_${base}.jpg`);

      fs.writeFileSync(rawPath, Buffer.from(buffer));

      if (snapshotDataUrl) {
        fs.writeFileSync(framePath, snapshotDataUrl.replace(/^data:image\/\w+;base64,/, ''), 'base64');
      } else {
        try { await ffmpegProcessor.extractSnapshot(rawPath, framePath, 0.5); } catch (e) { log('snapshot fallback failed', e.message); }
      }

      log('Saved clip', rawPath, `${videoWidth}x${videoHeight}`, `${(duration || 0).toFixed(1)}s`);
      return {
        success: true,
        id: `clip_${timestamp}`,
        title: title || 'YouTube Clip',
        videoId: videoId || null,
        rawPath,
        framePath: fs.existsSync(framePath) ? framePath : null,
        duration: duration || 0,
        videoWidth: videoWidth || 1920,
        videoHeight: videoHeight || 1080,
        timestamp
      };
    } catch (err) {
      log('save-raw-clip failed', err.stack || err.message);
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('enqueue-render', (event, d) => {
    try {
      const cfg = configManager.get();
      const outputPath = path.join(FINAL_DIR, `final_${sanitize(d.title)}_${d.timestamp || Date.now()}.mp4`);
      const job = {
        id: d.id || `job_${Date.now()}`,
        title: d.title || 'YouTube Clip',
        rawPath: d.rawPath,
        framePath: d.framePath,
        outputPath,
        duration: d.duration || 0,
        trimStart: d.trimStart || 0,
        videoWidth: d.videoWidth,
        videoHeight: d.videoHeight,
        crop: d.crop || cfg.crop,
        layout: Object.assign({}, cfg.layout, d.layout || {}, { outputWidth: 1080, outputHeight: 1920 }),
        useNvenc: !!(cfg.encoding && cfg.encoding.useNvenc),
        captionsOnGpu: !!(cfg.encoding && cfg.encoding.captionsOnGpu),
        timestamp: d.timestamp || Date.now()
      };
      const jobId = ffmpegProcessor.enqueue(job);
      return { success: true, jobId, outputPath };
    } catch (err) {
      log('enqueue-render failed', err.message);
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('cancel-job', (e, id) => ffmpegProcessor.cancelJob(id));
  ipcMain.handle('get-queue-status', () => ffmpegProcessor.getQueueStatus());

  ipcMain.handle('open-folder', (e, type = 'final') => {
    shell.openPath(type === 'raw' ? RAW_DIR : type === 'all' ? CLIPS_DIR : FINAL_DIR);
    return true;
  });
  ipcMain.handle('show-in-folder', (e, p) => { if (p && fs.existsSync(p)) { shell.showItemInFolder(p); return true; } return false; });
  ipcMain.handle('open-file', (e, p) => { if (p && fs.existsSync(p)) { shell.openPath(p); return true; } return false; });

  ffmpegProcessor.on('job-started', j => { log('Render start (captions step)', j.id); send('render-job-started', j); });
  let lastStageLogged = null;
  ffmpegProcessor.on('job-progress', d => {
    // log once when the video-encode step begins, so lag lines can be matched to a render step
    if (!d.stage && lastStageLogged !== d.id) { lastStageLogged = d.id; log('Render encode step', d.id); }
    send('render-job-progress', d);
  });
  ffmpegProcessor.on('job-complete', j => { log('Rendered', j.outputPath); send('render-job-complete', j); });
  ffmpegProcessor.on('job-error', j => { log('Render error', j.id, j.error); send('render-job-error', j); });
  ffmpegProcessor.on('queue-updated', s => send('queue-updated', s));
}

app.whenReady().then(() => {
  setupIpcHandlers();
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('will-quit', () => {
  try { fs.rmSync(BUFFER_DIR, { recursive: true, force: true }); } catch (e) {}
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
