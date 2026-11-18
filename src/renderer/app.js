const { ipcRenderer } = require('electron');
const { computeLayout, clampRect, slotAspects } = require('../services/layout-math');

const $ = (id) => document.getElementById(id);

// ---------- Elements
const webview = $('yt-webview');
const urlInput = $('url-input');
const pointsSummary = $('points-summary');
const btnManualRec = $('btn-manual-rec');
const manualRecText = $('manual-rec-text');
const hostRecHud = $('host-rec-hud');
const hostRecTimer = $('host-rec-timer');
const hotkeyStatusDot = $('hotkey-status-dot');
const queueDrawer = $('queue-drawer');
const queueBadge = $('queue-badge');
const queueList = $('queue-list');
const toastContainer = $('toast-container');

const cropModal = $('crop-modal');
const modalTitle = $('modal-title');
const canvasWrapper = $('canvas-wrapper');
const stage = $('canvas-stage');
const cropCanvas = $('crop-canvas');
const previewCanvas = $('preview-canvas');
const boxes = { webcam: $('box-webcam'), gameplay: $('box-gameplay') };
const btnSelect = { webcam: $('btn-select-webcam'), gameplay: $('btn-select-gameplay') };
const webcamShapeSelect = $('webcam-shape-select');
const bgStyleSelect = $('bg-style-select');
const chkCaptions = $('chk-captions');
const captionSizeSlider = $('caption-size-slider');
const captionSizeDisplay = $('caption-size-display');
const captionLangSelect = $('caption-lang-select');
const chkAutoProcess = $('chk-auto-process');
const btnApplyRender = $('btn-apply-render');

// ---------- State
let webviewReady = false;
let isRecording = false;
let recTimer = null;
let recStart = 0;
let hotkeysEnabled = true;
let completedClips = [];
let pendingClips = [];
let appConfig = {};
let liveOn = false;

async function reloadConfig() {
  appConfig = await ipcRenderer.invoke('get-config');
  return appConfig;
}

const DEFAULT_CROP = {
  webcam: { x: 0.02, y: 0.04, width: 0.16, height: 0.38 },
  gameplay: { x: 0.25, y: 0.05, width: 0.7, height: 0.9 }
};
let cropState = JSON.parse(JSON.stringify(DEFAULT_CROP));
let editingClip = null;
let snapshotImage = null;
let imgW = 1920;
let imgH = 1080;
let selectedBox = 'webcam';
let drag = null;

// ---------- Utilities
function formatTime(sec) {
  if (sec === null || sec === undefined || isNaN(sec)) return '--:--';
  return `${String(Math.floor(sec / 60)).padStart(2, '0')}:${String(Math.floor(sec % 60)).padStart(2, '0')}`;
}

function showToast(message, type = 'normal', ms = 3500) {
  const t = document.createElement('div');
  t.className = `toast ${type === 'success' ? 'toast-success' : type === 'error' ? 'toast-error' : ''}`;
  t.textContent = message;
  toastContainer.appendChild(t);
  setTimeout(() => { t.style.opacity = '0'; setTimeout(() => t.remove(), 300); }, ms);
}

function logError(msg) {
  ipcRenderer.invoke('log', msg).catch(() => {});
}
window.addEventListener('error', (e) => logError(`renderer error: ${e.message} @ ${e.filename}:${e.lineno}`));
window.addEventListener('unhandledrejection', (e) => logError(`renderer rejection: ${e.reason && (e.reason.stack || e.reason)}`));

// ---------- Webview bridge (single path: IPC; never throws)
function sendToWebview(command, data) {
  if (!webviewReady) {
    showToast('YouTube is still loading — try again in a second');
    return false;
  }
  try {
    webview.send('host-command', { command, data });
    return true;
  } catch (e) {
    logError('sendToWebview failed: ' + e.message);
    showToast('Could not reach the YouTube page: ' + e.message, 'error');
    return false;
  }
}

webview.addEventListener('dom-ready', () => {
  webviewReady = true;
  sendToWebview('set-hotkeys-enabled', hotkeysEnabled);
  sendToWebview('set-live', liveOn);
  sendToWebview('set-auto-clip', autoPayload(autoOn));
});

// auto clip on/off + the per-channel tolerances learned so far
function autoPayload(on) {
  return { on: !!on, tolerances: (appConfig.live && appConfig.live.tolerances) || {} };
}
webview.addEventListener('did-start-navigation', (e) => { if (e.isMainFrame && !e.isInPlace) webviewReady = false; });
webview.addEventListener('did-navigate', (e) => { urlInput.value = e.url; });
webview.addEventListener('did-navigate-in-page', (e) => { if (e.isMainFrame) urlInput.value = e.url; });
webview.addEventListener('render-process-gone', () => {
  webviewReady = false;
  setRecordingUi(false);
  showToast('YouTube page crashed — reloading', 'error');
  webview.reload();
});

webview.addEventListener('ipc-message', (event) => {
  const args = (event.args && event.args[0]) || {};
  switch (event.channel) {
    case 'recording-state-changed': setRecordingUi(!!args.isRecording); break;
    case 'points-updated':
      pointsSummary.textContent = `A ${formatTime(args.inPoint)} · B ${formatTime(args.outPoint)}`;
      break;
    case 'clip-captured': handleClipCaptured(args); break;
    case 'clip-saved': handleSavedClip(args); break;
    case 'live-state': setLiveUi(!!args.on, args.seconds || 0, !!args.paused); break;
    case 'auto-state': if (autoOn) setAutoUi(true, !!args.chat, !!args.audio, args.tolerance, args.window); break;
    case 'tolerance-changed':
      appConfig.live = appConfig.live || {};
      appConfig.live.tolerances = { ...(appConfig.live.tolerances || {}), [args.videoId]: args.tolerance };
      ipcRenderer.invoke('save-config', { live: { tolerances: { [args.videoId]: args.tolerance } } });
      logError(`tolerance ${args.videoId}: ${args.previous} -> ${args.tolerance} (${args.clips} clips in 5 min)`);
      break;
    case 'auto-clip':
      showToast(args.loud
        ? `⚡ Loud moment: audio jumped +${args.jump} dB — clipping last 30s`
        : `⚡ Chat moment: "${args.word}" ×${args.count} from ${args.authors} people — clipping last 30s`, 'success', 5000);
      logError(`auto-clip: ${args.reason}`);
      break;
    case 'snapshot-captured':
      if (args.error) showToast(args.error + ' — showing a placeholder frame');
      openCropStudio({ id: `preview_${Date.now()}`, title: args.title || 'Layout', videoId: args.videoId || null, frameDataUrl: args.dataUrl });
      break;
    case 'clipper-info':
      logError('webview: ' + args);
      break;
    case 'clipper-error':
      showToast(String(args), 'error', 6000);
      logError('webview: ' + args);
      break;
  }
});

