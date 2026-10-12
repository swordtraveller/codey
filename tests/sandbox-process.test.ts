import { afterEach, describe, expect, it } from 'vitest'
import { runSandboxProcess } from '../src/main/sandbox'

const runningProcesses: Array<AbortController> = []

function runNode(script: string, timeoutMs = 5_000, signal?: AbortSignal) {
  return runSandboxProcess(process.execPath, ['-e', script], process.cwd(), timeoutMs, undefined, undefined, signal)
}

afterEach(() => {
  for (const controller of runningProcesses.splice(0)) controller.abort()
})

describe('runSandboxProcess lifecycle', () => {
  it('returns output and a zero exit code for normal completion', async () => {
    const result = await runNode("process.stdout.write('ok')")

    expect(result).toMatchObject({
      exitCode: 0,
      stdout: 'ok',
      timedOut: false,
    })
  })

  it('returns the child exit code for an abnormal completion', async () => {
    const result = await runNode('process.exit(2)')

    expect(result).toMatchObject({
      exitCode: 2,
      timedOut: false,
    })
  })

  it('returns a timed out result when the child does not exit', async () => {
    const result = await runNode('setInterval(() => {}, 1_000)', 100)

    expect(result.timedOut).toBe(true)
  }, 10_000)

  it('rejects with AbortError when the caller cancels the child', async () => {
    const controller = new AbortController()
    runningProcesses.push(controller)
    const promise = runNode('setInterval(() => {}, 1_000)', 5_000, controller.signal)
    controller.abort()

    await expect(promise).rejects.toMatchObject({ name: 'AbortError' })
  }, 10_000)
})
