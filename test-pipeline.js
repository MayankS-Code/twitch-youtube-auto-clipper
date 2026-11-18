const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const configManager = require('./src/services/config-manager');
const ffmpegProcessor = require('./src/services/ffmpeg-processor');

async function runTests() {
  console.log('=== Running Clipper Pipeline Automated Test (Vertical 1080x1920) ===\n');

  // 1. Test Config Manager
  console.log('[1/4] Testing ConfigManager...');
  const cfg = configManager.get();
  console.log('  Loaded config:', JSON.stringify(cfg.layout));
  if (cfg.layout.outputWidth !== 1080 || cfg.layout.outputHeight !== 1920) {
    throw new Error('Config layout resolution mismatch (expected vertical 1080x1920)');
  }
  console.log('  ConfigManager vertical check passed! ✅\n');

  // 2. Generate sample test raw clip
  console.log('[2/4] Generating sample raw test video (1920x1080 30fps with audio)...');
  const sampleRawPath = path.join(__dirname, 'clips', 'raw', 'test_sample_clip.webm');
  const sampleFramePath = path.join(__dirname, 'clips', 'frames', 'test_sample_frame.jpg');
  const sampleFinalPath = path.join(__dirname, 'clips', 'final', 'test_sample_vertical.mp4');

  await new Promise((resolve, reject) => {
    const genArgs = [
      '-f', 'lavfi', '-i', 'testsrc=duration=3:size=1920x1080:rate=30',
      '-f', 'lavfi', '-i', 'sine=frequency=1000:duration=3',
      '-c:v', 'libvpx-vp9', '-b:v', '2M',
      '-c:a', 'libopus',
      '-y', sampleRawPath
    ];
    const proc = spawn('ffmpeg', genArgs, { windowsHide: true });
    proc.on('close', code => {
      if (code === 0 && fs.existsSync(sampleRawPath)) resolve();
      else reject(new Error('Sample clip generation failed with code ' + code));
    });
  });
  console.log('  Sample clip ready at:', sampleRawPath, '✅\n');

  // 3. Test frame snapshot extraction
  console.log('[3/4] Testing Snapshot Extraction from clip...');
  await ffmpegProcessor.extractSnapshot(sampleRawPath, sampleFramePath, 1.0);
  if (!fs.existsSync(sampleFramePath)) {
    throw new Error('Snapshot file not created');
  }
  console.log('  Snapshot extracted to:', sampleFramePath, '✅\n');

  // 4. Test Background Rendering & Composite Layout (Vertical 1080x1920, Webcam 3:4 Top, Gameplay Bottom)
  console.log('[4/4] Testing Vertical 1080x1920 Video Filter Graph Composite with NVENC...');
  const testJob = {
    id: 'test_job_vertical',
    title: 'Automated Vertical Pipeline Test',
    rawPath: sampleRawPath,
    outputPath: sampleFinalPath,
    framePath: sampleFramePath,
    crop: {
      webcam: { x: 0.1, y: 0.1, width: 0.35, height: 0.45 },
      gameplay: { x: 0.0, y: 0.0, width: 1.0, height: 1.0 }
    },
    layout: {
      outputWidth: 1080,
      outputHeight: 1920,
      webcamHeight: 800, // width = 800 * 0.75 = 600
      backgroundMode: 'blur',
      autoProcessSaved: true
    }
  };

  let progressReceived = 0;
  ffmpegProcessor.on('job-progress', data => {
    progressReceived = data.progress;
    process.stdout.write(`  Render Progress: ${data.progress}%\r`);
  });

  const finalOut = await new Promise((resolve, reject) => {
    ffmpegProcessor.on('job-complete', job => resolve(job.outputPath));
    ffmpegProcessor.on('job-error', job => reject(new Error(job.error)));
    ffmpegProcessor.enqueue(testJob);
  });

  console.log(`\n  Final vertical composite video rendered successfully at: ${finalOut} ✅`);

  // Verify metadata of final output
  const meta = await ffmpegProcessor.getVideoMetadata(finalOut);
  console.log('  Final Video Metadata:', meta);
  if (meta.width !== 1080 || meta.height !== 1920) {
    throw new Error(`Output resolution mismatch: expected 1080x1920, got ${meta.width}x${meta.height}`);
  }

  console.log('\n=== ALL VERTICAL AUTOMATED TESTS PASSED SUCCESSFULLY! 🎯 ===');
  process.exit(0);
}

runTests().catch(err => {
  console.error('\n❌ Test Error:', err);
  process.exit(1);
});