// ---------- Init
async function initApp() {
  const cfg = await reloadConfig();
  liveOn = !!(cfg.live && cfg.live.enabled);
  autoOn = !!(cfg.live && cfg.live.autoClip);
  if (autoOn) liveOn = true;
  setLiveUi(liveOn, 0, true);
  setAutoUi(autoOn);
  if (cfg.crop && cfg.crop.webcam && cfg.crop.gameplay) {
    cropState = { webcam: clampRect(cfg.crop.webcam), gameplay: clampRect(cfg.crop.gameplay) };
  }
  const L = cfg.layout || {};
  webcamShapeSelect.value = ['4:3', '3:4', '16:9', 'full'].includes(L.webcamShape) ? L.webcamShape : '4:3';
  bgStyleSelect.value = L.backgroundMode || 'blur';
  chkAutoProcess.checked = !!L.autoProcessSaved;
  hotkeysEnabled = !(cfg.hotkeys && cfg.hotkeys.enabled === false);
  hotkeyStatusDot.classList.toggle('active', hotkeysEnabled);
  updateQueueUI();
}
initApp();

// ---------- Navigation
$('btn-back').onclick = () => { if (webview.canGoBack()) webview.goBack(); };
$('btn-forward').onclick = () => { if (webview.canGoForward()) webview.goForward(); };
$('btn-reload').onclick = () => webview.reload();
$('btn-home').onclick = () => webview.loadURL('https://www.youtube.com');
$('btn-twitch').onclick = () => webview.loadURL('https://www.twitch.tv');

function markSite(url) {
  const tw = /twitch\.tv/i.test(url || '');
  $('btn-twitch').classList.toggle('active', tw);
  $('btn-home').classList.toggle('active', /youtube\.com/i.test(url || ''));
}
webview.addEventListener('did-navigate', (e) => markSite(e.url));

function navigateToUrl() {
  let v = urlInput.value.trim();
  if (!v) return;
  if (!/^https?:\/\//i.test(v)) {
    const onTwitch = /twitch\.tv/i.test(webview.getURL ? (() => { try { return webview.getURL(); } catch (e) { return ''; } })() : '');
    v = v.includes('.') && !v.includes(' ')
      ? 'https://' + v
      : onTwitch
        ? 'https://www.twitch.tv/search?term=' + encodeURIComponent(v)
        : 'https://www.youtube.com/results?search_query=' + encodeURIComponent(v);
  }
  webview.loadURL(v);
}
urlInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') navigateToUrl(); });
$('btn-go').onclick = navigateToUrl;

// ---------- Recording controls
$('hotkey-toggle-btn').onclick = () => {
  hotkeysEnabled = !hotkeysEnabled;
  hotkeyStatusDot.classList.toggle('active', hotkeysEnabled);
  sendToWebview('set-hotkeys-enabled', hotkeysEnabled);
  ipcRenderer.invoke('save-config', { hotkeys: { enabled: hotkeysEnabled } });
  showToast(hotkeysEnabled ? 'Hotkeys J/K/I/O on' : 'Hotkeys off');
};
$('btn-mark-in').onclick = () => sendToWebview('set-in-point');
$('btn-mark-out').onclick = () => sendToWebview('set-out-point');
$('btn-clip-ab').onclick = () => sendToWebview('record-range');
btnManualRec.onclick = () => sendToWebview(isRecording ? 'stop-recording' : 'start-recording');
$('btn-hud-stop').onclick = () => sendToWebview('stop-recording');

function setRecordingUi(rec) {
  if (rec === isRecording) return;
  isRecording = rec;
  btnManualRec.classList.toggle('recording', rec);
  manualRecText.textContent = rec ? 'Stop' : 'Record';
  hostRecHud.classList.toggle('hidden', !rec);
  clearInterval(recTimer);
  if (rec) {
    recStart = Date.now();
    hostRecTimer.textContent = '00:00';
    recTimer = setInterval(() => { hostRecTimer.textContent = formatTime((Date.now() - recStart) / 1000); }, 250);
  }
}

// Hotkeys when focus is in this window (e.g. after clicking a toolbar button or with the editor open)
document.addEventListener('keydown', (e) => {
  const modalOpen = !cropModal.classList.contains('hidden');
  if (modalOpen) {
    if (e.key === 'Escape') { closeCropStudio(); return; }
    if (e.key === 'Enter' && e.target.tagName !== 'SELECT') { e.preventDefault(); applyLayout(); return; }
    if (e.key.startsWith('Arrow')) { nudgeSelected(e); return; }
  }
  if (!hotkeysEnabled || e.ctrlKey || e.altKey || e.metaKey) return;
  if (e.target && (e.target.tagName === 'INPUT' && e.target.type === 'text')) return;
  const k = (e.key || '').toLowerCase();
  if (k === 'j' && !isRecording) sendToWebview('start-recording');
  else if (k === 'k' && isRecording) sendToWebview('stop-recording');
  else if (k === 'i' && !modalOpen) sendToWebview('set-in-point');
  else if (k === 'o' && !modalOpen) sendToWebview('set-out-point');
  else if (k === 'h') liveClip(60);
  else if (k === 'g') liveClip(30);
});

