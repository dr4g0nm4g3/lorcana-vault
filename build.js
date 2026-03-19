#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// build.js  —  Lorcana Vault build script
//
// Reads:
//   src/template.html   — HTML with placeholder comments
//   src/lorcana.js      — pure business logic (source of truth, also used by tests)
//   src/app.js          — DOM-dependent application code
//
// Writes:
//   dist/lorcana-browser.html  — single self-contained HTML file, double-clickable
//
// Usage:
//   node build.js            — build dist/lorcana-browser.html
//   node build.js --watch    — rebuild on any src/ file change (requires Node 22+)
// ─────────────────────────────────────────────────────────────────────────────

'use strict';

const fs   = require('fs');
const path = require('path');

const ROOT     = __dirname;
const SRC      = path.join(ROOT, 'src');
const DIST     = path.join(ROOT, 'dist');
const TEMPLATE = path.join(SRC,  'template.html');
const LOGIC    = path.join(SRC,  'lorcana.js');
const APP      = path.join(SRC,  'app.js');
const OUTPUT   = path.join(DIST, 'lorcana-browser.html');

function build() {
  const start = Date.now();

  // Read sources
  const template  = fs.readFileSync(TEMPLATE, 'utf8');
  const logicCode = fs.readFileSync(LOGIC,    'utf8');
  const appCode   = fs.readFileSync(APP,      'utf8');

  // Validate placeholders exist
  if (!template.includes('// $$LORCANA_LOGIC$$')) {
    throw new Error('template.html is missing the // $$LORCANA_LOGIC$$ placeholder');
  }
  if (!template.includes('// $$LORCANA_APP$$')) {
    throw new Error('template.html is missing the // $$LORCANA_APP$$ placeholder');
  }

  // Inject: replace both placeholders in a single pass
  const output = template
    .replace('// $$LORCANA_LOGIC$$', logicCode)
    .replace('// $$LORCANA_APP$$',   appCode);

  // Ensure dist/ exists
  fs.mkdirSync(DIST, { recursive: true });

  fs.writeFileSync(OUTPUT, output, 'utf8');

  const ms = Date.now() - start;
  const kb = (Buffer.byteLength(output, 'utf8') / 1024).toFixed(1);
  console.log(`✓ Built ${path.relative(ROOT, OUTPUT)} (${kb} KB) in ${ms}ms`);
}

// ── Watch mode ────────────────────────────────────────────────────────────────

function watch() {
  build(); // initial build
  console.log(`\nWatching src/ for changes… (Ctrl+C to stop)\n`);

  let debounce = null;
  fs.watch(SRC, { recursive: true }, (event, filename) => {
    if (!filename) return;
    clearTimeout(debounce);
    debounce = setTimeout(() => {
      console.log(`  changed: ${filename}`);
      try {
        build();
      } catch (e) {
        console.error('  Build failed:', e.message);
      }
    }, 80);
  });
}

// ── Main ──────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);

try {
  if (args.includes('--watch')) {
    watch();
  } else {
    build();
  }
} catch (e) {
  console.error('Build failed:', e.message);
  process.exit(1);
}
