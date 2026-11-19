// Runs inside the YouTube <webview> as its preload (set from main.js via will-attach-webview).
// Loaded exactly once per page — it must never be re-injected with executeJavaScript.
const { ipcRenderer } = require('electron');

(function () {
  if (window.__clipperLoaded) return;
  window.__clipperLoaded = true;

  let mediaRecorder = null;
  let recordedChunks = [];
  let isRecording = false;
  let isStarting = false;
  let recordingStartTime = 0;
  let recordTimerInterval = null;
  let startSnapshot = null;
  let captureVideo = null;

  let inPoint = null;
  let outPoint = null;
  let rangeWatcher = null;
  let hotkeysEnabled = true;

  const toHost = (channel, data) => {
    try { ipcRenderer.sendToHost(channel, data); } catch (e) {}
  };
  const reportError = (where, err) => {
    const msg = `${where}: ${err && err.message ? err.message : err}`;
    console.error('[Clipper]', msg);
    toHost('clipper-error', msg);
  };

  // ---------------------------------------------------------
  // SITE ADAPTERS: everything that differs between YouTube and Twitch lives here.
  // Recording, live buffer, auto-clip, layouts, rendering and captions are shared.
  // ---------------------------------------------------------
  // Visible text of a chat message, with emote/emoji images replaced by their names (alt text)
  function textWithEmotes(root) {
    const parts = [];
    const walk = (node) => {
      for (const n of node.childNodes) {
        if (n.nodeType === 3) parts.push(n.textContent);
        else if (n.nodeType === 1) {
          if (n.tagName === 'IMG') parts.push(` ${n.getAttribute('shared-tooltip-text') || n.alt || ''} `);
          else walk(n);
        }
      }
    };
    walk(root);
    return parts.join(' ');
  }

  const YOUTUBE = {
    name: 'YouTube',
    player: () => document.getElementById('movie_player') || document.querySelector('.html5-video-player'),
    video() {
      const p = this.player();
      return (p && p.querySelector('video')) || document.querySelector('video.html5-main-video') || document.querySelector('video');
    },
    isAd() { const p = this.player(); return !!(p && p.classList.contains('ad-showing')); },
    videoId() {
      try {
        const p = this.player();
        const d = p && p.getVideoData && p.getVideoData();
        if (d && d.video_id) return d.video_id;
      } catch (e) {}
      try {
        const u = new URL(location.href);
        if (u.searchParams.get('v')) return u.searchParams.get('v');
        const m = u.pathname.match(/\/(shorts|live|embed)\/([\w-]{6,})/);
        if (m) return m[2];
      } catch (e) {}
      return null;
    },
    title: () => document.title.replace(/^\(\d+\)\s*/, '').replace(/\s*-\s*YouTube\s*$/, '').trim() || 'YouTube Clip',
    duration() {
      const v = this.video();
      if (v && isFinite(v.duration) && v.duration > 0) return v.duration;
      const p = this.player();
      try { const d = p && p.getDuration && p.getDuration(); if (d > 0) return d; } catch (e) {}
      return 0;
    },
    seek(t) {
      const p = this.player();
      try { if (p && p.seekTo) { p.seekTo(t, true); return; } } catch (e) {}
      const v = this.video();
      if (v) v.currentTime = t;
    },
    progressBar() { const p = this.player(); return p && p.querySelector('.ytp-progress-bar'); },
    chatItems() {
      let doc = null;
      try { const f = document.querySelector('#chatframe'); doc = f && f.contentDocument; } catch (e) {}
      return doc && (doc.querySelector('yt-live-chat-item-list-renderer #items') || doc.querySelector('#items'));
    },
    messageEl: (n) => (n.tagName === 'YT-LIVE-CHAT-TEXT-MESSAGE-RENDERER' ? n : null),
    readChat(el) {
      const msg = el.querySelector('#message');
      if (!msg) return null;
      return { author: ((el.querySelector('#author-name') || {}).textContent || '').trim(), text: textWithEmotes(msg) };
    },
    typingSelector: '#search-form, #comments, yt-live-chat-app'
  };

  const TWITCH_RESERVED = new Set(['directory', 'settings', 'search', 'downloads', 'jobs', 'p', 'subscriptions', 'inventory',
    'wallet', 'drops', 'friends', 'messages', 'turbo', 'prime', 'store', 'videos', 'moderator', 'u', 'login', 'signup']);

  const TWITCH = {
    name: 'Twitch',
    player: () => document.querySelector('[data-a-target="video-player"]') || document.querySelector('.video-player__container') || document.querySelector('.video-player'),
    video() {
      const p = this.player();
      return (p && p.querySelector('video')) || document.querySelector('video');
    },
    isAd() {
      // explicit ad markers only (Twitch keeps empty ad containers on the page at all times)
      if (document.querySelector('[data-a-target="video-ad-label"], [data-a-target="video-ad-countdown"], [data-test-selector="ad-banner-default-text"]')) return true;
      const p = this.player();
      if (!p) return false;
      for (const el of p.querySelectorAll('span, p')) {
        if (el.children.length) continue;
        const t = el.textContent.trim();
        if (t && t.length < 40 && /^(ad|ads)(\s+\d+\s+of\s+\d+)?$|^ad\s*[(·•]|commercial break/i.test(t)) return true;
      }
      return false;
    },
    videoId() {
      const parts = location.pathname.split('/').filter(Boolean);
      if (location.hostname.startsWith('clips.')) return parts[0] ? `twitch_clip_${parts[0]}` : null;
      if (parts[0] === 'videos' && parts[1]) return `twitch_v_${parts[1]}`;
      if (parts[1] === 'clip' && parts[2]) return `twitch_${parts[0].toLowerCase()}`; // clips use the channel's layout
      if (parts[0] && !TWITCH_RESERVED.has(parts[0].toLowerCase())) return `twitch_${parts[0].toLowerCase()}`; // live: per channel
      return null;
    },
    title() {
      const channel = (document.querySelector('[data-a-target="stream-info-card-component--channel-name"] h1, h1.tw-title, .channel-info-content h1') || {}).textContent
        || location.pathname.split('/').filter(Boolean)[0] || 'Twitch';
      const stream = (document.querySelector('[data-a-target="stream-title"]') || {}).textContent || '';
      return `${channel.trim()}${stream ? ' - ' + stream.trim() : ''}`.slice(0, 120) || 'Twitch Clip';
    },
    duration() {
      const v = this.video();
      return v && isFinite(v.duration) && v.duration > 0 ? v.duration : 0; // live streams: 0
    },
    seek(t) { const v = this.video(); if (v) v.currentTime = t; },
    progressBar: () => document.querySelector('[data-a-target="player-seekbar"]'),
    chatItems: () =>
      document.querySelector('[data-test-selector="chat-scrollable-area__message-container"]') ||
      document.querySelector('.chat-scrollable-area__message-container') ||
      document.querySelector('[data-test-selector="video-chat-message-list-wrapper"] ul') ||
      document.querySelector('.video-chat__message-list-wrapper ul'),
    messageEl(n) {
      if (!n.querySelector && !n.matches) return null;
      const sel = '.chat-line__message, [data-a-target="chat-line-message"], .vod-message';
      return (n.matches && n.matches(sel)) ? n : (n.querySelector && n.querySelector(sel));
    },
    readChat(el) {
      const authorEl = el.querySelector('.chat-author__display-name, [data-a-target="chat-message-username"], .video-chat__message-author');
      const body = el.querySelector('[data-a-target="chat-line-message-body"]') ||
        el.querySelector('.message, .video-chat__message > span:last-child');
      let text;
      if (body) text = textWithEmotes(body);
      else {
        // fallback: everything after the "username:" separator
        const full = textWithEmotes(el);
        const name = authorEl ? authorEl.textContent : '';
        text = name && full.includes(name) ? full.slice(full.indexOf(name) + name.length).replace(/^\s*:\s*/, '') : full;
      }
      return { author: ((authorEl || {}).textContent || '').trim(), text };
    },
    typingSelector: '[data-a-target="chat-input"], .chat-input, .chat-wysiwyg-input__editor, [data-a-target="tw-input"]'
  };

  const SITE = /(^|\.)twitch\.tv$/.test(location.hostname) ? TWITCH : YOUTUBE;

  const getPlayer = () => SITE.player();
  const getVideo = () => SITE.video();
  function getCurrentTime() {
    const v = getVideo();
    if (v && !isNaN(v.currentTime)) return v.currentTime;
    return 0;
  }
  const getDuration = () => SITE.duration();
  const seekTo = (t) => SITE.seek(t);
  function formatTime(s) {
    if (s === null || isNaN(s)) return '--:--';
    const m = Math.floor(s / 60);
    const ss = Math.floor(s % 60);
    return `${String(m).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
  }
  const waitFor = (target, event, ms) => new Promise(resolve => {
    let done = false;
    const finish = (ok) => { if (done) return; done = true; target.removeEventListener(event, on); clearTimeout(t); resolve(ok); };
    const on = () => finish(true);
    const t = setTimeout(() => finish(false), ms);
    target.addEventListener(event, on, { once: true });
  });

  // YouTube enforces Trusted Types: ANY innerHTML assignment throws.
  // Always build DOM with this helper instead.
  function h(tag, props, children) {
    const node = document.createElement(tag);
    if (props) {
      for (const [k, v] of Object.entries(props)) {
        if (k === 'text') node.textContent = v;
        else if (k === 'dataset') Object.assign(node.dataset, v);
        else node.setAttribute(k, v);
      }
    }
    (children || []).forEach(c => node.appendChild(c));
    return node;
  }

  function grabFrame(video, quality = 0.92) {
    try {
      if (!video || !video.videoWidth) return null;
      const c = document.createElement('canvas');
      c.width = video.videoWidth;
      c.height = video.videoHeight;
      c.getContext('2d').drawImage(video, 0, 0, c.width, c.height);
      return c.toDataURL('image/jpeg', quality);
    } catch (e) {
      return null;
    }
  }

  // ---------------------------------------------------------
  // TOAST + REC BADGE
  // ---------------------------------------------------------
  function showToast(msg, duration = 2800) {
    let toast = document.getElementById('clipper-yt-toast');
    const container = getPlayer() || document.body;
    if (!toast || toast.parentElement !== container) {
      if (toast) toast.remove();
      toast = document.createElement('div');
      toast.id = 'clipper-yt-toast';
      container.appendChild(toast);
    }
    toast.textContent = msg;
    toast.classList.remove('clipper-hidden');
    clearTimeout(toast._t);
    toast._t = setTimeout(() => toast.classList.add('clipper-hidden'), duration);
  }

  function setBadge(visible) {
    let badge = document.getElementById('clipper-rec-badge');
    const container = getPlayer() || document.body;
    if (!badge || badge.parentElement !== container) {
      if (badge) badge.remove();
      badge = h('div', { id: 'clipper-rec-badge' }, [
        h('span', { class: 'clipper-dot' }),
        h('span', { class: 'clipper-rec-text', text: 'REC' }),
        h('span', { id: 'clipper-timer', text: '00:00' }),
        h('span', { class: 'clipper-hint', text: '[K to stop]' })
      ]);
      container.appendChild(badge);
    }
    badge.classList.toggle('clipper-hidden', !visible);
  }

  // ---------------------------------------------------------
  // TIMELINE MARKERS (on YouTube's own progress bar) + quick bar
  // ---------------------------------------------------------
  function ensureTimelineUi() {
    const player = getPlayer();
    if (!player) return;

    // Markers on the site's own progress bar (YouTube always, Twitch on VODs)
    const bar = SITE.progressBar();
    if (bar && !bar.querySelector('#clipper-marks')) {
      const marks = h('div', { id: 'clipper-marks' }, [
        h('div', { id: 'clipper-range' }),
        h('div', { id: 'clipper-mark-a', class: 'clipper-mark' }, [h('span', { text: 'A' })]),
        h('div', { id: 'clipper-mark-b', class: 'clipper-mark' }, [h('span', { text: 'B' })])
      ]);
      bar.appendChild(marks);
    }

    // Compact control bar above the YT controls
    if (!document.getElementById('clipper-quick-bar')) {
      const qb = h('div', { id: 'clipper-quick-bar' }, [
        h('button', { type: 'button', dataset: { act: 'in' }, text: 'A: In [I]' }),
        h('span', { id: 'clipper-readout', text: 'A --:-- · B --:--' }),
        h('button', { type: 'button', dataset: { act: 'out' }, text: 'B: Out [O]' }),
        h('button', { type: 'button', dataset: { act: 'clip' }, class: 'primary', text: 'Clip A→B' }),
        h('button', { type: 'button', dataset: { act: 'grab-60' }, class: 'primary', style: 'background:#059669; border-color:#10b981;', text: '⚡ Fetch 60s [G]' }),
        h('button', { type: 'button', dataset: { act: 'clear' }, class: 'ghost', text: '✕' })
      ]);
      qb.addEventListener('click', (e) => {
        const act = e.target && e.target.dataset && e.target.dataset.act;
        if (!act) return;
        e.stopPropagation();
        e.preventDefault();
        if (act === 'in') setPointA();
        else if (act === 'out') setPointB();
        else if (act === 'clip') recordRangeAB();
        else if (act === 'grab-60') grabLast60Seconds();
        else if (act === 'clear') clearPoints();
      });
      qb.addEventListener('mousedown', e => e.stopPropagation());
      player.appendChild(qb);
    }
    updateTimelineVisuals();
  }

  function updateTimelineVisuals() {
    const readout = document.getElementById('clipper-readout');
    if (readout) readout.textContent = `A ${formatTime(inPoint)} · B ${formatTime(outPoint)}`;
    const d = getDuration();
    const a = document.getElementById('clipper-mark-a');
    const b = document.getElementById('clipper-mark-b');
    const r = document.getElementById('clipper-range');
    if (!a || !b || !r) return;
    const pct = (t) => `${Math.min(100, Math.max(0, (t / d) * 100))}%`;
    a.style.display = d && inPoint !== null ? 'block' : 'none';
    b.style.display = d && outPoint !== null ? 'block' : 'none';
    if (d && inPoint !== null) a.style.left = pct(inPoint);
    if (d && outPoint !== null) b.style.left = pct(outPoint);
    if (d && inPoint !== null && outPoint !== null && outPoint > inPoint) {
      r.style.display = 'block';
      r.style.left = pct(inPoint);
      r.style.width = `${((outPoint - inPoint) / d) * 100}%`;
    } else {
      r.style.display = 'none';
    }
  }

  function notifyPoints() {
    updateTimelineVisuals();
    toHost('points-updated', { inPoint, outPoint });
  }
  function setPointA() {
    inPoint = getCurrentTime();
    if (outPoint !== null && outPoint <= inPoint) outPoint = null;
    showToast(`A set at ${formatTime(inPoint)}`);
    notifyPoints();
  }
  function setPointB() {
    outPoint = getCurrentTime();
    if (inPoint !== null && outPoint <= inPoint) inPoint = null;
    showToast(`B set at ${formatTime(outPoint)}`);
    notifyPoints();
  }
  function clearPoints() {
    inPoint = null;
    outPoint = null;
    showToast('Points cleared');
    notifyPoints();
  }

  // ---------------------------------------------------------
  // RECORDING
  // ---------------------------------------------------------
  async function startRecording() {
    if (isRecording || isStarting) return false;
    const video = getVideo();
    if (!video) {
      showToast('No video on this page');
      toHost('clipper-error', `No video on this page — open a ${SITE.name} video or stream first.`);
      return false;
    }
    isStarting = true;
    try {
      if (typeof video.captureStream !== 'function') throw new Error('captureStream not supported');

      // Make sure frames are actually flowing before we capture
      if (video.readyState < 2) await waitFor(video, 'loadeddata', 4000);
      if (video.paused) {
        try { await video.play(); } catch (e) {}
        await waitFor(video, 'playing', 2000);
      }

      const src = video.captureStream();
      let vTracks = src.getVideoTracks().filter(t => t.readyState === 'live');
      if (!vTracks.length) {
        await new Promise(r => setTimeout(r, 300));
        vTracks = src.getVideoTracks().filter(t => t.readyState === 'live');
      }
      if (!vTracks.length) throw new Error('Video has no frames yet — let it play for a second and try again');
      const aTracks = src.getAudioTracks().filter(t => t.readyState === 'live');
      const stream = new MediaStream([...vTracks, ...aTracks]);

      // H.264 first: hardware (GPU) encoded, so 1080p60 doesn't drop frames.
      // VP9/VP8 are CPU-only in Chromium and fell to ~30fps at 1080p.
      const candidates = (aTracks.length
        ? ['video/webm;codecs=h264,opus', 'video/x-matroska;codecs=avc1,opus', 'video/mp4;codecs=avc1,mp4a.40.2', 'video/webm;codecs=vp8,opus', 'video/webm;codecs=vp9,opus', 'video/webm']
        : ['video/webm;codecs=h264', 'video/x-matroska;codecs=avc1', 'video/mp4;codecs=avc1', 'video/webm;codecs=vp8', 'video/webm;codecs=vp9', 'video/webm'])
        .filter(m => !badEncoders.has(encoderOf(m)));

      let rec = null;
      let lastErr = null;
      for (const mimeType of candidates) {
        if (!MediaRecorder.isTypeSupported(mimeType)) continue;
        try {
          rec = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 30000000 });
          toHost('clipper-info', `recorder: ${mimeType}`);
          rec.start(1000);
          break;
        } catch (e) {
          lastErr = e;
          rec = null;
        }
      }
      if (!rec) {
        try {
          rec = new MediaRecorder(stream);
          rec.start(1000);
        } catch (e) {
          throw lastErr || e;
        }
      }

      mediaRecorder = rec;
      captureVideo = video;
      recordedChunks = [];
      startSnapshot = grabFrame(video);
      rec.ondataavailable = (e) => { if (e.data && e.data.size) recordedChunks.push(e.data); };
      rec.onerror = (e) => {
        reportError('Recorder', (e && e.error) || 'stream interrupted');
        try { if (rec.state !== 'inactive') rec.stop(); } catch (_) {}
      };
      rec.onstop = () => { if (!rec.__restarting) finishRecording(rec); };
      // Source swapped mid-recording: the old tracks go silent, so restart on a fresh capture
      src.addEventListener('removetrack', () => { if (mediaRecorder === rec) restartRecording(rec, 'source swapped'); });
      // Watchdog: nothing recorded after 3.5s of playback -> fresh capture; repeated -> backup encoder
      setTimeout(() => {
        if (mediaRecorder !== rec || rec.state === 'inactive') return;
        const size = recordedChunks.reduce((a, b) => a + b.size, 0);
        if (size < 4096 && !video.paused) {
          recEmptyStreak++;
          if (recEmptyStreak >= 2) markEncoderBad(rec.mimeType, 'Recording');
          if (recEmptyStreak > 3) { reportError('Recording', 'this stream produced no capturable video'); stopRecording(); return; }
          restartRecording(rec, 'capture was silent');
        } else {
          recEmptyStreak = 0;
        }
      }, 3500);
      // If the site swaps the stream (ad, quality change), stop and keep what we have
      vTracks.forEach(t => t.addEventListener('ended', () => stopRecording()));

      isRecording = true;
      recordingStartTime = Date.now();
      setBadge(true);
      const timer = () => document.getElementById('clipper-timer');
      clearInterval(recordTimerInterval);
      recordTimerInterval = setInterval(() => {
        const el = timer();
        if (el) el.textContent = formatTime((Date.now() - recordingStartTime) / 1000);
      }, 250);

      toHost('recording-state-changed', { isRecording: true });
      showToast(`Recording ${video.videoWidth}×${video.videoHeight} — press K to stop`);
      return true;
    } catch (err) {
      reportError('Could not start recording', err);
      showToast('Recording error: ' + (err.message || err));
      return false;
    } finally {
      isStarting = false;
    }
  }

  let recEmptyStreak = 0;
  // Restart J/K recording on a fresh capture. If real footage was already recorded, save it instead.
  function restartRecording(rec, why) {
    if (mediaRecorder !== rec || rec.state === 'inactive') return;
    const size = recordedChunks.reduce((a, b) => a + b.size, 0);
    if (size > 65536) {
      showToast(`Stream changed (${why}) — saved what was recorded`);
      stopRecording();
      return;
    }
    toHost('clipper-info', `Recording: ${why} — re-capturing`);
    rec.__restarting = true;
    try { rec.stop(); } catch (e) {}
    clearInterval(recordTimerInterval);
    isRecording = false;
    mediaRecorder = null;
    recordedChunks = [];
    startRecording();
  }

  function stopRecording() {
    if (!isRecording || !mediaRecorder) return;
    if (rangeWatcher) { clearInterval(rangeWatcher); rangeWatcher = null; }
    try {
      if (mediaRecorder.state !== 'inactive') mediaRecorder.stop();
    } catch (e) {
      reportError('Stop', e);
    }
  }

  async function finishRecording(rec) {
    clearInterval(recordTimerInterval);
    recordTimerInterval = null;
    const duration = (Date.now() - recordingStartTime) / 1000;
    isRecording = false;
    mediaRecorder = null;
    setBadge(false);
    toHost('recording-state-changed', { isRecording: false });

    if (!recordedChunks.length) {
      showToast('Nothing was recorded');
      toHost('clipper-error', 'Recording produced no data.');
      return;
    }
    showToast('Saving clip...');

    try {
      const blob = new Blob(recordedChunks, { type: rec.mimeType || 'video/webm' });
      recordedChunks = [];
      const bytes = new Uint8Array(await blob.arrayBuffer());
      const video = captureVideo || getVideo();
      const snap = startSnapshot || grabFrame(video);
      toHost('clip-captured', {
        buffer: bytes, // typed array: fast structured clone, no giant JS array
        videoId: getVideoId(),
        title: getTitle(),
        videoWidth: (video && video.videoWidth) || 1920,
        videoHeight: (video && video.videoHeight) || 1080,
        snapshotDataUrl: snap,
        duration
      });
    } catch (e) {
      reportError('Saving clip', e);
    }
  }

  // ---------------------------------------------------------
  // REPLAY A -> B AND RECORD
  // ---------------------------------------------------------
  async function recordRangeAB() {
    const video = getVideo();
    if (!video) return showToast('No video on this page');
    if (inPoint === null || outPoint === null) return showToast('Set A [I] and B [O] first');
    if (outPoint <= inPoint) return showToast('B must be after A');
    if (isRecording) return showToast('Already recording');
    if (!getDuration()) return showToast('A→B replay needs a video you can seek (VOD) — use the live buffer for live streams');

    showToast(`Replaying ${formatTime(inPoint)} → ${formatTime(outPoint)}`);
    video.pause();
    seekTo(inPoint);
    await waitFor(video, 'seeked', 4000);
    try { await video.play(); } catch (e) {}
    await waitFor(video, 'playing', 3000);

    const ok = await startRecording();
    if (!ok) return;

    const target = outPoint;
    const guardEnd = Date.now() + (target - inPoint + 15) * 1000;
    rangeWatcher = setInterval(() => {
      if (!isRecording) { clearInterval(rangeWatcher); rangeWatcher = null; return; }
      if (getCurrentTime() >= target || video.ended || Date.now() > guardEnd) {
        clearInterval(rangeWatcher);
        rangeWatcher = null;
        stopRecording();
        video.pause();
        showToast('A→B clip done');
      }
    }, 50);
  }

  // ---------------------------------------------------------
  // VIDEO IDENTITY (YouTube: video ID · Twitch: channel, or VOD id)
  // ---------------------------------------------------------
  const getVideoId = () => SITE.videoId();
  const getTitle = () => SITE.title();

  // Encoders that produced no data on this page (e.g. GPU H.264 rejecting an unusual stream
  // resolution). Once an encoder fails, every recorder here skips to the next one.
  const badEncoders = new Set();
  const encoderOf = (mime) => (/h264|avc1/i.test(mime) ? 'h264' : /vp9/i.test(mime) ? 'vp9' : /vp8/i.test(mime) ? 'vp8' : 'default');

  function pickMime(hasAudio) {
    const list = hasAudio
      ? ['video/webm;codecs=h264,opus', 'video/x-matroska;codecs=avc1,opus', 'video/webm;codecs=vp8,opus', 'video/webm;codecs=vp9,opus', 'video/webm']
      : ['video/webm;codecs=h264', 'video/x-matroska;codecs=avc1', 'video/webm;codecs=vp8', 'video/webm;codecs=vp9', 'video/webm'];
    return list.find(m => MediaRecorder.isTypeSupported(m) && !badEncoders.has(encoderOf(m))) || '';
  }

  function markEncoderBad(mime, where) {
    const enc = encoderOf(mime || '');
    if (enc === 'default' || badEncoders.has(enc)) return false;
    badEncoders.add(enc);
    const v = getVideo();
    toHost('clipper-info', `${where}: ${enc} encoder produced no data at ${v ? v.videoWidth + 'x' + v.videoHeight : '?'} — switching to ${pickMime(true) || 'default'}`);
    return true;
  }

  // ---------------------------------------------------------
  // LIVE REPLAY BUFFER (always keeps the last ~60s of what played)
  //  - one hardware H.264 recorder at a time, rotated every 10s of *played* time
  //  - each finished segment is handed to the main process and written to disk,
  //    so memory stays at ~one segment; old segments are deleted on disk
  //  - recorder pauses while the video is paused / buffering / seeking / showing an ad
  // ---------------------------------------------------------
  const LIVE_SEG_SEC = 10;
  const LIVE_KEEP_SEC = 60;
  const LIVE_BITRATE = 16000000;
  let liveWanted = false;
  let live = null;
  let liveCarry = null;   // lets a restart (ad, source swap) continue the same buffer
  let liveStoredSec = 0;
  let liveBusy = false;

  const isAd = () => SITE.isAd();
  function shouldRun(video) {
    return !!video && !video.paused && !video.ended && !video.seeking && video.readyState >= 3 && !isAd();
  }

  function liveStart() {
    if (live) return true;
    const video = getVideo();
    if (!video || !video.videoWidth || isAd() || video.paused) return false;
    let src;
    try { src = video.captureStream(); } catch (e) { return false; }
    const v = src.getVideoTracks().filter(t => t.readyState === 'live');
    if (!v.length) return false;
    const a = src.getAudioTracks().filter(t => t.readyState === 'live');
    const videoId = getVideoId();
    const carry = liveCarry && liveCarry.videoId === videoId ? liveCarry : null;
    if (liveCarry && !carry) ipcRenderer.invoke('live-reset', liveCarry.sessionId).catch(() => {});
    liveCarry = null;

    live = {
      sessionId: carry ? carry.sessionId : `${videoId || 'page'}_${Date.now()}`,
      segIdx: carry ? carry.segIdx : 0,
      flushes: carry ? carry.flushes : new Set(),
      videoId,
      video,
      stream: new MediaStream([...v, ...a]),
      mime: pickMime(a.length > 0),
      seg: null,
      freshCapture: true
    };
    if (!carry) liveStoredSec = 0;
    v.forEach(t => t.addEventListener('ended', () => liveRestart()));
    // Twitch/YouTube swap the media source (ad end, quality change): Chromium replaces the captured
    // tracks and the old ones go silent without "ending". Re-capture whenever that happens.
    const mine = new Set([...v, ...a]);
    src.addEventListener('removetrack', (e) => {
      if (e.track && mine.has(e.track) && live && live.stream === liveStream) {
        toHost('clipper-info', `Live buffer: ${e.track.kind} source swapped — re-capturing`);
        liveRestart();
      }
    });
    const liveStream = live.stream;
    // the page replaced the video's source (ad ended, quality switch): captured tracks will go stale
    const onSourceChange = () => { if (live && live.video === video && live.stream === liveStream) liveRestart(); };
    video.addEventListener('emptied', onSourceChange, { once: true });
    video.addEventListener('loadstart', onSourceChange, { once: true });
    try {
      newSegment();
    } catch (e) {
      reportError('Live buffer', e);
      live = null;
      return false;
    }
    return true;
  }

  function segActiveMs(seg) {
    return seg.activeMs + (seg.resumeAt ? Date.now() - seg.resumeAt : 0);
  }

  function newSegment() {
    const opts = { videoBitsPerSecond: LIVE_BITRATE };
    if (live.mime) opts.mimeType = live.mime;
    const rec = new MediaRecorder(live.stream, opts);
    // First segment after a (re)capture is short (3s): if the capture is stale it comes back
    // empty quickly and we re-capture, without poking the recorder mid-segment.
    const targetMs = live.freshCapture ? 3000 : LIVE_SEG_SEC * 1000;
    live.freshCapture = false;
    const seg = { rec, chunks: [], idx: live.segIdx++, activeMs: 0, resumeAt: null, sessionId: live.sessionId, flushes: live.flushes, targetMs };
    rec.ondataavailable = (e) => { if (e.data && e.data.size) seg.chunks.push(e.data); };
    rec.onerror = () => liveRestart();
    seg.done = new Promise(res => { rec.onstop = res; });
    rec.start(); // no timeslice: one blob per segment = least overhead
    if (shouldRun(live.video)) seg.resumeAt = Date.now();
    else rec.pause();
    live.seg = seg;
  }

  function closeSegment(seg, delayMs = 0) {
    // the segment's length is fixed at the join point; anything recorded after it is trimmed later
    if (seg.resumeAt) { seg.activeMs += Date.now() - seg.resumeAt; seg.resumeAt = null; }
    const stop = () => { try { if (seg.rec.state !== 'inactive') seg.rec.stop(); } catch (e) {} };
    if (delayMs > 0) {
      setTimeout(stop, delayMs);
    } else {
      stop();
    }
    const p = (async () => {
      // never wait forever on a recorder that doesn't report "stopped" (stale/dead tracks)
      await Promise.race([seg.done, new Promise(r => setTimeout(r, delayMs + 3000))]);
      if (seg.activeMs < 300 || !seg.chunks.length) return;
      const bytes = new Uint8Array(await new Blob(seg.chunks, { type: seg.rec.mimeType }).arrayBuffer());
      seg.chunks = [];
      if (bytes.length < 4096 && seg.activeMs > 2000) liveEmpty(seg);
      else if (bytes.length >= 4096) liveEmptyStreak = 0;
      const v = getVideo();
      const r = await ipcRenderer.invoke('live-segment', {
        sessionId: seg.sessionId, idx: seg.idx, duration: seg.activeMs / 1000, bytes, keepSec: LIVE_KEEP_SEC,
        info: `${seg.rec.mimeType} ${v ? v.videoWidth + 'x' + v.videoHeight : ''}`
      });
      if (r && typeof r.bufferedSec === 'number' && live && live.sessionId === seg.sessionId) liveStoredSec = r.bufferedSec;
    })().catch(e => reportError('Live segment', e));
    seg.flushes.add(p);
    p.finally(() => seg.flushes.delete(p));
    return p;
  }

  // Seamless joins: start the next segment first, keep the old one recording 0.5s longer so its
  // encoder flushes its last frames (stopping instantly dropped ~0.3s of video at every join),
  // then the extra overlap is trimmed exactly at the join point when clips are stitched.
  const JOIN_OVERLAP_MS = 1000;
  function rotate() {
    const old = live.seg;
    newSegment();
    return closeSegment(old, JOIN_OVERLAP_MS);
  }

  // A segment that recorded nothing: the captured tracks have gone stale. Re-capture first;
  // only if fresh captures keep coming out empty is the encoder itself blamed.
  let liveEmptyStreak = 0;
  function liveEmpty(seg) {
    if (seg.emptyHandled) return;
    seg.emptyHandled = true;
    liveEmptyStreak++;
    if (liveEmptyStreak >= 3) {
      markEncoderBad(seg.rec.mimeType, 'Live buffer');
      liveEmptyStreak = 1;
    } else {
      toHost('clipper-info', 'Live buffer: capture went silent (source swapped) — re-capturing');
    }
    if (live) liveRestart(); // next tick re-captures fresh tracks, same buffer/session
  }

  // (A silence-based stale check used to live here. Quiet/muted audio and the few seconds a fresh
  //  capture's audio takes to start made it restart every ~8s, causing skips. Removed: stale
  //  captures are caught by the short first segment + source-change events instead.)

  function liveSync() {
    if (!live || !live.seg) return;
    const seg = live.seg;
    const run = shouldRun(live.video);
    try {
      if (run && seg.rec.state === 'paused') { seg.rec.resume(); seg.resumeAt = Date.now(); }
      else if (!run && seg.rec.state === 'recording') { seg.rec.pause(); seg.activeMs += Date.now() - seg.resumeAt; seg.resumeAt = null; }
    } catch (e) {}
    if (segActiveMs(seg) >= seg.targetMs) rotate();
  }

  // Source changed (ad, new video...). Keep the buffer if it's still the same video.
  let liveRestarts = 0;
  function liveRestart() {
    if (!live) return;
    liveRestarts++;
    const prev = live;
    if (prev.tap) { try { prev.tap.ctx.close(); } catch (e) {} }
    live = null;
    closeSegment(prev.seg);
    liveCarry = { videoId: prev.videoId, sessionId: prev.sessionId, segIdx: prev.segIdx, flushes: prev.flushes };
  }

  function liveStop() {
    if (live && live.tap) { try { live.tap.ctx.close(); } catch (e) {} }
    if (live) {
      try { live.seg.rec.ondataavailable = null; if (live.seg.rec.state !== 'inactive') live.seg.rec.stop(); } catch (e) {}
      ipcRenderer.invoke('live-reset', live.sessionId).catch(() => {});
      live = null;
    }
    if (liveCarry) { ipcRenderer.invoke('live-reset', liveCarry.sessionId).catch(() => {}); liveCarry = null; }
    liveStoredSec = 0;
  }

  function liveBufferedSec() {
    if (!live) return Math.min(LIVE_KEEP_SEC, liveStoredSec);
    return Math.min(LIVE_KEEP_SEC, liveStoredSec + segActiveMs(live.seg) / 1000);
  }

  // Returns true only when a clip was actually saved.
  let liveBusySince = 0;
  async function liveClip(seconds) {
    seconds = seconds === 30 ? 30 : LIVE_KEEP_SEC;
    if (liveBusy && Date.now() - liveBusySince < 15000) { reportError('Live clip', 'previous clip still being saved — skipped'); return false; }
    if (!liveWanted) { reportError('Live clip', 'live buffer is off — turn on "Live" first'); return false; }
    if (!live && !liveCarry) { reportError('Live clip', 'nothing buffered yet — play the video'); return false; }
    liveBusy = true;
    liveBusySince = Date.now();
    try {
      const sessionId = live ? live.sessionId : liveCarry.sessionId;
      const flushes = live ? live.flushes : liveCarry.flushes;
      const video = (live && live.video) || getVideo();
      const snap = grabFrame(video);
      const meta = {
        title: getTitle(),
        videoId: (live && live.videoId) || getVideoId(),
        videoWidth: (video && video.videoWidth) || 1920,
        videoHeight: (video && video.videoHeight) || 1080
      };
      if (live) rotate(); // flush what's in the current segment right now
      // wait for pending segment saves, but never longer than 6s
      await Promise.race([Promise.all([...flushes]), new Promise(r => setTimeout(r, 6000))]);
      showToast(`Clipped last ${seconds}s`);
      const res = await ipcRenderer.invoke('live-clip', { sessionId, seconds, snapshotDataUrl: snap, ...meta });
      if (res && res.success) { toHost('clip-saved', res); return true; }
      reportError('Live clip', (res && res.error) || 'failed');
      return false;
    } catch (e) {
      reportError('Live clip', e);
      return false;
    } finally {
      liveBusy = false;
    }
  }

  function grabStreamSlice(seconds = 60) {
    const sec = Number(seconds) === 30 ? 30 : 60;
    const video = getVideo();
    if (!video) {
      showToast('⚠️ No video player active');
      return false;
    }

    const curTime = (video && !isNaN(video.currentTime)) ? video.currentTime : 0;
    const startTime = Math.max(0, curTime - sec);
    const endTime = curTime;
    const snap = grabFrame(video, 0.95);
    const title = getTitle();

    showToast(`⚡ Fetching last ${sec}s directly from stream server (0% lag)...`);
    toHost('grab-stream-clip', {
      pageUrl: location.href,
      startTime,
      endTime,
      duration: sec,
      title,
      snapshotDataUrl: snap,
      videoId: getVideoId(),
      videoWidth: video.videoWidth || 1920,
      videoHeight: video.videoHeight || 1080
    });
    return true;
  }
  function grabLast60Seconds() {
    return grabStreamSlice(60);
  }

  function liveTick() {
    if (!liveWanted) return;
    if (live) {
      if (live.video !== getVideo() || (getVideoId() && live.videoId !== getVideoId())) liveRestart();
      else liveSync();
    }
    if (!live) liveStart();
  }
  setInterval(liveTick, 500);

  // ---------------------------------------------------------
  // LAG MONITOR (diagnostics only): every 10s, if the player dropped frames or stalled,
  // write one line to clipper.log. "dropped" = this PC couldn't draw frames in time;
  // "buffering" = the stream data arrived late (network / Twitch side).
  // ---------------------------------------------------------
  const lagMon = { video: null, dropped: 0, total: 0, stallMs: 0, stallAt: 0, stalls: 0 };
  const lagStallStart = () => { if (!lagMon.stallAt) { lagMon.stallAt = Date.now(); lagMon.stalls++; } };
  const lagStallEnd = () => { if (lagMon.stallAt) { lagMon.stallMs += Date.now() - lagMon.stallAt; lagMon.stallAt = 0; } };
  setInterval(() => {
    try {
      const v = getVideo();
      if (!v || typeof v.getVideoPlaybackQuality !== 'function') return;
      if (v !== lagMon.video) {
        lagMon.video = v;
        v.addEventListener('waiting', lagStallStart);
        v.addEventListener('playing', lagStallEnd);
        const q0 = v.getVideoPlaybackQuality();
        lagMon.dropped = q0.droppedVideoFrames; lagMon.total = q0.totalVideoFrames;
        return;
      }
      lagStallEnd(); if (v.readyState < 3 && !v.paused) lagStallStart();
      const q = v.getVideoPlaybackQuality();
      const dropped = q.droppedVideoFrames - lagMon.dropped;
      const shown = q.totalVideoFrames - lagMon.total;
      lagMon.dropped = q.droppedVideoFrames; lagMon.total = q.totalVideoFrames;
      const stallMs = lagMon.stallMs, stalls = lagMon.stalls;
      lagMon.stallMs = 0; lagMon.stalls = 0;
      if (dropped >= 6 || stallMs >= 300) {
        toHost('clipper-info', `LAG player: dropped ${dropped}/${shown} frames, buffering ${stalls}x ${stallMs}ms (last 10s, ${v.videoWidth}x${v.videoHeight}, hidden=${document.hidden})`);
      }
    } catch (e) {}
  }, 10000);

  setInterval(() => {
    if (liveWanted) toHost('live-state', { on: true, seconds: Math.round(liveBufferedSec()), paused: !live || !shouldRun(live.video) });
  }, 1000);
  ['play', 'playing', 'pause', 'waiting', 'seeking', 'seeked'].forEach(ev =>
    document.addEventListener(ev, () => { if (live) liveSync(); }, true));

  // ---------------------------------------------------------
  // AUTO CLIP FROM CHAT
  // Watches the live chat (same-origin iframe) for new messages only. When the last 15
  // messages are mostly the same word/emote (from several different people, in a burst),
  // it saves the last 30s from the live buffer.
  // ---------------------------------------------------------
  // Sample: the last 15 messages from the past 60s. Tolerance = how many of them must share a word
  // (default 4). The adjuster tunes tolerance per channel to keep a steady number of clips.
  const AUTO = {
    WINDOW: 15, MAX_AGE_SEC: 60, COOLDOWN_MS: 45000, SUBSTRING_MIN: 3,
    DEFAULT_TOLERANCE: 4, MIN_TOLERANCE: 2, MAX_TOLERANCE: 12,
    ADJUST_EVERY_MS: 5 * 60 * 1000, FEW_CLIPS: 1, MANY_CLIPS: 4
  };
  let tolerances = {};        // channel/video id -> tolerance (from config, saved by the host)
  let autoClipTimes = [];     // when auto clips fired on this page
  let autoStartedAt = 0;
  let lastAdjustAt = 0;
  const toleranceNow = () => {
    const id = getVideoId();
    const t = id && tolerances[id];
    return Number.isFinite(t) ? t : AUTO.DEFAULT_TOLERANCE;
  };

  // Word families: different ways chat says the same thing count as one word
  const PHRASES = [
    [/\bwhat\s+the\s+f+u+c+k+\b/g, ' wtf '], [/\bthe\s+f+u+c+k+\b/g, ' wtf '], [/\bwhat\s+the\s+hell\b/g, ' wtf '],
    [/\bgood\s+game\b/g, ' gg '], [/\bhuge\s+w\b/g, ' w '], [/\bhuge\s+l\b/g, ' l ']
  ];
  const ALIASES = { tf: 'wtf', wth: 'wtf', wtff: 'wtf', ggs: 'gg', ggwp: 'gg', dub: 'w', dubs: 'w' };
  const STOPWORDS = new Set(('the a an is are was be to of in on at for and or but it its this that my me you u ur i im we he she they ' +
    'what so do does did not no yes yeah ok okay just like with your his her our was were has have had can will ' +
    'hai ka ki ke ko se bhi na ho to ye wo kya nahi hi aur mai main tu tum hum')
    .split(' '));
  let autoWanted = false;
  let chatItems = null;
  let chatObserver = null;
  let chatMsgs = [];
  let lastAutoAt = 0;
  let chatSeen = 0;          // real messages observed (diagnostics)
  let lastChatSample = '';
  window.__clipperDiag = () => JSON.stringify({
    site: SITE.name, videoId: getVideoId(), title: getTitle(), ad: isAd(),
    video: getVideo() ? { w: getVideo().videoWidth, h: getVideo().videoHeight, paused: getVideo().paused } : null,
    chatAttached: !!chatItems, chatSeen, lastChatSample, buffered: Math.round(liveBufferedSec()),
    liveRestarts, emptyStreak: liveEmptyStreak, badEncoders: [...badEncoders], recorder: live && live.seg ? live.seg.rec.state + ' ' + live.mime : 'none'
  });

  // key: lowercase, repeated letters collapsed ("LOOOL" -> "lol", "😂😂😂" -> "😂")
  const keyOf = (t) => [...t.toLowerCase()].filter((c, i, a) => c !== a[i - 1]).join('');

  function parseMessage(author, text) {
    let s = String(text || '').toLowerCase();
    for (const [re, rep] of PHRASES) s = s.replace(re, rep);
    const words = s
      .split(/\s+/)
      .map(w => w.replace(/^[^\p{L}\p{N}\p{Extended_Pictographic}:]+|[^\p{L}\p{N}\p{Extended_Pictographic}:]+$/gu, ''))
      .filter(Boolean);
    const keys = words.map(w => {
      // whole-word families that letter-squashing would break ("gg" must not become "g")
      if (/^g{2,}(s|wp)?$/.test(w)) return 'gg';
      if (/^w+$/.test(w)) return 'w';
      if (/^l+$/.test(w)) return 'l';
      const k = keyOf(w);
      return ALIASES[k] || k;
    });
    return { t: Date.now(), author: author || '?', words, keys: [...new Set(keys)] };
  }

  function readMessage(el) {
    const r = SITE.readChat(el);
    return r ? parseMessage(r.author, r.text) : null;
  }

  function evaluateChat() {
    if (!autoWanted) return;
    const tol = toleranceNow();
    const now = Date.now();
    // the sample: up to the last 15 messages, only from the past 60s (slow chats get a smaller sample)
    const last = chatMsgs.filter(m => now - m.t <= AUTO.MAX_AGE_SEC * 1000).slice(-AUTO.WINDOW);
    if (last.length < tol) return;
    // Candidate words = every (collapsed) word seen. A message "contains" a candidate if one of its
    // words equals it, or — for candidates of 3+ letters — has it inside ("wtfff", "omgwtf" contain "wtf").
    const candidates = new Map();
    for (const m of last) {
      for (const k of m.keys) {
        if (!k || STOPWORDS.has(k) || candidates.has(k)) continue;
        if (/^\p{L}$/u.test(k) && k !== 'w' && k !== 'l') continue; // lone letters are noise, except W / L
        candidates.set(k, m.words.find(w => keyOf(w) === k) || k);
      }
    }
    let best = null;
    for (const [k, word] of candidates) {
      const sub = [...k].length >= AUTO.SUBSTRING_MIN;
      const hits = last.filter(m => m.keys.some(x => x === k || (sub && x.includes(k))));
      if (!hits.length) continue;
      const s = { k, word, n: hits.length, authors: new Set(hits.map(m => m.author)) };
      // more messages wins; on a tie prefer the shorter core word ("wtf" over "wtfwasthat")
      if (!best || s.n > best.n || (s.n === best.n && [...k].length < [...best.k].length && sub)) best = s;
    }
    // at least `tol` matching messages, from different people (one spammer can't trigger it)
    if (!best || best.n < tol || best.authors.size < Math.min(tol, 4)) return;
    triggerAuto(`chat: "${best.k}" ×${best.n}/${last.length} (tolerance ${tol})`, { word: best.k, count: best.n, authors: best.authors.size, tolerance: tol });
  }

  // Every 5 minutes: 0-1 auto clips -> easier (tolerance -1); 4+ -> stricter (+1). Saved per channel.
  function adjustTolerance() {
    if (!autoWanted || !autoStartedAt) return;
    const now = Date.now();
    if (now - autoStartedAt < AUTO.ADJUST_EVERY_MS || now - lastAdjustAt < AUTO.ADJUST_EVERY_MS) return;
    const v = getVideo();
    if (!v || v.paused) return; // don't judge a stream that isn't being watched
    lastAdjustAt = now;
    autoClipTimes = autoClipTimes.filter(t => now - t <= AUTO.ADJUST_EVERY_MS);
    const clips = autoClipTimes.length;
    const old = toleranceNow();
    let next = old;
    if (clips <= AUTO.FEW_CLIPS) next = Math.max(AUTO.MIN_TOLERANCE, old - 1);
    else if (clips >= AUTO.MANY_CLIPS) next = Math.min(AUTO.MAX_TOLERANCE, old + 1);
    const id = getVideoId();
    if (next !== old && id) {
      tolerances[id] = next;
      toHost('tolerance-changed', { videoId: id, tolerance: next, clips, previous: old });
      showToast(`Auto clip: ${clips} clip(s) in 5 min → tolerance ${old} → ${next}`);
    }
  }
  setInterval(adjustTolerance, 30000);

  function triggerAuto(reason, info) {
    if (Date.now() - lastAutoAt < AUTO.COOLDOWN_MS) return false;
    lastAutoAt = Date.now();
    chatMsgs = []; // need fresh messages before the next chat trigger
    showToast(`⚡ Moment detected (${reason}) — auto-fetching 30s stream slice (0% lag)...`);
    toHost('auto-clip', { reason, ...info });
    // Use direct stream fetch (0% lag, full 60fps, no MediaRecorder needed!)
    const ok = grabStreamSlice(30);
    if (ok) autoClipTimes.push(Date.now());
    else toHost('clipper-info', `auto-clip (${reason}) did not produce a clip`);
    return true;
  }

  // ---------------------------------------------------------
  // LOUDNESS TRIGGER: clip when the stream audio jumps well above its normal level.
  // Reads the stream's own audio (not your speakers/volume slider), ~10 tiny measurements/sec.
  // ---------------------------------------------------------
  const LOUD = { SPIKE_DB: 12, MIN_DB: -22, HOLD_MS: 700, WARMUP_MS: 20000 };
  let loud = null; // { ctx, analyser, video, buf, baseline, since, startedAt, timer }
  let audioStream = null;

  function loudStop() {
    if (!loud) return;
    clearInterval(loud.timer);
    try { loud.ctx.close(); } catch (e) {}
    loud = null;
  }

  function loudStart() {
    const video = getVideo();
    if (!video || video.paused || !video.videoWidth) return;
    if (loud && loud.video === video) return;
    loudStop();

    try {
      if (!audioStream || audioStream.video !== video) {
        // Capture audio track only — stop video track immediately so Chromium does 0 video encoding!
        const fullStream = video.captureStream ? video.captureStream() : null;
        if (!fullStream) return;
        fullStream.getVideoTracks().forEach(t => t.stop());
        audioStream = { video, stream: fullStream };
      }
      const track = audioStream.stream.getAudioTracks().find(t => t.readyState === 'live');
      if (!track) return;
      const ctx = new AudioContext();
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 2048;
      ctx.createMediaStreamSource(new MediaStream([track])).connect(analyser); // not connected to speakers
      loud = { ctx, analyser, video, stream: audioStream.stream, buf: new Float32Array(analyser.fftSize), baseline: null, since: 0, startedAt: Date.now(), short: -90 };
      track.addEventListener('ended', loudStop);
      loud.timer = setInterval(loudTick, 100);
    } catch (e) {
      reportError('loudStart', e);
    }
  }

  function loudTick() {
    if (!loud) return;
    if (loud.video !== getVideo() || (audioStream && audioStream.video !== getVideo())) { loudStop(); return; }
    if (!shouldRun(loud.video)) { loud.since = 0; return; } // paused / ad / buffering
    if (loud.ctx.state === 'suspended') loud.ctx.resume().catch(() => {});
    loud.analyser.getFloatTimeDomainData(loud.buf);
    let sum = 0;
    for (let i = 0; i < loud.buf.length; i++) sum += loud.buf[i] * loud.buf[i];
    const db = 10 * Math.log10(sum / loud.buf.length + 1e-12);
    if (db < -90) return; // silence/gaps never shape the "normal level"                                     // gaps/silence never shape the "normal level"
    loud.short = loud.short < -90 ? db : loud.short * 0.6 + db * 0.4; // ~0.3s smoothing
    if (loud.baseline === null) loud.baseline = loud.short;
    const spiking = loud.short > loud.baseline + LOUD.SPIKE_DB && loud.short > LOUD.MIN_DB;
    // "normal level": ~8s average of non-spike audio; creeps slowly during long loud stretches
    loud.baseline += (loud.short - loud.baseline) * (spiking ? 0.001 : 0.0125);
    if (Date.now() - loud.startedAt < LOUD.WARMUP_MS) return;
    if (spiking) {
      if (!loud.since) loud.since = Date.now();
      if (Date.now() - loud.since >= LOUD.HOLD_MS) {
        const jump = Math.round(loud.short - loud.baseline);
        if (triggerAuto(`audio +${jump} dB`, { loud: true, jump })) loud.since = 0;
      }
    } else {
      loud.since = 0;
    }
  }

  function attachChat() {
    let items = null;
    try { items = SITE.chatItems(); } catch (e) {}
    if (!items) { chatItems = null; return false; }
    if (items === chatItems && chatObserver) return true;
    if (chatObserver) chatObserver.disconnect();
    chatItems = items;
    chatMsgs = [];
    // only NEW messages count (the backlog shown when chat loads is ignored)
    chatObserver = new MutationObserver(muts => {
      for (const mu of muts) {
        for (const n of mu.addedNodes) {
          if (n.nodeType !== 1) continue;
          const el = SITE.messageEl(n);
          if (!el) continue;
          const m = readMessage(el);
          if (m && m.words.length) { chatMsgs.push(m); chatSeen++; lastChatSample = `${m.author}: ${m.words.join(' ')}`.slice(0, 80); }
        }
      }
      if (chatMsgs.length > 60) chatMsgs = chatMsgs.slice(-30);
      evaluateChat();
    });
    chatObserver.observe(items, { childList: true });
    return true;
  }

  // test hook: push a message through the exact same parse + detection path
  window.__clipperFeedChat = (author, text) => {
    const msg = parseMessage(author, text);
    if (msg && msg.words.length) chatMsgs.push(msg);
    evaluateChat();
    return chatMsgs.length;
  };

  // test hooks
  window.__clipperKeys = (text) => parseMessage('t', text).keys.join(',');
  window.__clipperAdjustNow = (clips) => {
    const six = 6 * 60 * 1000;
    autoStartedAt -= six; lastAdjustAt -= six;
    autoClipTimes = Array.from({ length: clips }, () => Date.now() - 1000);
    adjustTolerance();
    return toleranceNow();
  };

  let chatWanted = true;
  let soundWanted = true;

  function autoTick() {
    if (!autoWanted) return;
    let ok = false;
    if (chatWanted) {
      ok = attachChat();
    } else if (chatObserver) {
      chatObserver.disconnect();
      chatObserver = null;
      chatItems = null;
      chatMsgs = [];
    }

    if (soundWanted) {
      if (!loud) loudStart();
    } else if (loud) {
      loudStop();
    }

    toHost('auto-state', {
      on: true,
      chat: ok && chatWanted,
      audio: !!loud && soundWanted,
      tolerance: toleranceNow(),
      window: AUTO.WINDOW
    });
  }
  window.__clipperLoud = () => loud ? JSON.stringify({ short: Math.round(loud.short), baseline: Math.round(loud.baseline) }) : 'off';
  setInterval(autoTick, 2000);

  function setAuto(data) {
    const on = typeof data === 'object' && data !== null ? data.on : data;
    if (data && typeof data === 'object') {
      if (typeof data.chat === 'boolean') chatWanted = data.chat;
      if (typeof data.sound === 'boolean') soundWanted = data.sound;
      if (data.tolerances) tolerances = { ...data.tolerances };
    }
    if (on && !autoWanted) { autoStartedAt = Date.now(); lastAdjustAt = autoStartedAt; autoClipTimes = []; }
    autoWanted = !!on;
    if (!autoWanted) {
      loudStop();
      if (chatObserver) chatObserver.disconnect();
      chatObserver = null;
      chatItems = null;
      chatMsgs = [];
    } else {
      if (!soundWanted) loudStop();
      if (!chatWanted && chatObserver) {
        chatObserver.disconnect();
        chatObserver = null;
        chatItems = null;
        chatMsgs = [];
      }
      autoTick();
    }
  }

  // ---------------------------------------------------------
  // HOTKEYS (capture phase so YouTube's own J/K/I don't fire)
  // ---------------------------------------------------------
  function isTyping() {
    const el = document.activeElement;
    return !!(el && (
      el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable ||
      el.getAttribute('role') === 'textbox' || el.closest(SITE.typingSelector)
    ));
  }

  window.addEventListener('keydown', (e) => {
    if (!hotkeysEnabled || e.ctrlKey || e.altKey || e.metaKey || isTyping()) return;
    const key = (e.key || '').toLowerCase();
    let handled = true;
    if (key === 'j') { if (!isRecording) startRecording(); }
    else if (key === 'k') { if (isRecording) stopRecording(); else handled = false; }
    else if (key === 'i') setPointA();
    else if (key === 'o') setPointB();
    else if (key === 'h') liveClip(60);
    else if (key === 'g') grabLast60Seconds();
    else handled = false;
    if (handled) {
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
    }
  }, true);

  // ---------------------------------------------------------
  // HOST COMMANDS (single path: IPC only)
  // ---------------------------------------------------------
  ipcRenderer.on('host-command', (event, payload) => {
    const command = payload && payload.command;
    const data = payload && payload.data;
    switch (command) {
      case 'start-recording': startRecording(); break;
      case 'stop-recording': stopRecording(); break;
      case 'toggle-recording': isRecording ? stopRecording() : startRecording(); break;
      case 'set-in-point': setPointA(); break;
      case 'set-out-point': setPointB(); break;
      case 'record-range': recordRangeAB(); break;
      case 'clear-points': clearPoints(); break;
      case 'grab-stream-slice': grabStreamSlice(data || 60); break;
      case 'grab-last-60s': grabStreamSlice(60); break;
      case 'set-hotkeys-enabled': hotkeysEnabled = !!data; break;
      case 'set-live':
        liveWanted = !!data;
        if (!liveWanted) { liveStop(); toHost('live-state', { on: false, seconds: 0 }); }
        else liveTick();
        break;
      case 'live-clip': liveClip(data); break;
      case 'set-auto-clip': setAuto(data); break;
      case 'request-snapshot': {
        const v = getVideo();
        const dataUrl = grabFrame(v, 0.95);
        toHost('snapshot-captured', dataUrl
          ? { dataUrl, width: v.videoWidth, height: v.videoHeight, videoId: getVideoId(), title: getTitle() }
          : { error: 'No playing video to take a frame from', videoId: getVideoId(), title: getTitle() });
        break;
      }
    }
  });

  // ---------------------------------------------------------
  // STYLES
  // ---------------------------------------------------------
  function injectStyles() {
    if (document.getElementById('clipper-styles')) return;
    const style = document.createElement('style');
    style.id = 'clipper-styles';
    style.textContent = `
      #clipper-marks { position:absolute; inset:0; pointer-events:none; z-index:40; }
      #clipper-range { position:absolute; top:0; height:100%; background:rgba(16,185,129,.55); display:none; }
      .clipper-mark { position:absolute; top:-7px; width:3px; height:calc(100% + 14px); transform:translateX(-50%); display:none; }
      #clipper-mark-a { background:#10b981; }
      #clipper-mark-b { background:#ef4444; }
      .clipper-mark span { position:absolute; bottom:100%; left:50%; transform:translateX(-50%); font:700 10px/1 sans-serif; color:#fff; padding:2px 4px; border-radius:3px; }
      #clipper-mark-a span { background:#10b981; }
      #clipper-mark-b span { background:#ef4444; }

      #clipper-quick-bar { position:absolute; right:12px; bottom:64px; z-index:70; display:flex; align-items:center; gap:6px;
        background:rgba(12,14,20,.85); border:1px solid rgba(255,255,255,.15); border-radius:8px; padding:5px 8px;
        font:600 11px/1 -apple-system,Segoe UI,Roboto,sans-serif; opacity:.35; transition:opacity .15s; }
      #movie_player:hover #clipper-quick-bar, .video-player:hover #clipper-quick-bar, #clipper-quick-bar:hover { opacity:1; }
      #clipper-quick-bar button { background:#1e2230; color:#f1f5f9; border:1px solid rgba(255,255,255,.12); border-radius:5px; padding:4px 8px; cursor:pointer; font:inherit; }
      #clipper-quick-bar button:hover { background:#2b3044; }
      #clipper-quick-bar button.primary { background:#059669; border-color:#10b981; }
      #clipper-quick-bar button.ghost { background:transparent; border:none; color:#94a3b8; }
      #clipper-readout { font-family:monospace; color:#cbd5e1; }

      #clipper-rec-badge { position:absolute; top:16px; left:16px; z-index:80; display:flex; align-items:center; gap:8px;
        background:rgba(15,17,23,.92); border:1.5px solid #ef4444; color:#fff; padding:6px 12px; border-radius:18px;
        font:600 13px/1 -apple-system,Segoe UI,Roboto,sans-serif; pointer-events:none; }
      .clipper-dot { width:10px; height:10px; background:#ef4444; border-radius:50%; animation:clipper-pulse 1.2s infinite; }
      @keyframes clipper-pulse { 50% { transform:scale(1.25); } }
      .clipper-rec-text { color:#ef4444; font-weight:800; }
      #clipper-timer { font-family:monospace; }
      .clipper-hint { font-size:11px; color:#94a3b8; }

      #clipper-yt-toast { position:absolute; top:60px; left:16px; z-index:80; background:rgba(20,23,33,.95);
        border:1px solid rgba(255,255,255,.2); color:#fff; padding:7px 12px; border-radius:7px;
        font:600 12px/1.3 -apple-system,Segoe UI,Roboto,sans-serif; pointer-events:none; }
      .clipper-hidden { display:none !important; }
    `;
    (document.head || document.documentElement).appendChild(style);
  }

  function tick() {
    try {
      injectStyles();
      ensureTimelineUi();
    } catch (e) {}
  }
  setInterval(tick, 1000);
  document.addEventListener('DOMContentLoaded', tick);
  window.addEventListener('yt-navigate-finish', () => { inPoint = null; outPoint = null; tick(); notifyPoints(); });
  // Twitch (and any SPA): detect in-page navigation by watching the URL
  let lastHref = location.href;
  setInterval(() => {
    if (location.href !== lastHref) {
      lastHref = location.href;
      inPoint = null;
      outPoint = null;
      notifyPoints();
      tick();
    }
  }, 1000);
  toHost('site-info', { site: SITE.name });
  tick();
})();