// ---------- Live buffer
const btnLiveToggle = $('btn-live-toggle');
const btnLiveClip = $('btn-live-clip');
const btnLiveClip30 = $('btn-live-clip-30');

function setLiveUi(on, seconds, paused) {
  btnLiveToggle.classList.toggle('on', on);
  btnLiveToggle.classList.toggle('paused', on && paused);
  $('live-text').textContent = on ? `Live ${seconds}s${paused ? ' ⏸' : ''}` : 'Live off';
  btnLiveClip.disabled = !on || seconds < 1;
  btnLiveClip30.disabled = !on || seconds < 1;
}

btnLiveToggle.onclick = () => {
  liveOn = !liveOn;
  if (!liveOn && autoOn) setAuto(false); // auto clip needs the live buffer
  setLiveUi(liveOn, 0, true);
  sendToWebview('set-live', liveOn);
  ipcRenderer.invoke('save-config', { live: { enabled: liveOn } });
  showToast(liveOn ? 'Live buffer on — keeps the last 60s while the video plays' : 'Live buffer off');
};

function liveClip(seconds = 60) {
  if (!liveOn) { showToast('Turn on Live first'); return; }
  sendToWebview('live-clip', seconds === 30 ? 30 : 60);
}
btnLiveClip.onclick = () => liveClip(60);
btnLiveClip30.onclick = () => liveClip(30);

// ---------- Auto clip from chat
const btnAutoClip = $('btn-auto-clip');
let autoOn = false;

function setAutoUi(on, chatFound = true, audio = false, tolerance = null, windowSize = 15) {
  btnAutoClip.classList.toggle('on', on);
  btnAutoClip.classList.toggle('no-chat', on && !chatFound && !audio);
  const watching = [chatFound && (tolerance ? `chat ${tolerance}/${windowSize}` : 'chat'), audio && 'audio'].filter(Boolean).join(' + ');
  btnAutoClip.textContent = !on ? '⚡ Auto clip: off' : watching ? `⚡ Auto clip: ${watching}` : '⚡ Auto clip: waiting for stream';
}

function setAuto(on, save = true) {
  autoOn = on;
  if (on && !liveOn) {
    // auto clips come from the live buffer, so it has to be running
    liveOn = true;
    setLiveUi(true, 0, true);
    sendToWebview('set-live', true);
    if (save) ipcRenderer.invoke('save-config', { live: { enabled: true } });
  }
  setAutoUi(on);
  sendToWebview('set-auto-clip', autoPayload(on));
  if (save) ipcRenderer.invoke('save-config', { live: { autoClip: on } });
}

btnAutoClip.onclick = () => {
  setAuto(!autoOn);
  showToast(autoOn ? 'Auto clip on: clips the last 30s when chat spams the same word' : 'Auto clip off');
};

// ---------- Clip pipeline
async function handleClipCaptured(payload) {
  const saved = await ipcRenderer.invoke('save-raw-clip', payload);
  if (!saved.success) {
    showToast('Error saving clip: ' + saved.error, 'error', 6000);
    return;
  }
  handleSavedClip(saved);
}

// Same video seen before -> its layout is cached -> queue instantly, no editor.
function cachedLayoutFor(videoId) {
  const v = videoId && appConfig.videoLayouts && appConfig.videoLayouts[videoId];
  return v && v.crop && v.layout ? v : null;
}

async function handleSavedClip(saved) {
  const cached = cachedLayoutFor(saved.videoId);
  if (cached) {
    await enqueueClip(saved, cached.crop, cached.layout);
    showToast(`Queued "${saved.title.slice(0, 30)}" (saved layout)`, 'success');
    return;
  }
  const cfg = appConfig;
  if (cfg.crop && cfg.crop.configured && cfg.layout && cfg.layout.autoProcessSaved) {
    await enqueueClip(saved, cfg.crop, cfg.layout);
    if (saved.videoId) {
      await ipcRenderer.invoke('save-config', { videoLayouts: { [saved.videoId]: { crop: cfg.crop, layout: cfg.layout, title: saved.title } } });
      await reloadConfig();
    }
    showToast(`Queued "${saved.title.slice(0, 30)}" (last layout)`, 'success');
  } else if (!cropModal.classList.contains('hidden')) {
    pendingClips.push(saved);
    showToast('Clip saved — it will use the layout you are setting now');
  } else {
    openCropStudio(saved);
  }
}

async function enqueueClip(clip, crop, layout) {
  const r = await ipcRenderer.invoke('enqueue-render', {
    id: clip.id,
    title: clip.title,
    rawPath: clip.rawPath,
    framePath: clip.framePath,
    timestamp: clip.timestamp,
    duration: clip.duration,
    trimStart: clip.trimStart || 0,
    videoWidth: clip.videoWidth,
    videoHeight: clip.videoHeight,
    crop,
    layout
  });
  if (!r.success) showToast('Failed to queue render: ' + r.error, 'error');
  updateQueueUI();
}

function currentLayout() {
  return {
    outputWidth: 1080,
    outputHeight: 1920,
    webcamShape: webcamShapeSelect.value,
    captions: {
      enabled: chkCaptions.checked,
      fontSize: parseInt(captionSizeSlider.value, 10),
      yPct: parseInt($('caption-pos-slider').value, 10),
      language: captionLangSelect.value,
      model: $('caption-model-select').value
    },
    backgroundMode: bgStyleSelect.value,
    autoProcessSaved: chkAutoProcess.checked
  };
}

// ---------- Layout editor: open / close
$('btn-open-crop-editor').onclick = () => {
  if (webviewReady) {
    if (!sendToWebview('request-snapshot')) openCropStudio({ id: `preview_${Date.now()}`, title: 'Layout' });
  } else {
    openCropStudio({ id: `preview_${Date.now()}`, title: 'Layout' });
  }
};

