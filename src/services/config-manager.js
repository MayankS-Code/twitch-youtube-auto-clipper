const fs = require('fs');
const path = require('path');
const os = require('os');

const CONFIG_PATH = path.join(__dirname, '..', '..', 'config.json');

const DEFAULT_CONFIG = {
  hotkeys: {
    enabled: true,
    recordStart: 'j',
    recordStop: 'k',
    setIn: 'i',
    setOut: 'o'
  },
  crop: {
    configured: false,
    // Normalized (0..1) rectangles on the source video frame
    webcam: { x: 0.02, y: 0.04, width: 0.16, height: 0.38 },
    gameplay: { x: 0.25, y: 0.05, width: 0.7, height: 0.9 }
  },
  layout: {
    outputWidth: 1080,
    outputHeight: 1920,
    webcamShape: '4:3',         // webcam slot = top 30% (576px tall), centered; gameplay = bottom 70%
    backgroundMode: 'blur',     // 'blur' | 'dark' | 'black'
    autoProcessSaved: false
  },
  encoding: {
    // NVENC hardware acceleration: uses the dedicated NVENC ASIC on Nvidia GPUs (0% CPU impact)
    useNvenc: true,
    captionsOnGpu: false, // Whisper on CPU is fast and leaves the GPU to the player
    crf: 20
  },
  live: {
    enabled: false              // rolling MediaRecorder buffer disabled to prevent player lag
  },
  output: {
    finalDir: path.join(os.homedir(), 'Videos', 'Clipper Clips') // where finished 1080x1920 clips are saved
  },
  videoLayouts: {}              // YouTube video ID -> { crop, layout, title }
};

const clone = (o) => JSON.parse(JSON.stringify(o));

function merge(base, extra) {
  const out = clone(base);
  if (!extra || typeof extra !== 'object') return out;
  for (const k of Object.keys(extra)) {
    const v = extra[k];
    if (v && typeof v === 'object' && !Array.isArray(v) && out[k] && typeof out[k] === 'object') {
      out[k] = merge(out[k], v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

class ConfigManager {
  constructor() {
    this.config = this.load();
  }

  load() {
    try {
      if (fs.existsSync(CONFIG_PATH)) {
        const cfg = merge(DEFAULT_CONFIG, JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8')));
        // Output is always vertical 1080x1920
        cfg.layout.outputWidth = 1080;
        cfg.layout.outputHeight = 1920;
        // Captions v2: layouts saved with the old 96px default move to the new bigger default
        const upgrade = (L) => { if (L && L.captions && L.captions.fontSize === 96 && !L.captions.yPct) L.captions.fontSize = 120; };
        upgrade(cfg.layout);
        Object.values(cfg.videoLayouts || {}).forEach(v => upgrade(v.layout));
        return cfg;
      }
    } catch (err) {
      console.error('Error loading config, using defaults:', err);
    }
    return clone(DEFAULT_CONFIG);
  }

  save(newConfig) {
    try {
      this.config = merge(this.config, newConfig);
      this.config.layout.outputWidth = 1080;
      this.config.layout.outputHeight = 1920;
      fs.writeFileSync(CONFIG_PATH, JSON.stringify(this.config, null, 2), 'utf-8');
      return true;
    } catch (err) {
      console.error('Error saving config:', err);
      return false;
    }
  }

  get() {
    return this.config;
  }
}

module.exports = new ConfigManager();
