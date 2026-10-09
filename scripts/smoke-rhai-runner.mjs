import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'

const executable = process.argv[2]
if (!executable) {
  console.error('Usage: node scripts/smoke-rhai-runner.mjs <runner-path>')
  process.exit(2)
}

const request = JSON.stringify({
  script: 'fn manage(ctx) { ctx }',
  context: { pipeline: true },
})
const result = spawnSync(resolve(executable), [], {
  input: request,
  encoding: 'utf8',
  windowsHide: true,
  timeout: 15_000,
})

if (result.error) throw result.error
if (result.status !== 0) {
  throw new Error(`Rhai runner exited with ${result.status}: ${result.stderr.trim()}`)
}

let response
try {
  response = JSON.parse(result.stdout)
} catch {
  throw new Error(`Rhai runner returned invalid JSON: ${result.stdout}`)
}

if (response?.ok !== true || response?.result?.pipeline !== true) {
  throw new Error(`Rhai runner returned an unexpected response: ${result.stdout}`)
}

console.log(`Verified ${resolve(executable)}`)