function loadLayoutIntoEditor(videoId) {
  const src = cachedLayoutFor(videoId) || { crop: appConfig.crop, layout: appConfig.layout };
  if (src.crop && src.crop.webcam && src.crop.gameplay) {
    cropState = { webcam: clampRect(src.crop.webcam), gameplay: clampRect(src.crop.gameplay) };
  }
  const L = src.layout || {};
  webcamShapeSelect.value = ['4:3', '3:4', '16:9', 'full'].includes(L.webcamShape) ? L.webcamShape : '4:3';
  bgStyleSelect.value = L.backgroundMode || 'blur';
  chkAutoProcess.checked = !!(appConfig.layout && appConfig.layout.autoProcessSaved);
  const C = L.captions || {};
  chkCaptions.checked = C.enabled !== false;
  captionSizeSlider.value = C.fontSize || 120;
  captionSizeDisplay.textContent = `${captionSizeSlider.value}px`;
  $('caption-pos-slider').value = C.yPct || 81;
  $('caption-pos-display').textContent = `${$('caption-pos-slider').value}%`;
  captionLangSelect.value = ['auto', 'en', 'hi', 'hi-deva'].includes(C.language) ? C.language : 'auto';
  $('caption-model-select').value = C.model === 'medium' ? 'medium' : 'small';
}

chkCaptions.addEventListener('change', () => refreshEditor());
captionLangSelect.addEventListener('change', () => refreshEditor());
$('caption-pos-slider').addEventListener('input', () => {
  $('caption-pos-display').textContent = `${$('caption-pos-slider').value}%`;
  refreshEditor();
});
captionSizeSlider.addEventListener('input', () => {
  captionSizeDisplay.textContent = `${captionSizeSlider.value}px`;
  refreshEditor();
});
// redraw once the caption font is ready so the preview uses the real font
document.fonts.load('96px "Clipper Caption"').then(() => refreshEditor()).catch(() => {});

function openCropStudio(clip) {
  editingClip = clip;
  loadLayoutIntoEditor(clip.videoId);
  const short = (clip.title || '').slice(0, 60);
  const isChannel = clip.videoId && /^twitch_(?!v_|clip_)/.test(clip.videoId);
  modalTitle.textContent = !clip.videoId ? 'Default layout'
    : isChannel ? `Layout for this Twitch channel: ${short}` : `Layout for this video: ${short}`;
  btnApplyRender.textContent = clip.rawPath ? 'Save & render ⏎' : 'Save layout ⏎';
  cropModal.classList.remove('hidden');

  const img = new Image();
  img.onload = () => {
    snapshotImage = img;
    imgW = img.naturalWidth || 1920;
    imgH = img.naturalHeight || 1080;
    cropCanvas.width = imgW;
    cropCanvas.height = imgH;
    fitBoxesToSlots();
    requestAnimationFrame(() => { fitStage(); refreshEditor(); });
  };
  img.onerror = () => { img.onerror = null; img.src = placeholderFrame(); };

  if (clip.frameDataUrl) img.src = clip.frameDataUrl;
  else if (clip.framePath) img.src = 'file:///' + clip.framePath.replace(/\\/g, '/') + '?t=' + Date.now();
  else img.src = placeholderFrame();
}

function placeholderFrame() {
  const c = document.createElement('canvas');
  c.width = 1920; c.height = 1080;
  const g = c.getContext('2d');
  g.fillStyle = '#1e293b'; g.fillRect(0, 0, 1920, 1080);
  g.fillStyle = '#94a3b8'; g.font = 'bold 42px sans-serif'; g.textAlign = 'center';
  g.fillText('No video frame — open a YouTube video for a real preview', 960, 540);
  return c.toDataURL();
}

function closeCropStudio() {
  cropModal.classList.add('hidden');
  drag = null;
  if (pendingClips.length) {
    const next = pendingClips.shift();
    setTimeout(() => handleSavedClip(next), 150);
  }
}
$('btn-close-modal').onclick = closeCropStudio;
$('btn-cancel-crop').onclick = closeCropStudio;

async function applyLayout() {
  const layout = currentLayout();
  const crop = { configured: true, webcam: { ...cropState.webcam }, gameplay: { ...cropState.gameplay } };
  const clip = editingClip || {};
  const vid = clip.videoId;

  // Saved for this video, and as the starting point for new videos
  const patch = { crop, layout };
  if (vid) patch.videoLayouts = { [vid]: { crop, layout, title: clip.title || '' } };
  await ipcRenderer.invoke('save-config', patch);
  await reloadConfig();

  if (clip.rawPath) await enqueueClip(clip, crop, layout);

  // Clips from the same video that arrived while editing use this layout too
  const same = pendingClips.filter(p => vid && p.videoId === vid);
  pendingClips = pendingClips.filter(p => !same.includes(p));
  for (const p of same) await enqueueClip(p, crop, layout);

  const n = (clip.rawPath ? 1 : 0) + same.length;
  showToast(vid ? `Layout saved for this video${n ? ` · ${n} clip(s) rendering` : ''}` : 'Default layout saved', 'success');
  closeCropStudio();
}
btnApplyRender.onclick = applyLayout;

// Stage = the exact on-screen box of the frame; boxes are positioned in % of it.
function fitStage() {
  const r = canvasWrapper.getBoundingClientRect();
  const s = Math.min((r.width - 16) / imgW, (r.height - 16) / imgH);
  stage.style.width = `${Math.max(50, Math.floor(imgW * s))}px`;
  stage.style.height = `${Math.max(30, Math.floor(imgH * s))}px`;
}
window.addEventListener('resize', () => { if (!cropModal.classList.contains('hidden') && snapshotImage) fitStage(); });

