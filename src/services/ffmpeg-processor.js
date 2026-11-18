const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const EventEmitter = require('events');
const path = require('path');
const { computeLayout } = require('./layout-math');
const { groupWords, buildAss } = require('./captions');
const { toHinglish } = require('./hinglish');

const n6 = (v) => Number(v).toFixed(6);
const TOOLS_DIR = path.join(__dirname, '..', '..', 'tools');
const SUBS_DIR = path.join(TOOLS_DIR, 'subs');
const PYTHON = path.join(TOOLS_DIR, 'venv', 'Scripts', 'python.exe');
const TRANSCRIBE = path.join(TOOLS_DIR, 'transcribe.py');

// Background work must never compete with playback/recording:
//  - LOW = Windows "Idle" priority: only uses CPU time nothing else wants
//  - cap threads so ffmpeg/Whisper can't occupy every core (ffmpeg uses ALL cores by default)
const BG_PRIORITY = os.constants.priority.PRIORITY_LOW;
const BG_THREADS = Math.max(1, Math.min(3, Math.floor(os.cpus().length / 3))); // 6 threads -> 2

function runProc(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { windowsHide: true, ...opts });
    let out = '';
    let err = '';
    p.stdout.on('data', d => { out = (out + d).slice(-4000); });
    p.stderr.on('data', d => { err = (err + d).slice(-4000); });
    try { os.setPriority(p.pid, BG_PRIORITY); } catch (e) {}
    p.on('error', reject);
    p.on('close', code => (code === 0 ? resolve(out) : reject(new Error(`${path.basename(cmd)} exited ${code}: ${err.slice(-600)}`))));
  });
}

class FfmpegProcessor extends EventEmitter {
  constructor() {
    super();
    this.queue = [];
    this.activeJob = null;
    this.isProcessing = false;
  }

  getVideoMetadata(filePath) {
    return new Promise((resolve, reject) => {
      const args = [
        '-v', 'error',
        '-select_streams', 'v:0',
        '-show_entries', 'stream=width,height,duration,r_frame_rate',
        '-show_entries', 'format=duration',
        '-of', 'json',
        filePath
      ];
      const proc = spawn('ffprobe', args, { windowsHide: true });
      let stdout = '';
      let stderr = '';
      proc.stdout.on('data', c => stdout += c);
      proc.stderr.on('data', c => stderr += c);
      proc.on('error', reject);
      proc.on('close', code => {
        if (code !== 0) return reject(new Error(`ffprobe failed (${code}): ${stderr}`));
        try {
          const info = JSON.parse(stdout);
          const s = (info.streams && info.streams[0]) || {};
          const d = parseFloat(s.duration || (info.format && info.format.duration) || 0);
          resolve({
            width: s.width || 1920,
            height: s.height || 1080,
            duration: isNaN(d) ? 0 : d,
            fps: s.r_frame_rate || '30/1'
          });
        } catch (e) {
          reject(e);
        }
      });
    });
  }

  extractSnapshot(rawVideoPath, outputImagePath, atSecond = 1.0) {
    return new Promise((resolve, reject) => {
      const args = ['-ss', Number(atSecond).toFixed(2), '-i', rawVideoPath, '-frames:v', '1', '-q:v', '2', '-y', outputImagePath];
      const proc = spawn('ffmpeg', args, { windowsHide: true });
      proc.on('error', reject);
      proc.on('close', code => {
        if (code === 0 && fs.existsSync(outputImagePath)) resolve(outputImagePath);
        else reject(new Error(`Failed to extract snapshot (code ${code})`));
      });
    });
  }

  enqueue(job) {
    job.status = 'queued';
    job.progress = 0;
    job.createdAt = Date.now();
    this.queue.push(job);
    this.emit('queue-updated', this.getQueueStatus());
    this.processNext();
    return job.id;
  }

  // Never send the ChildProcess object over IPC
  publicJob(job) {
    if (!job) return null;
    const { proc, ...rest } = job;
    return rest;
  }

  getQueueStatus() {
    return {
      active: this.publicJob(this.activeJob),
      queue: this.queue.map(j => this.publicJob(j))
    };
  }

  cancelJob(jobId) {
    if (this.activeJob && this.activeJob.id === jobId) {
      this.activeJob.cancelled = true;
      if (this.activeJob.proc) {
        try { this.activeJob.proc.kill('SIGKILL'); } catch (e) {}
      }
      return true;
    }
    const idx = this.queue.findIndex(j => j.id === jobId);
    if (idx !== -1) {
      this.queue.splice(idx, 1);
      this.emit('queue-updated', this.getQueueStatus());
      return true;
    }
    return false;
  }

