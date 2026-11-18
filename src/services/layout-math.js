// Shared layout math used by BOTH the editor preview and the FFmpeg renderer.
//
// Output: vertical 1080 x 1920
//   Webcam slot  : top 30% of the height (576px), 4:3 (or 3:4), horizontally centered
//   Gameplay slot: bottom 70% (1344px), full width 1080
//
// The selection boxes in the editor are locked to the same shape as their slot,
// so a box maps 1:1 onto its slot: no stretching, no trimming.

const OUT_W = 1080;
const OUT_H = 1920;
const CAM_FRACTION = 0.30;
const MIN_NORM = 0.01;

const even = (v) => Math.max(2, Math.round(v / 2) * 2);

// 'full' = edge to edge (1080x576, 15:8) so there are no side bars at all
const CAM_SHAPES = { '4:3': 4 / 3, '3:4': 3 / 4, '16:9': 16 / 9, 'full': 1080 / 576 };

function clampRect(r) {
  const out = {
    x: Number(r && r.x) || 0,
    y: Number(r && r.y) || 0,
    width: Number(r && r.width) || 1,
    height: Number(r && r.height) || 1
  };
  out.width = Math.min(1, Math.max(MIN_NORM, out.width));
  out.height = Math.min(1, Math.max(MIN_NORM, out.height));
  out.x = Math.min(1 - out.width, Math.max(0, out.x));
  out.y = Math.min(1 - out.height, Math.max(0, out.y));
  return out;
}

// Output slots in pixels
function getSlots(layout = {}) {
  const camAspect = CAM_SHAPES[layout.webcamShape] || CAM_SHAPES['4:3'];
  const camH = even(OUT_H * CAM_FRACTION);           // 576
  const camW = Math.min(OUT_W, even(camH * camAspect)); // 768 for 4:3
  return {
    cam: { x: Math.floor((OUT_W - camW) / 2), y: 0, w: camW, h: camH },
    game: { x: 0, y: camH, w: OUT_W, h: OUT_H - camH }   // 1080 x 1344
  };
}

// Width/height ratio each selection box must have (in real source pixels)
function slotAspects(layout = {}) {
  const s = getSlots(layout);
  return { webcam: s.cam.w / s.cam.h, gameplay: s.game.w / s.game.h };
}

// Center-crop a rect (px) to an aspect ratio — safety net for old saved boxes
function coverCrop(x, y, w, h, aspect) {
  if (w / h > aspect) {
    const nw = h * aspect;
    return { x: x + (w - nw) / 2, y, w: nw, h };
  }
  const nh = w / aspect;
  return { x, y: y + (h - nh) / 2, w, h: nh };
}

function computeLayout(srcW, srcH, crop, layout = {}) {
  srcW = srcW || 1920;
  srcH = srcH || 1080;
  const slots = getSlots(layout);

  const part = (rect, slot) => {
    const r = clampRect(rect);
    const c = coverCrop(r.x * srcW, r.y * srcH, r.width * srcW, r.height * srcH, slot.w / slot.h);
    return { src: { x: c.x / srcW, y: c.y / srcH, w: c.w / srcW, h: c.h / srcH }, dst: { ...slot } };
  };

  return {
    outW: OUT_W,
    outH: OUT_H,
    cam: part(crop.webcam, slots.cam),
    game: part(crop.gameplay, slots.game)
  };
}

module.exports = { OUT_W, OUT_H, CAM_SHAPES, computeLayout, clampRect, getSlots, slotAspects };