// ---------- Layout editor: drawing
function refreshEditor() {
  if (!snapshotImage) return;
  for (const key of ['webcam', 'gameplay']) {
    const r = cropState[key];
    const el = boxes[key];
    el.style.left = `${r.x * 100}%`;
    el.style.top = `${r.y * 100}%`;
    el.style.width = `${r.width * 100}%`;
    el.style.height = `${r.height * 100}%`;
    el.classList.toggle('selected', key === selectedBox);
    btnSelect[key].classList.toggle('selected', key === selectedBox);
  }
  const layout = currentLayout();
  const L = computeLayout(imgW, imgH, cropState, layout);
  drawSourceCanvas(L);
  drawPreview(L, layout);
}

function drawSourceCanvas() {
  cropCanvas.getContext('2d').drawImage(snapshotImage, 0, 0, imgW, imgH);
}

function drawPreview(L, layout) {
  const g = previewCanvas.getContext('2d');
  const W = L.outW, H = L.outH;
  if (previewCanvas.width !== W) previewCanvas.width = W;
  if (previewCanvas.height !== H) previewCanvas.height = H;

  // Background (same as ffmpeg: whole frame, cover-scaled)
  g.save();
  if (layout.backgroundMode === 'blur') {
    const s = Math.max(W / imgW, H / imgH);
    const bw = imgW * s, bh = imgH * s;
    g.fillStyle = '#000'; g.fillRect(0, 0, W, H);
    g.filter = 'blur(24px)';
    g.drawImage(snapshotImage, (W - bw) / 2, (H - bh) / 2, bw, bh);
  } else {
    g.fillStyle = layout.backgroundMode === 'dark' ? '#0c0d12' : '#000000';
    g.fillRect(0, 0, W, H);
  }
  g.restore();

  const blit = (part) => {
    const s = part.src, d = part.dst;
    g.drawImage(snapshotImage, s.x * imgW, s.y * imgH, s.w * imgW, s.h * imgH, d.x, d.y, d.w, d.h);
  };
  blit(L.game);
  blit(L.cam);

  // Sample caption exactly where the real ones go (centered on the dividing line)
  if (layout.captions && layout.captions.enabled) {
    const size = layout.captions.fontSize || 120;
    const y = Math.round(H * (layout.captions.yPct || 81) / 100);
    g.save();
    g.font = `${size}px "Clipper Caption", "Arial Black", sans-serif`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    // same look as the render: 2px solid black outline + small soft shadow
    g.shadowColor = 'rgba(0,0,0,0.6)';
    g.shadowBlur = 4;
    g.shadowOffsetX = 2;
    g.shadowOffsetY = 2;
    g.lineWidth = 4; // stroke is centered on the edge, so 4 = 2px outside
    g.strokeStyle = '#000';
    g.lineJoin = 'round';
    g.strokeText('where', W / 2, y);
    g.shadowColor = 'transparent';
    g.fillStyle = '#ffffff';
    g.fillText('where', W / 2, y);
    g.restore();
  }
}

webcamShapeSelect.addEventListener('change', () => { fitBoxesToSlots(); refreshEditor(); });
bgStyleSelect.addEventListener('change', refreshEditor);

function selectBox(key) {
  selectedBox = key;
  refreshEditor();
}
btnSelect.webcam.onclick = () => selectBox('webcam');
btnSelect.gameplay.onclick = () => selectBox('gameplay');
$('btn-reset-crop').onclick = () => {
  cropState = JSON.parse(JSON.stringify(DEFAULT_CROP));
  fitBoxesToSlots();
  refreshEditor();
};

// ---------- Layout editor: geometry (all done in source pixels)
const MIN_PX = 16;
const toPx = (r) => ({ x: r.x * imgW, y: r.y * imgH, w: r.width * imgW, h: r.height * imgH });
const toNorm = (p) => clampRect({ x: p.x / imgW, y: p.y / imgH, width: p.w / imgW, height: p.h / imgH });

const aspectOf = (key) => slotAspects(currentLayout())[key];

function lockAspect(rect, aspect) {
  // Shrink the rect around its center to exactly the slot's shape in real pixels
  const p = toPx(rect);
  const cx = p.x + p.w / 2, cy = p.y + p.h / 2;
  let w = p.w, h = p.h;
  if (w / h > aspect) w = h * aspect; else h = w / aspect;
  return toNorm({ x: cx - w / 2, y: cy - h / 2, w, h });
}

// Each box always has the exact shape of its slot on the right, so it maps 1:1
function fitBoxesToSlots() {
  cropState.webcam = lockAspect(cropState.webcam, aspectOf('webcam'));
  cropState.gameplay = lockAspect(cropState.gameplay, aspectOf('gameplay'));
}

function resizePx(start, handle, dx, dy, aspect) {
  const CAM_ASPECT = aspect;
  const lock = true;
  let left = start.x, top = start.y, right = start.x + start.w, bottom = start.y + start.h;
  if (handle.includes('w')) left = Math.min(right - MIN_PX, Math.max(0, start.x + dx));
  if (handle.includes('e')) right = Math.max(left + MIN_PX, Math.min(imgW, start.x + start.w + dx));
  if (handle.includes('n')) top = Math.min(bottom - MIN_PX, Math.max(0, start.y + dy));
  if (handle.includes('s')) bottom = Math.max(top + MIN_PX, Math.min(imgH, start.y + start.h + dy));
  if (!lock) return { x: left, y: top, w: right - left, h: bottom - top };

  let w = right - left, h = bottom - top;
  if (handle === 'e' || handle === 'w') h = w / CAM_ASPECT;
  else if (handle === 'n' || handle === 's') w = h * CAM_ASPECT;
  else if (w / h > CAM_ASPECT) h = w / CAM_ASPECT; else w = h * CAM_ASPECT;

  // Anchor on the opposite side/corner (or the center for the other axis on edge handles)
  const ax = handle.includes('w') ? 'right' : handle.includes('e') ? 'left' : 'center';
  const ay = handle.includes('n') ? 'bottom' : handle.includes('s') ? 'top' : 'center';
  const fixX = ax === 'right' ? start.x + start.w : ax === 'left' ? start.x : start.x + start.w / 2;
  const fixY = ay === 'bottom' ? start.y + start.h : ay === 'top' ? start.y : start.y + start.h / 2;
  const availW = ax === 'right' ? fixX : ax === 'left' ? imgW - fixX : 2 * Math.min(fixX, imgW - fixX);
  const availH = ay === 'bottom' ? fixY : ay === 'top' ? imgH - fixY : 2 * Math.min(fixY, imgH - fixY);
  const k = Math.min(1, availW / w, availH / h);
  w *= k; h *= k;
  const x = ax === 'right' ? fixX - w : ax === 'left' ? fixX : fixX - w / 2;
  const y = ay === 'bottom' ? fixY - h : ay === 'top' ? fixY : fixY - h / 2;
  return { x, y, w, h };
}