  async processNext() {
    if (this.isProcessing || this.queue.length === 0) return;

    this.isProcessing = true;
    const job = this.queue.shift();
    this.activeJob = job;
    job.status = 'processing';
    job.startedAt = Date.now();
    this.emit('job-started', this.publicJob(job));
    this.emit('queue-updated', this.getQueueStatus());

    try {
      await this.renderClipWithFallback(job);
      job.status = 'completed';
      job.progress = 100;
      job.completedAt = Date.now();
      this.emit('job-complete', this.publicJob(job));
    } catch (err) {
      job.status = job.cancelled ? 'cancelled' : 'error';
      job.error = job.cancelled ? 'Cancelled' : (err.message || String(err));
      if (!job.cancelled) console.error(`Render failed for job ${job.id}:`, err);
      this.emit('job-error', this.publicJob(job));
    } finally {
      this.activeJob = null;
      this.isProcessing = false;
      this.emit('queue-updated', this.getQueueStatus());
      this.processNext();
    }
  }

  async renderClipWithFallback(job) {
    try {
      await this.prepareCaptions(job);
    } catch (err) {
      // captions are a bonus: never block the clip because of them
      job.captionError = err.message.split('\n')[0];
      console.warn('Captions skipped:', job.captionError);
      job.assFile = null;
    }
    if (job.cancelled) throw new Error('Cancelled');
    try {
      if (job.useNvenc === false) {
        await this.executeFfmpeg(job, false); // CPU encode: keeps the GPU encoder free for the live buffer
      } else {
        try {
          await this.executeFfmpeg(job, true);
        } catch (err) {
          if (job.cancelled) throw err;
          console.warn('NVENC failed, falling back to libx264:', err.message.split('\n')[0]);
          await this.executeFfmpeg(job, false);
        }
      }
    } finally {
      for (const f of job.tempFiles || []) fs.promises.unlink(f).catch(() => {});
    }
  }

  // Transcribe the exact rendered range with Whisper and build a subtitle file
  async prepareCaptions(job) {
    const cap = (job.layout && job.layout.captions) || {};
    if (cap.enabled === false) return;
    if (!fs.existsSync(PYTHON)) throw new Error('Whisper is not installed (tools/venv missing)');

    fs.mkdirSync(SUBS_DIR, { recursive: true });
    const base = String(job.id).replace(/[^a-zA-Z0-9_-]/g, '_');
    const wav = path.join(SUBS_DIR, `${base}.wav`);
    const json = path.join(SUBS_DIR, `${base}.json`);
    const ass = path.join(SUBS_DIR, `${base}.ass`);
    job.tempFiles = [wav, json, ass];

    this.emit('job-progress', { id: job.id, progress: 0, stage: 'Transcribing for captions…' });

    const trimStart = job.trimStart > 0 ? job.trimStart : 0;
    const audioArgs = ['-v', 'error', '-threads', '1'];
    if (trimStart > 0) audioArgs.push('-ss', trimStart.toFixed(3));
    audioArgs.push('-i', job.rawPath);
    if (trimStart > 0) audioArgs.push('-t', String(job.duration || 60));
    audioArgs.push('-vn', '-ac', '1', '-ar', '16000', '-y', wav);
    await runProc('ffmpeg', audioArgs);

    // language: auto | en | hi (shown as Roman Hinglish) | hi-deva (Devanagari script)
    const lang = cap.language || 'auto';
    const devanagari = lang === 'hi-deva';
    const env = {
      ...process.env,
      HF_HUB_DISABLE_SYMLINKS_WARNING: '1',
      CLIPPER_WHISPER_MODEL: cap.model === 'medium' ? 'medium' : 'small',
      // captions on CPU by default (same model, ~6s/clip): the GPU stays free for the player
      CLIPPER_WHISPER_DEVICE: job.captionsOnGpu ? '' : 'cpu',
      CLIPPER_WHISPER_CPU_MODEL: job.captionsOnGpu ? 'base' : (cap.model === 'medium' ? 'medium' : 'small'),
      CLIPPER_WHISPER_THREADS: String(BG_THREADS),
      OMP_NUM_THREADS: String(BG_THREADS),
      MKL_NUM_THREADS: String(BG_THREADS)
    };
    const out = await runProc(PYTHON, [TRANSCRIBE, wav, json, devanagari ? 'hi' : lang], { cwd: TOOLS_DIR, env });
    const data = JSON.parse(fs.readFileSync(json, 'utf-8'));
    job.captionInfo = out.trim().split('\n').pop();

    let words = data.words || [];
    if (!devanagari) words = words.map(w => ({ ...w, word: toHinglish(w.word) }));
    const lines = groupWords(words);
    if (!lines.length) return;

    fs.writeFileSync(ass, buildAss(lines, {
      x: 540,
      // default 81% of the height: just above where phone players draw their timeline
      y: Math.round(1920 * (cap.yPct || 81) / 100),
      fontSize: cap.fontSize || 120,
      fontName: devanagari ? 'Nirmala UI' : undefined // Windows font that has Devanagari
    }), 'utf-8');
    // relative path: ffmpeg runs with cwd=tools, avoids Windows drive-colon escaping in filters
    job.assFile = `subs/${base}.ass`;
  }

