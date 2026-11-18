# 🎬 Clipper — YouTube Clip & Smart Video Layout Studio

**Clipper** is a lightweight, high-performance desktop custom browser and automated video clipping application built specifically for gaming and live streams on YouTube.

---

## ⚡ Key Features

### 1. Custom Embedded YouTube Browser
- Built with Chromium/Electron for native video hardware acceleration and zero playback stutter.
- Complete navigation bar with Back, Forward, Reload, and direct URL / search inputs.

### 2. Dual Clipping Modes

#### **Mode 1: Instant Hotkey Clipping (While Watching)**
- Hooked directly to YouTube's `<video>` element.
- **Press `J`**: Starts instant recording of the video stream at native YouTube resolution and framerate.
- **Press `K`**: Stops recording and immediately dispatches the clip to the processing pipeline.
- On-player pulsing HUD overlay (`● REC 00:05 [Press K to Finish]`) gives instant visual feedback.
- Intelligent input detection: automatically ignores keystrokes when typing in YouTube search bars, comments, or live chat.

#### **Mode 2: Timeline In/Out Points & Auto Replay-Record**
- Visual markers injected directly onto YouTube's timeline progress bar.
- **Press `I` (or click `📍 In`)**: Sets Start point **[A]** (green pin on timeline).
- **Press `O` (or click `🏁 Out`)**: Sets End point **[B]** (red pin on timeline).
- Shows highlighted range band spanning between [A] and [B].
- Click **`⚡ Clip A→B`**: The player seeks to Point A, starts recording, plays smoothly through to Point B, and automatically finishes recording!

### 3. Intermediate Crop & Layout Studio
- Captures an instant frame snapshot from the clip.
- Two interactive bounding boxes:
  - 📷 **Webcam Box**: Constrained strictly to **3:4 aspect ratio** (3 horizontal, 4 vertical), draggable and resizable with corner handles.
  - 🎮 **Gameplay Box**: Draggable and resizable to capture the gameplay window.
- **Persistent Rectangles**: Configured once, saved permanently to `config.json`.
- **Anytime Access**: Click **`📐 Crop & Layout`** in the top bar anytime to tweak rectangles or update the streamer's layout.

### 4. Vertical 1080×1920 Final Layout
- **Resolution**: vertical **1080×1920**.
- **Webcam**: top-aligned, horizontally centered, exactly 3:4 (3 wide, 4 tall). Size set by the "Webcam size" slider. The selected webcam area is center-cropped to 3:4, never stretched.
- **Gameplay**: fills from the bottom of the webcam to the bottom of the frame. "Fill" trims equal amounts off the sides if needed so nothing exceeds the frame; "Fit" shows the whole box with background around it.
- The editor preview and the FFmpeg render share one layout module (`src/services/layout-math.js`), so the preview is exactly what gets rendered.
- **Backdrop**: blurred video, dark, or black.

### Troubleshooting
- Errors are written to `clipper.log` next to `main.js`.
- Self-test: `set CLIPPER_SELFTEST=1 && npm start` records 5s of a YouTube video and renders it, then closes.

### 5. Non-Heavy Passive Background Processing
- As soon as a clip finishes, it is pushed into a **Background Render Queue**.
- Uses **NVIDIA NVENC GPU Acceleration (`h264_nvenc`)** for lightning-fast, essentially 0% CPU rendering (with automatic CPU `libx264` fallback).
- Runs with **low OS process priority** (`PRIORITY_BELOW_NORMAL`), ensuring YouTube playback remains 100% fluid at 60 FPS without frame drops.
- You can keep watching and recording more clips while previous ones render in the background!
- Floating **Queue Drawer** displays live progress percentages, thumbnails, and quick "Play" / "Reveal in Folder" buttons.

---

## 🚀 Quick Start

### 1. Launch Clipper
Double-click `run.bat` or run in terminal:
```bash
npm start
```

### 2. Take Your First Clip
1. Search or navigate to any gaming stream or video on YouTube.
2. Hit **`J`** to start recording, and **`K`** to stop (or set In/Out points with **`I`** & **`O`** and click `⚡ Clip A→B`).
3. On your first clip, the **Crop & Layout Studio** will open with a screenshot of the clip.
4. Drag the green box over the webcam and the purple box over the gameplay.
5. Check **"Save as default"** and click **`⚡ Render in Background`**.
6. All future clips will now automatically render passively in the background without interrupting your viewing!

---

## 📂 File Structure
- `clips/raw/` — Original recorded clips at native YouTube resolution (`.webm`).
- `clips/frames/` — Extracted frame screenshots used for crop positioning (`.jpg`).
- `clips/final/` — Final composite 1920×1080 MP4 videos (`.mp4`).
- `config.json` — Persistent crop coordinates and layout preferences.
- `run.bat` — One-click launcher.