function pointerToPx(e) {
  const r = stage.getBoundingClientRect();
  return { x: ((e.clientX - r.left) / r.width) * imgW, y: ((e.clientY - r.top) / r.height) * imgH };
}

function hitTest(p) {
  const inside = (key) => {
    const b = toPx(cropState[key]);
    return p.x >= b.x && p.x <= b.x + b.w && p.y >= b.y && p.y <= b.y + b.h;
  };
  const hits = ['webcam', 'gameplay'].filter(inside);
  if (!hits.length) return null;
  if (hits.includes(selectedBox)) return selectedBox;
  // Otherwise the smaller box wins, so a big gameplay box never blocks the webcam box
  return hits.sort((a, b) => cropState[a].width * cropState[a].height - cropState[b].width * cropState[b].height)[0];
}

stage.addEventListener('mousedown', (e) => {
  if (e.button !== 0 || !snapshotImage) return;
  e.preventDefault();
  const p = pointerToPx(e);
  const handleEl = e.target.closest('.resize-handle');

  if (handleEl) {
    const key = handleEl.closest('.crop-box').dataset.box;
    selectedBox = key;
    drag = { mode: 'resize', key, handle: handleEl.dataset.handle, startP: p, startRect: toPx(cropState[key]) };
  } else {
    const key = hitTest(p);
    if (key) {
      selectedBox = key;
      drag = { mode: 'move', key, startP: p, startRect: toPx(cropState[key]) };
    } else {
      // Draw a fresh rectangle for the selected tool
      drag = { mode: 'draw', key: selectedBox, startP: p, startRect: { x: p.x, y: p.y, w: 0, h: 0 } };
    }
  }
  refreshEditor();
});

window.addEventListener('mousemove', (e) => {
  if (!drag) return;
  const p = pointerToPx(e);
  const dx = p.x - drag.startP.x;
  const dy = p.y - drag.startP.y;
  const s = drag.startRect;
  const lock = aspectOf(drag.key);
  let next;

  if (drag.mode === 'move') {
    next = {
      x: Math.min(imgW - s.w, Math.max(0, s.x + dx)),
      y: Math.min(imgH - s.h, Math.max(0, s.y + dy)),
      w: s.w,
      h: s.h
    };
  } else if (drag.mode === 'resize') {
    next = resizePx(s, drag.handle, dx, dy, lock);
  } else {
    if (Math.abs(dx) < 4 && Math.abs(dy) < 4) return;
    const handle = (dy < 0 ? 'n' : 's') + (dx < 0 ? 'w' : 'e');
    next = resizePx(s, handle, dx, dy, lock);
  }
  cropState[drag.key] = toNorm(next);
  refreshEditor();
});

window.addEventListener('mouseup', () => { drag = null; });

function nudgeSelected(e) {
  e.preventDefault();
  const step = e.shiftKey ? 20 : 2;
  const r = toPx(cropState[selectedBox]);
  if (e.key === 'ArrowLeft') r.x -= step;
  if (e.key === 'ArrowRight') r.x += step;
  if (e.key === 'ArrowUp') r.y -= step;
  if (e.key === 'ArrowDown') r.y += step;
  r.x = Math.min(imgW - r.w, Math.max(0, r.x));
  r.y = Math.min(imgH - r.h, Math.max(0, r.y));
  cropState[selectedBox] = toNorm(r);
  refreshEditor();
}

// ---------- Queue drawer
$('btn-toggle-queue').onclick = () => queueDrawer.classList.toggle('hidden');
$('btn-close-queue').onclick = () => queueDrawer.classList.add('hidden');
$('btn-open-folder').onclick = () => ipcRenderer.invoke('open-folder', 'final');
$('btn-drawer-folder').onclick = () => ipcRenderer.invoke('open-folder', 'final');

async function updateQueueUI(statusArg) {
  const status = statusArg || await ipcRenderer.invoke('get-queue-status');
  const active = status.active;
  const queue = status.queue || [];
  const busy = (active ? 1 : 0) + queue.length;
  queueBadge.textContent = busy;
  $('btn-toggle-queue').classList.toggle('busy', busy > 0);

  $('active-job-card').classList.toggle('hidden', !active);
  if (active) {
    $('active-job-title').textContent = active.title;
    setProgress(active.progress || 0);
    $('btn-cancel-active').onclick = () => ipcRenderer.invoke('cancel-job', active.id);
  }

  queueList.innerHTML = '';
  if (!queue.length && !completedClips.length) {
    queueList.innerHTML = '<div class="empty-queue-msg">Nothing yet. Press <b>J</b> on a YouTube video to start a clip, <b>K</b> to stop.</div>';
    return;
  }
  queue.forEach(job => {
    const card = document.createElement('div');
    card.className = 'job-card';
    card.innerHTML = `<div class="job-title"></div><div class="job-meta"><span>Queued</span><button class="cancel-link">Remove</button></div>`;
    card.querySelector('.job-title').textContent = job.title;
    card.querySelector('.cancel-link').onclick = () => ipcRenderer.invoke('cancel-job', job.id);
    queueList.appendChild(card);
  });
  completedClips.forEach(clip => {
    const card = document.createElement('div');
    card.className = 'clip-item-card';
    card.innerHTML = `
      <div class="clip-info">
        <div class="clip-title-row"></div>
        <div class="clip-sub-row">${clip.error ? 'Failed' : '1080×1920 · ready'}</div>
        <div class="clip-actions-row">
          ${clip.error ? '' : '<button class="clip-act-btn act-play">▶ Play</button><button class="clip-act-btn act-reveal">📂 Reveal</button>'}
        </div>
      </div>`;
    card.querySelector('.clip-title-row').textContent = clip.title;
    if (!clip.error) {
      card.querySelector('.act-play').onclick = () => ipcRenderer.invoke('open-file', clip.outputPath);
      card.querySelector('.act-reveal').onclick = () => ipcRenderer.invoke('show-in-folder', clip.outputPath);
    }
    queueList.appendChild(card);
  });
}

