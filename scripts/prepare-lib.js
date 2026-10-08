/**
 * Helper build script to copy vendor assets from node_modules into client/lib/
 * for zero-latency static serving on Vercel Edge CDN and local environments.
 */

const fs = require('fs');
const path = require('path');

const rootDir = path.resolve(__dirname, '..');
const clientLibDir = path.join(rootDir, 'client', 'lib');

function copyDirRecursive(src, dest) {
  if (!fs.existsSync(src)) return;
  if (!fs.existsSync(dest)) {
    fs.mkdirSync(dest, { recursive: true });
  }

  const entries = fs.readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);

    if (entry.isDirectory()) {
      copyDirRecursive(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

console.log('[BUILD] Preparing client/lib vendor libraries...');

// 1. Three.js core build (three.module.js, etc.)
const threeBuildSrc = path.join(rootDir, 'node_modules', 'three', 'build');
const threeBuildDest = path.join(clientLibDir, 'three');
copyDirRecursive(threeBuildSrc, threeBuildDest);

// 2. Three.js JSM examples / addons (GLTFLoader, SkeletonUtils, etc.)
const threeJsmSrc = path.join(rootDir, 'node_modules', 'three', 'examples', 'jsm');
const threeJsmDest = path.join(clientLibDir, 'three', 'examples', 'jsm');
copyDirRecursive(threeJsmSrc, threeJsmDest);

// Also mirror to addons/ for importmap compatibility
const threeAddonsDest = path.join(clientLibDir, 'three', 'addons');
copyDirRecursive(threeJsmSrc, threeAddonsDest);

// 3. MediaPipe Tasks Vision (vision_bundle.js, vision_bundle.mjs, wasm binaries)
const mediapipeSrc = path.join(rootDir, 'node_modules', '@mediapipe', 'tasks-vision');
const mediapipeDest = path.join(clientLibDir, 'mediapipe');
copyDirRecursive(mediapipeSrc, mediapipeDest);

console.log('[BUILD] Successfully prepared client/lib assets for Vercel static hosting.');
