import assert from 'node:assert/strict';
import { test } from 'node:test';
import { installElectron, isTransientDownloadFailure } from './install-electron-ci.mjs';

const success = { status: 0, stdout: '', stderr: '' };
const gatewayTimeout = { status: 1, stderr: 'HTTPError: Response code 504 (Gateway Time-out)' };

async function simulate(results, random = () => 0) {
  const waits = [];
  let attempts = 0;
  const code = await installElectron({
    run: () => {
      assert.ok(attempts < results.length, 'unexpected extra installation attempt');
      return results[attempts++];
    },
    wait: async delay => { waits.push(delay); },
    log: () => {}, random,
  });
  return { code, attempts, waits };
}

test('successful installation makes one attempt without waiting', async () => {
  assert.deepEqual(await simulate([success]), { code: 0, attempts: 1, waits: [] });
});

test('504 then success retries only the Electron installation', async () => {
  assert.deepEqual(await simulate([gatewayTimeout, success]), {
    code: 0, attempts: 2, waits: [30_000],
  });
});

test('persistent 504 stops after four attempts with bounded backoff', async () => {
  assert.deepEqual(await simulate(Array(4).fill(gatewayTimeout)), {
    code: 1, attempts: 4, waits: [30_000, 90_000, 180_000],
  });
});

test('last permitted attempt can succeed; jitter remains bounded', async () => {
  assert.deepEqual(await simulate([gatewayTimeout, gatewayTimeout, gatewayTimeout, success], () => 0.9999), {
    code: 0, attempts: 4, waits: [34_999, 94_999, 184_999],
  });
});

test('child process timeout is retryable even without HTTP output', async () => {
  assert.deepEqual(await simulate([{ status: null, error: { code: 'ETIMEDOUT' } }, success]), {
    code: 0, attempts: 2, waits: [30_000],
  });
});

test('permanent failures stop immediately and preserve the exit code', async () => {
  for (const stderr of [
    'HTTPError: Response code 404 (Not Found)',
    'HTTPError: Response code 403 (Forbidden)',
    'ChecksumMismatchError: SHA256 mismatch',
    'Checksum mismatch after ECONNRESET',
    'Error: EPERM opening file',
    'Error: MODULE_NOT_FOUND',
    'Error: certificate has expired',
    'unrecognized installation error',
  ]) {
    assert.deepEqual(await simulate([{ status: 7, stderr }]), { code: 7, attempts: 1, waits: [] });
  }
});

test('spawn failure does not silently succeed or trigger a network retry', async () => {
  assert.deepEqual(await simulate([{ status: null, error: { code: 'ENOENT' } }]), {
    code: 1, attempts: 1, waits: [],
  });
});

test('transient classifier covers network resets, DNS failures and HTTP errors', () => {
  for (const stderr of [
    'Error: ECONNRESET', 'Error: EAI_AGAIN', 'Error: ENOTFOUND',
    'Response code 408', 'Response code 429', 'Response code 500',
    'Response code 502', 'Response code 503', 'Response code 504',
  ]) {
    assert.equal(isTransientDownloadFailure({ status: 1, stderr }), true, stderr);
  }
});

// Exercise the real CLI without a network download or changes to node_modules.
test('CLI invokes the installer and rejects an incomplete or wrong-version installation', {
  skip: process.platform !== 'win32' || process.arch !== 'x64',
}, async () => {
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join, resolve, relative, isAbsolute } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const { spawnSync } = await import('node:child_process');
  const parent = resolve(tmpdir());
  const fixture = mkdtempSync(join(parent, 'codey-electron-ci-'));
  const electron = join(fixture, 'node_modules', 'electron');
  const cli = fileURLToPath(new URL('./install-electron-ci.mjs', import.meta.url));
  try {
    mkdirSync(electron, { recursive: true });
    writeFileSync(join(electron, 'package.json'), JSON.stringify({ version: '37.10.3' }));
    writeFileSync(join(electron, 'install.js'), `
      const fs = require('node:fs');
      const path = require('node:path');
      if (process.env.ELECTRON_SKIP_BINARY_DOWNLOAD) process.exit(9);
      const dist = path.join(__dirname, 'dist');
      fs.mkdirSync(dist, { recursive: true });
      fs.writeFileSync(path.join(dist, 'version'), process.env.FIXTURE_VERSION);
      fs.writeFileSync(path.join(dist, 'electron.exe'), 'fixture');
      fs.writeFileSync(path.join(__dirname, 'path.txt'), 'electron.exe');
    `);
    const run = version => spawnSync(process.execPath, [cli], {
      cwd: fixture, encoding: 'utf8', timeout: 10_000, windowsHide: true,
      env: { ...process.env, ELECTRON_SKIP_BINARY_DOWNLOAD: '1', FIXTURE_VERSION: version },
    });
    const installed = run('37.10.3');
    assert.equal(installed.status, 0, installed.stderr);
    assert.match(installed.stdout, /installed and verified/);
    const wrongVersion = run('37.9.0');
    assert.equal(wrongVersion.status, 1);
    assert.match(wrongVersion.stderr, /verification failed/);
    writeFileSync(join(electron, 'install.js'), 'process.exit(23);');
    const failed = run('37.10.3');
    assert.equal(failed.status, 23);
    assert.match(failed.stdout, /no further retries/);
  } finally {
    const child = relative(parent, resolve(fixture));
    assert.ok(child.startsWith('codey-electron-ci-') && !child.includes('..') && !isAbsolute(child));
    rmSync(fixture, { recursive: true, force: true });
  }
});