function setProgress(p) {
  $('active-job-progress-pct').textContent = `${p}%`;
  $('active-job-progress-fill').style.width = `${p}%`;
}

ipcRenderer.on('render-job-started', (e, job) => showToast(`Rendering "${job.title.slice(0, 24)}" in background`));
ipcRenderer.on('render-job-progress', (e, d) => {
  setProgress(d.progress);
  const desc = document.querySelector('#active-job-card .job-meta span');
  if (desc) desc.textContent = d.stage || '1080×1920 composite, low priority';
});
ipcRenderer.on('render-job-complete', (e, job) => {
  completedClips.unshift(job);
  updateQueueUI();
  showToast(`Done: "${job.title.slice(0, 24)}"`, 'success');
});
ipcRenderer.on('render-job-error', (e, job) => {
  if (job.status !== 'cancelled') {
    completedClips.unshift(job);
    showToast(`Render failed: ${String(job.error).split('\n')[0]}`, 'error', 7000);
  }
  updateQueueUI();
});
ipcRenderer.on('queue-updated', (e, status) => updateQueueUI(status));
ipcRenderer.on('disk-full', (e, d) => showToast(`⚠ Drive is full — the live buffer can't save (${String(d.dir).slice(0, 3)}). Free up space; it resumes automatically.`, 'error', 10000));

