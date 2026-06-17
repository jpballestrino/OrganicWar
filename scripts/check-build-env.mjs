/**
 * Pre-build environment check (cross-platform).
 * Asserts that rustc, wasm-pack (required) and wasm-opt (recommended) are
 * available before the WASM build runs, so failures are loud and clear.
 *
 * Run manually:  node scripts/check-build-env.mjs
 * Run via npm:   npm run check-build-env
 *
 * Set SKIP_BUILD_CHECK=1 to bypass (e.g. in environments where the check
 * itself fails but the tools are present via a non-standard PATH).
 */

import { execSync } from 'child_process';

if (process.env.SKIP_BUILD_CHECK === '1') {
  console.log('[check-build-env] Skipped (SKIP_BUILD_CHECK=1)');
  process.exit(0);
}

function check(cmd, label, required = true) {
  try {
    const out = execSync(`${cmd} --version`, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
    console.log(`  ✓ ${label}: ${out}`);
    return true;
  } catch {
    if (required) {
      console.error(`  ✗ ${label} not found — cannot build WASM.`);
      return false;
    } else {
      console.warn(`  ~ ${label} not found (optional — WASM may be larger without it).`);
      return true;
    }
  }
}

console.log('\n[check-build-env] Verifying WASM build tools...\n');

const ok = [
  check('rustc',    'Rust compiler (rustc)',  true),
  check('wasm-pack','wasm-pack',              true),
  check('wasm-opt', 'wasm-opt (binaryen)',    false),
].every(Boolean);

if (!ok) {
  console.error('\n[check-build-env] FATAL: Missing required build tools.');
  console.error('  Install Rust:      https://rustup.rs');
  console.error('  Install wasm-pack: cargo install wasm-pack');
  console.error('  Install binaryen:  https://github.com/WebAssembly/binaryen/releases\n');
  process.exit(1);
}

console.log('\n[check-build-env] All required tools present. Proceeding with build.\n');
