import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const project = fileURLToPath(new URL('../', import.meta.url))
// Keep this list focused on user flows. The full suite remains available via pnpm test.
const suites = [
  'tests/workspace.test.ts',
  'tests/workspace-immediate.test.ts',
  'tests/workspace-pagination.test.ts',
  'tests/conversation-store.test.ts',
  'tests/task-run-agent.test.ts',
  'src/shared/analytics.test.ts',
  'src/shared/usage-analytics.test.ts',
  'src/shared/usage-calendar.test.ts',
  'src/main/analytics.test.ts',
  'src/main/todo-tool.test.ts',
  'src/main/dag-tool.test.ts',
  'tests/agent-limits.test.ts',
  'tests/model-config.test.ts',
  'tests/model-failover.test.ts',
  'tests/command-execution.test.ts',
  'tests/context.test.ts',
  'tests/context-budgets.test.ts',
  'tests/code-reading.test.ts',
  'tests/code-reading-window.test.ts',
  'tests/architecture.test.ts',
  'tests/message-navigation-window.test.ts',
  'tests/conversation-window.test.ts',
]
const steps = [
  ['Renderer fixture typecheck', ['node_modules/typescript/bin/tsc', '-p', 'tests/renderer/tsconfig.json', '--pretty', 'false']],
  ['Main-process regressions', ['node_modules/vitest/vitest.mjs', 'run', ...suites]],
  ['Analytics in Chromium', ['scripts/test-analytics.mjs']],
  ['Settings in Chromium', ['scripts/test-settings.mjs']],
  ['Conversation rendering in Chromium', ['scripts/test-conversation-rendering.mjs']],
  ['Architecture navigation in Chromium', ['scripts/test-architecture-rendering.mjs']],
]

for (const [label, args] of steps) {
  console.log('\n' + label)
  const code = await new Promise((resolve) => {
    const child = spawn(process.execPath, args, { cwd: project, stdio: 'inherit', windowsHide: true })
    child.once('error', (error) => { console.error(error); resolve(1) })
    child.once('exit', (code) => resolve(code ?? 1))
  })
  if (code !== 0) {
    process.exitCode = code
    break
  }
}