// ---------- Self-test (only when CLIPPER_SELFTEST=1): record 5s of a video and render it
if (process.env.CLIPPER_SELFTEST === '1') {
  const say = (m) => logError('SELFTEST ' + m);
  let stage = 0;
  webview.addEventListener('dom-ready', () => {
    if (stage === 0) {
      stage = 1;
      say('loading video');
      webview.loadURL(process.env.CLIPPER_SELFTEST_URL || 'https://www.youtube.com/watch?v=jNQXAC9IVRw');
    } else if (stage === 1) {
      stage = 2;
      if (Number(process.env.CLIPPER_SELFTEST_CLIPAT)) {
        // live buffer only: clip 60s after CLIPAT ms (tests seamless segment joins)
        const at = Number(process.env.CLIPPER_SELFTEST_CLIPAT);
        liveOn = true; autoOn = false;
        sendToWebview('set-live', true);
        sendToWebview('set-auto-clip', autoPayload(false));
        const js = (c) => webview.executeJavaScript(c).catch(err => say('js err ' + err.message));
        if (process.env.CLIPPER_SELFTEST_MUTE === '1') {
          setTimeout(() => js("(()=>{const v=document.querySelector('video');if(v)v.muted=true;return 'muted'})()").then(r => say(r)), 8000);
        }
        [30000, 60000, at - 1000].forEach(t => setTimeout(() => js('window.__clipperDiag && window.__clipperDiag()').then(r => say('diag ' + r)), t));
        setTimeout(() => { say('live clip 60s'); liveClip(60); }, at);
        // with WAITRENDER the window stays open until the processed clip is rendered (closes on RENDER OK)
        setTimeout(() => window.close(), at + (process.env.CLIPPER_SELFTEST_WAITRENDER === '1' ? 240000 : 8000));
      } else if (process.env.CLIPPER_SELFTEST_TWITCH === '1') {
        // on the Twitch directory: open the first live channel, then inspect it
        const js = (c) => webview.executeJavaScript(c).catch(err => say('js err ' + err.message));
        setTimeout(() => {
          js(`(()=>{const a=[...document.querySelectorAll('a[data-a-target="preview-card-image-link"], a[data-a-target="preview-card-title-link"]')].map(x=>x.href).filter(h=>/twitch\\.tv\\/[^/]+$/.test(h));return a[0]||''})()`).then(url => {
            say('first live channel: ' + url);
            if (!url) { window.close(); return; }
            stage = 3;
            autoOn = true; liveOn = true;
            webview.loadURL(url);
            webview.addEventListener('dom-ready', () => { sendToWebview('set-live', true); sendToWebview('set-auto-clip', true); });
            const blockers = `(()=>{const sels=['[data-a-target="video-ad-label"]','[data-a-target="video-ad-countdown"]','[data-test-selector="ad-banner-default-text"]','.stream-display-ad__wrapper','[data-a-target="player-overlay-mature-accept"]','[data-a-target*="content-classification-gate"]','[data-a-target="player-overlay-play-button"]'];
              const hit=sels.filter(s=>document.querySelector(s));
              const v=document.querySelector('video');
              const btns=[...document.querySelectorAll('button')].map(b=>b.textContent.trim()).filter(t=>/start watching|watch|accept|play/i.test(t)).slice(0,5);
              return JSON.stringify({hit,btns,rs:v&&v.readyState,src:v&&String(v.src).slice(0,30)})})()`;
            const clickGate = `(()=>{const b=document.querySelector('[data-a-target="player-overlay-mature-accept"], [data-a-target*="content-classification-gate"] button, [data-a-target="content-classification-gate-overlay-start-watching-button"]')
              || [...document.querySelectorAll('button')].find(x=>/start watching/i.test(x.textContent));if(b){b.click();return 'clicked: '+b.textContent.trim()}return 'no gate button'})()`;
            setTimeout(() => js(blockers).then(r => say('blockers ' + r)), 12000);
            setTimeout(() => js(clickGate).then(r => say('gate ' + r)), 13000);
            [25000, 45000, 60000].forEach(t => setTimeout(() => js('window.__clipperDiag && window.__clipperDiag()').then(r => say('diag ' + r)), t));
            setTimeout(() => js(blockers).then(r => say('blockers ' + r)), 46000);
            setTimeout(() => { say('live clip 30s'); liveClip(30); }, 61000);
            setTimeout(() => { say('timeout, closing'); window.close(); }, 150000);
          });
        }, 9000);
      } else if (process.env.CLIPPER_SELFTEST_AUTO === '1') {
        const js = (c) => webview.executeJavaScript(c).catch(err => say('js err ' + err.message));
        autoOn = true; liveOn = true;
        sendToWebview('set-live', true);
        sendToWebview('set-auto-clip', autoPayload(true));
        webview.addEventListener('ipc-message', (e) => {
          if (e.channel === 'tolerance-changed') say('TOLERANCE ' + JSON.stringify(e.args[0]));
          if (e.channel === 'auto-state') say('auto-state chat=' + e.args[0].chat);
          if (e.channel === 'auto-clip') say('AUTO-CLIP FIRED ' + JSON.stringify(e.args[0]));
        });
        // Chat rule: 4 of the last 7 share a word (substring for 3+ letters), from 4+ people
        // the user's example: 4 of these 5 are "wtf"-family, mixed with 10 unrelated messages = sample of 15
        const sample = ['hello chat', 'wtf was that', 'nice play', 'thats insane', 'what game is this', 'dude tf', 'so goated',
          'first time here', 'wtf', 'lol', 'where is he', 'bro wtf', 'crazy', 'who is that', 'nah'];
        const feed = (list, prefix) => `(()=>{const a=${JSON.stringify(list)};return a.map((t,i)=>window.__clipperFeedChat('${prefix}'+i,t)).join(',')})()`;
        setTimeout(() => {
          const probes = ['good game', 'GG', 'that was w', 'WWWW', 'what the fuck', 'WTH', 'the fuuuck', 'dude tf'];
          js(`(()=>${JSON.stringify(probes)}.map(t=>t+' -> '+window.__clipperKeys(t)).join(' | '))()`).then(r => say('families: ' + r));
        }, 11000);
        setTimeout(() => { say('feeding sample of 15 (expect trigger "wtf" x4)'); js(feed(sample, 'viewer')); }, 13000);
        setTimeout(() => js('window.__clipperAdjustNow(0)').then(r => say('adjuster after 5 min with 0 clips -> tolerance ' + r)), 16000);
        setTimeout(() => js('window.__clipperAdjustNow(5)').then(r => say('adjuster after 5 min with 5 clips -> tolerance ' + r)), 17000);
        [10000, 25000, 35000].forEach(t => setTimeout(() => js('window.__clipperLoud && window.__clipperLoud()').then(r => say('loudness dB ' + r)), t));
        const clipAt = Number(process.env.CLIPPER_SELFTEST_CLIPAT) || 0;
        if (clipAt) {
          setTimeout(() => { say('live clip 60s'); liveClip(60); }, clipAt);
          setTimeout(() => window.close(), clipAt + 100000);
        } else {
          setTimeout(() => window.close(), 30000);
        }
      } else if (process.env.CLIPPER_SELFTEST_LIVE === '1') {
        // live buffer: ~12s play, 5s pause (must not be recorded), ~12s play, then clip
        liveOn = true;
        sendToWebview('set-live', true);
        const js = (c) => webview.executeJavaScript(c).catch(err => say('js err ' + err.message));
        const diag = () => js("(()=>{const v=document.querySelector('#movie_player video')||document.querySelector('video');const p=document.getElementById('movie_player');return JSON.stringify({has:!!v,paused:v&&v.paused,rs:v&&v.readyState,w:v&&v.videoWidth,ad:p&&p.classList.contains('ad-showing'),t:v&&v.currentTime})})()").then(r => say('diag ' + r));
        const V = "(document.querySelector('#movie_player video')||document.querySelector('video'))";
        [2500, 8500].forEach(t => setTimeout(diag, t));
        setTimeout(() => { say('play'); js(V + '.currentTime=0;' + V + '.play()'); }, 3000);
        setTimeout(() => { say('pause label=' + $('live-text').textContent); js(V + '.pause()'); }, 9000);
        setTimeout(() => { say('resume label=' + $('live-text').textContent); js(V + '.play()'); }, 12000);
        setTimeout(() => { say('live clip, label=' + $('live-text').textContent); liveClip(Number(process.env.CLIPPER_SELFTEST_SECONDS) || 60); }, 19000);
      } else {
        setTimeout(() => { say('start'); sendToWebview('start-recording'); }, 9000);
        setTimeout(() => { say('stop'); sendToWebview('stop-recording'); }, 15000);
      }
    }
  });
  webview.addEventListener('ipc-message', (e) => {
    if (e.channel === 'clipper-error') say('webview error: ' + e.args[0]);
    if (e.channel === 'recording-state-changed') say('recording=' + e.args[0].isRecording);
  });
  const origOpen = openCropStudio;
  openCropStudio = function (clip) {
    origOpen(clip);
    if (!clip.rawPath) return;
    say(`clip saved ${clip.rawPath} ${clip.videoWidth}x${clip.videoHeight} ${clip.duration}s`);
    setTimeout(() => {
      say('editor stage=' + stage + ' stageSize=' + $('canvas-stage').style.width + 'x' + $('canvas-stage').style.height);
      enqueueClip(clip, cropState, currentLayout()); // does NOT touch config.json
      cropModal.classList.add('hidden');
    }, 2500);
  };
  ipcRenderer.on('render-job-complete', (e, j) => { say('RENDER OK ' + j.outputPath); setTimeout(() => window.close(), 500); });
  ipcRenderer.on('render-job-error', (e, j) => { say('RENDER FAIL ' + j.error); setTimeout(() => window.close(), 500); });
}