  buildFilterGraph(meta, crop, layout, assFile) {
    const L = computeLayout(meta.width, meta.height, crop, layout);
    const { outW, outH } = L;
    const cs = L.cam.src, cd = L.cam.dst;
    const gs = L.game.src, gd = L.game.dst;

    // Crops use expressions relative to the live input size (iw/ih), so the
    // render stays correct even if YouTube switched quality mid-recording.
    const cropExpr = (r) => `crop=w=iw*${n6(r.w)}:h=ih*${n6(r.h)}:x=iw*${n6(r.x)}:y=ih*${n6(r.y)}`;

    const parts = [];
    const mode = layout.backgroundMode || 'blur';
    if (mode === 'blur') {
      parts.push(`[0:v]split=3[vbg][vcam][vgame]`);
      // Blur at 1/4 size then upscale: looks the same as a big blur at full size,
      // but costs ~16x less CPU (full-size boxblur 25:5 was the heaviest part of the render)
      const bw = Math.round(outW / 8) * 2, bh = Math.round(outH / 8) * 2;
      parts.push(`[vbg]scale=${bw}:${bh}:force_original_aspect_ratio=increase:flags=fast_bilinear,crop=${bw}:${bh},boxblur=6:3,scale=${outW}:${outH}:flags=bilinear,setsar=1[bg]`);
    } else {
      const color = mode === 'dark' ? '0x0c0d12' : 'black';
      parts.push(`[0:v]split=2[vcam][vgame]`);
      parts.push(`color=c=${color}:s=${outW}x${outH}:r=30[bg]`);
    }
    parts.push(`[vcam]${cropExpr(cs)},scale=${cd.w}:${cd.h},setsar=1[cam]`);
    parts.push(`[vgame]${cropExpr(gs)},scale=${gd.w}:${gd.h},setsar=1[game]`);
    parts.push(`[bg][game]overlay=x=${gd.x}:y=${gd.y}:shortest=1[bg_game]`);
    // Always a constant 60 fps output, whatever rate the recording came in at
    const subs = assFile ? `,ass=${assFile}:fontsdir=fonts` : '';
    // fps=60 goes LAST: captions + colour conversion run at the source rate (usually 30fps)
    // and the 60fps step just repeats finished frames, instead of doubling all the work
    parts.push(`[bg_game][cam]overlay=x=${cd.x}:y=${cd.y}:shortest=1${subs},format=yuv420p,fps=60[outv]`);
    return parts.join(';');
  }

  async executeFfmpeg(job, useNvenc = true) {
    let meta;
    try {
      meta = await this.getVideoMetadata(job.rawPath);
    } catch (e) {
      meta = { width: job.videoWidth || 1920, height: job.videoHeight || 1080, duration: 0 };
    }
    // MediaRecorder WebM files often carry no duration header
    const trimStart = job.trimStart > 0 ? job.trimStart : 0;
    const totalDuration = trimStart > 0 ? (job.duration || 60) : (meta.duration > 0 ? meta.duration : (job.duration || 0));

    const filterGraph = this.buildFilterGraph(meta, job.crop, job.layout || {}, job.assFile);

    const T = String(BG_THREADS);
    const args = ['-hide_banner', '-filter_complex_threads', T];
    // Live clips: the stitched buffer can be a bit longer than 60s; seek to the last 60s
    if (trimStart > 0) args.push('-ss', trimStart.toFixed(3));
    args.push('-threads', T, '-i', job.rawPath); // decoder threads
    if (trimStart > 0) args.push('-t', totalDuration.toFixed(3));
    args.push('-filter_complex', filterGraph, '-map', '[outv]', '-map', '0:a?');
    if (useNvenc) {
      args.push('-c:v', 'h264_nvenc', '-preset', 'p4', '-rc', 'vbr', '-cq', '21', '-b:v', '0');
    } else {
      args.push('-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-threads', T);
    }
    args.push('-r', '60', '-fps_mode', 'cfr', '-g', '120', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', '-y', job.outputPath);

    return new Promise((resolve, reject) => {
      const proc = spawn('ffmpeg', args, { windowsHide: true, cwd: TOOLS_DIR });
      job.proc = proc;

      try {
        os.setPriority(proc.pid, BG_PRIORITY);
      } catch (e) {}

      let stderrLog = '';
      proc.stderr.on('data', chunk => {
        const text = chunk.toString();
        stderrLog = (stderrLog + text).slice(-4000);
        const m = text.match(/time=(\d{2}):(\d{2}):(\d{2})\.(\d{2})/);
        if (m && totalDuration > 0) {
          const t = (+m[1]) * 3600 + (+m[2]) * 60 + (+m[3]) + (+m[4]) / 100;
          const pct = Math.min(99, Math.round((t / totalDuration) * 100));
          job.progress = pct;
          this.emit('job-progress', { id: job.id, progress: pct });
        }
      });

      proc.on('close', code => {
        job.proc = null;
        if (code === 0 && fs.existsSync(job.outputPath)) resolve(job.outputPath);
        else reject(new Error(`FFmpeg exited with code ${code}.\n${stderrLog.slice(-800)}`));
      });
      proc.on('error', err => {
        job.proc = null;
        reject(err);
      });
    });
  }
}

module.exports = new FfmpegProcessor();
