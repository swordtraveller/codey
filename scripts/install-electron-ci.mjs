import { spawnSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';

const retryDelaysMs = [30_000, 90_000, 180_000];

export function isTransientDownloadFailure(result) {
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  // Never retry integrity, permissions or configuration failures, even if the
  // surrounding diagnostic output also mentions a network error.
  if (/checksum|sha256.*mismatch|EACCES|EPERM|ENOSPC|MODULE_NOT_FOUND|CERT_|certificate/i.test(output)) {
    return false;
  }
  return result.error?.code === 'ETIMEDOUT' ||
    /\b(ETIMEDOUT|ECONNRESET|ECONNREFUSED|EAI_AGAIN|ENOTFOUND|EPIPE|ERR_SOCKET_CLOSED)\b|Response code (408|429|500|502|503|504)\b/i.test(output);
}

export async function installElectron({
  run, wait = sleep, log = console.log, random = Math.random,
}) {
  for (let attempt = 0; attempt <= retryDelaysMs.length; attempt++) {
    log(`Electron installation attempt ${attempt + 1}/${retryDelaysMs.length + 1}`);
    const result = run();
    if (!result.error && result.status === 0) return 0;
    const exitCode = Number.isInteger(result.status) && result.status > 0 ? result.status : 1;
    if (attempt === retryDelaysMs.length || !isTransientDownloadFailure(result)) {
      log(`Electron installation failed; no further retries (exit ${exitCode}).`);
      return exitCode;
    }
    const delay = retryDelaysMs[attempt] + Math.floor(random() * 5_000);
    log(`Transient download failure; retrying in ${(delay / 1000).toFixed(1)} seconds.`);
    await wait(delay);
  }
}

function verifyInstallation(electronDir, expectedVersion) {
  const actualVersion = readFileSync(join(electronDir, 'dist', 'version'), 'utf8').trim().replace(/^v/, '');
  const executable = readFileSync(join(electronDir, 'path.txt'), 'utf8').trim();
  if (actualVersion !== expectedVersion || executable !== 'electron.exe' ||
      !existsSync(join(electronDir, 'dist', executable))) {
    throw new Error(`Electron installation verification failed for ${expectedVersion}.`);
  }
}

async function main() {
  const electronDir = resolve('node_modules/electron');
  const { version } = JSON.parse(readFileSync(join(electronDir, 'package.json'), 'utf8'));
  if (process.platform !== 'win32' || process.arch !== 'x64') {
    throw new Error('This release installer requires Windows x64.');
  }
  console.log(`Electron ${version}; Actions cache hit: ${process.env.ELECTRON_CACHE_HIT || 'false'}`);
  console.log(`ZIP cache: ${process.env.electron_config_cache}`);
  // Use Electron's own installer and bundled checksums. Never disable validation.
  const env = { ...process.env };
  delete env.ELECTRON_SKIP_BINARY_DOWNLOAD;
  const exitCode = await installElectron({
    run: () => {
      const result = spawnSync(process.execPath, [join(electronDir, 'install.js')], {
        env, encoding: 'utf8', timeout: 120_000, maxBuffer: 8 * 1024 * 1024,
        windowsHide: true,
      });
      if (result.stdout) process.stdout.write(result.stdout);
      if (result.stderr) process.stderr.write(result.stderr);
      if (result.error) console.error(result.error.message);
      return result;
    },
  });
  if (exitCode !== 0) {
    process.exitCode = exitCode;
    return;
  }
  verifyInstallation(electronDir, version);
  console.log(`Electron ${version} installed and verified.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
}
