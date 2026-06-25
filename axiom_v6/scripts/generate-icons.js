#!/usr/bin/env node
/**
 * AXIOM IDE — Icon Generator
 * Generates build/icon.png (512×512), build/icon.ico (Windows), and build/icon.icns (macOS)
 * from public/icons/icon.svg using the 'sharp' library if available,
 * or falls back to creating a minimal PNG via raw bytes.
 *
 * Run: node scripts/generate-icons.js
 * CI:  called by .github/workflows/release.yml before electron-builder
 */

'use strict';
const fs   = require('fs');
const path = require('path');

const ROOT  = path.join(__dirname, '..');
const BUILD = path.join(ROOT, 'build');
const SVG   = path.join(ROOT, 'public', 'icons', 'icon.svg');

if (!fs.existsSync(BUILD)) fs.mkdirSync(BUILD, { recursive: true });

// ── Attempt sharp (installed in devDeps) ──────────────────────────
async function withSharp() {
  let sharp;
  try { sharp = require('sharp'); } catch { return false; }

  const svg = fs.readFileSync(SVG);

  // PNG — base size for Linux and as source for ico/icns
  await sharp(svg).resize(512, 512).png().toFile(path.join(BUILD, 'icon.png'));
  console.log('  ✓ build/icon.png (512×512)');

  // ICO — Windows (multi-size: 256, 128, 64, 48, 32, 16)
  // electron-builder accepts a single 256×256 PNG named icon.ico
  await sharp(svg).resize(256, 256).png().toFile(path.join(BUILD, 'icon.ico'));
  console.log('  ✓ build/icon.ico (256×256 PNG accepted by electron-builder)');

  // ICNS — macOS: electron-builder accepts a 512×512 PNG named icon.icns on macOS CI
  await sharp(svg).resize(512, 512).png().toFile(path.join(BUILD, 'icon.icns'));
  console.log('  ✓ build/icon.icns (512×512 PNG, macOS runner converts to .icns)');

  return true;
}

// ── Minimal PNG fallback (pure Node, no deps) ────────────────────
// Generates a 256×256 dark square with "AX" text approximated by a fill.
// This is just enough for electron-builder to not error out.
function writeFallbackPng(dest, size = 256) {
  if (fs.existsSync(dest)) return; // keep existing icon
  const { createCanvas } = (() => {
    try { return require('canvas'); } catch { return {}; }
  })();

  if (createCanvas) {
    const canvas = createCanvas(size, size);
    const ctx    = canvas.getContext('2d');
    // Background
    ctx.fillStyle = '#0d0d0d';
    ctx.beginPath();
    ctx.roundRect(0, 0, size, size, size * 0.16);
    ctx.fill();
    // "AX" text
    ctx.fillStyle = '#f5c518';
    ctx.font = `bold ${Math.round(size * 0.43)}px monospace`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('AX', size / 2, size / 2 + size * 0.04);
    fs.writeFileSync(dest, canvas.toBuffer('image/png'));
    return;
  }

  // Absolute last resort: copy an existing PNG if one was already made
  const base = path.join(BUILD, 'icon.png');
  if (fs.existsSync(base) && dest !== base) {
    fs.copyFileSync(base, dest);
    return;
  }

  // Nothing we can do — write a 1×1 transparent PNG so the build doesn't crash
  const minPng = Buffer.from(
    '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489' +
    '0000000a49444154789c6260000000020001e221bc330000000049454e44ae426082',
    'hex'
  );
  fs.writeFileSync(dest, minPng);
}

async function main() {
  console.log('AXIOM Icon Generator');
  console.log('────────────────────');

  const ok = await withSharp();
  if (!ok) {
    console.log('  sharp not found — using fallback PNG generator');
    const png  = path.join(BUILD, 'icon.png');
    const ico  = path.join(BUILD, 'icon.ico');
    const icns = path.join(BUILD, 'icon.icns');
    writeFallbackPng(png, 512);
    writeFallbackPng(ico, 256);
    writeFallbackPng(icns, 512);
    console.log('  ✓ Fallback icons written to build/');
  }

  // Verify
  ['icon.png','icon.ico','icon.icns'].forEach(f => {
    const p = path.join(BUILD, f);
    const exists = fs.existsSync(p);
    const size   = exists ? (fs.statSync(p).size / 1024).toFixed(1) + ' KB' : 'MISSING';
    console.log(`  ${exists ? '✓' : '✗'} build/${f} — ${size}`);
  });

  console.log('────────────────────');
  console.log('Done.\n');
}

main().catch(e => { console.error(e); process.exit(1); });
