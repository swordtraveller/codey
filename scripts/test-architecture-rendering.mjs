import { build } from 'vite'
import react from '@vitejs/plugin-react'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { resolve, join } from 'node:path'
import electron from 'electron'

const project = fileURLToPath(new URL('../', import.meta.url))
const output = resolve(project, '.agent_tmp/architecture-rendering-test')
await build({
  define: { 'process.env.NODE_ENV': JSON.stringify('development') },
  configFile: false, root: join(project, 'tests/renderer/architecture'), base: './', plugins: [react()],
  build: { outDir: output, emptyOutDir: false, minify: false },
})
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
const child = spawn(electron, [join(project, 'tests/renderer/electron.cjs'), output], {
  cwd: project, env, stdio: 'inherit', windowsHide: true, timeout: 45000,
})
child.on('error', (error) => { console.error(error); process.exitCode = 1 })
child.on('exit', (code) => { process.exitCode = code ?? 1 })
