import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { resolve } from 'node:path'

/**
 * Prepares a SWE-bench Verified instance for the local LOCA coding fixture.
 *
 * Materials land entirely inside the gitignored tests/performance/.cache
 * directory (license-safe: the repository only ever contains this script),
 * following the same pattern as the LOCA upstream cache. Each instance gets:
 *
 *   .cache/swe-materials/<instance_id>/repo/     repo snapshot at base_commit
 *   .cache/swe-materials/<instance_id>/venv/     dependency venv (no -e install)
 *   .cache/swe-materials/<instance_id>/test.patch  hidden grading tests
 *   .cache/swe-materials/<instance_id>/gold.patch  reference fix (validation only)
 *   .cache/swe-materials/<instance_id>/meta.json   problem statement + F2P/P2P ids
 *
 * Usage: npx tsx scripts/swe-bench-prepare.ts --instance pallets__flask-5014 [--verify]
 */

type SweInstance = {
  repo: string
  instance_id: string
  base_commit: string
  patch: string
  test_patch: string
  problem_statement: string
  FAIL_TO_PASS: string
  PASS_TO_PASS: string
}

type Recipe = {
  deps: string[]
  pytestArgs: string[]
}

const recipes: Record<string, Recipe> = {
  'pallets/flask': {
    deps: ['pytest>=8,<9', 'werkzeug==2.3.8', 'Jinja2>=3.1.2,<3.2', 'click>=8.1.3,<8.2', 'itsdangerous>=2.1.2', 'MarkupSafe>=2.1.1', 'asgiref>=3.2', 'greenlet'],
    pytestArgs: ['-p', 'no:warnings'],
  },
}

const root = resolve(process.cwd())
const cacheRoot = resolve(root, 'tests/performance/.cache')
const metadataPath = resolve(cacheRoot, 'swe-verified-all.json')
const locaVenvPython = resolve(cacheRoot, 'loca-upstream/.venv/Scripts/python.exe')

function run(command: string, args: string[], options: { cwd?: string; retries?: number; env?: Record<string, string> } = {}): { status: number | null; stdout: string; stderr: string } {
  const retries = options.retries ?? 3
  let last: { status: number | null; stdout: string; stderr: string } = { status: -1, stdout: '', stderr: '' }
  for (let attempt = 1; attempt <= retries; attempt += 1) {
    const child = spawnSync(command, args, { cwd: options.cwd, encoding: 'utf8', windowsHide: true, env: { ...process.env, ...(options.env ?? {}) } })
    last = { status: child.status, stdout: child.stdout ?? '', stderr: child.stderr ?? '' }
    if (child.status === 0) return last
    console.log(`  [attempt ${attempt}/${retries}] ${command} ${args[0] ?? ''} failed: ${String(child.stderr ?? child.error?.message ?? child.status).slice(0, 160)}`)
  }
  return last
}

async function loadInstance(instanceId: string): Promise<SweInstance> {
  if (!existsSync(metadataPath)) {
    throw new Error(`SWE-bench metadata missing: ${metadataPath}. Fetch it from the HuggingFace datasets-server first.`)
  }
  const all = JSON.parse(await readFile(metadataPath, 'utf8')) as SweInstance[]
  const instance = all.find((entry) => entry.instance_id === instanceId)
  if (!instance) throw new Error(`Unknown instance "${instanceId}". ${all.length} instances are available in the metadata cache.`)
  return instance
}

async function rmWithRetry(target: string): Promise<void> {
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    try {
      await rm(target, { recursive: true, force: true })
      return
    } catch (error) {
      if (attempt === 5) throw error
      await new Promise((resolve) => setTimeout(resolve, 1000 * attempt))
    }
  }
}

async function fetchRepoSnapshot(instance: SweInstance, repoDir: string): Promise<void> {
  if (existsSync(repoDir)) await rmWithRetry(repoDir)
  await mkdir(repoDir, { recursive: true })
  const git = (args: string[], cwd: string) => run('git', ['-c', 'core.autocrlf=false', ...args], { cwd, retries: 3 })
  let result = git(['init', '--quiet'], repoDir)
  if (result.status !== 0) throw new Error('git init failed')
  result = git(['remote', 'add', 'origin', `https://github.com/${instance.repo}`], repoDir)
  result = git(['fetch', '--quiet', '--depth', '1', 'origin', instance.base_commit], repoDir)
  if (result.status !== 0) throw new Error(`git fetch ${instance.base_commit.slice(0, 10)} failed after retries`)
  result = git(['checkout', '--quiet', 'FETCH_HEAD'], repoDir)
  if (result.status !== 0) throw new Error('git checkout FETCH_HEAD failed')
}

async function buildDependencyVenv(instance: SweInstance, venvDir: string): Promise<string> {
  const recipe = recipes[instance.repo]
  if (!recipe) throw new Error(`No environment recipe for ${instance.repo}. Add one to scripts/swe-bench-prepare.ts first.`)
  if (existsSync(venvDir)) await rmWithRetry(venvDir)
  let result = run(locaVenvPython, ['-m', 'venv', venvDir], { retries: 2 })
  if (result.status !== 0) throw new Error('venv creation failed')
  const venvPython = resolve(venvDir, 'Scripts/python.exe')
  result = run(venvPython, ['-m', 'pip', 'install', '--quiet', '--disable-pip-version-check', ...recipe.deps], { retries: 3 })
  if (result.status !== 0) throw new Error(`pip install failed: ${result.stderr.slice(0, 300)}`)
  return venvPython
}

function parseJunit(path: string): { total: number; failures: number; errors: number } {
  let xml = ''
  try { xml = readFileSync(path, 'utf8') } catch { return { total: 0, failures: 0, errors: 0 } }
  // pytest 的 testsuite 属性顺序不定,逐标签按属性名取值
  return [...xml.matchAll(/<testsuite\b[^>]*>/g)].reduce((acc, tagMatch) => {
    const tag = tagMatch[0]
    const attr = (name: string) => Number(tag.match(new RegExp(`\\b${name}="(\\d+)"`))?.[1] ?? 0)
    return { total: acc.total + attr('tests'), failures: acc.failures + attr('failures'), errors: acc.errors + attr('errors') }
  }, { total: 0, failures: 0, errors: 0 })
}

async function verify(instance: SweInstance, materialDir: string, venvPython: string): Promise<void> {
  const recipe = recipes[instance.repo]!
  const repoDir = resolve(materialDir, 'repo')
  const f2p = JSON.parse(instance.FAIL_TO_PASS) as string[]
  const p2p = JSON.parse(instance.PASS_TO_PASS) as string[]
  const gitInRepo = (args: string[]) => run('git', ['-c', 'core.autocrlf=false', '-C', repoDir, ...args], { retries: 1 })
  gitInRepo(['checkout', '--quiet', '--', '.'])
  gitInRepo(['clean', '-fdxq'])
  console.log('verify: 红灯(基线 + 隐藏测试,期望失败)')
  if (gitInRepo(['apply', resolve(materialDir, 'test.patch')]).status !== 0) throw new Error('test.patch does not apply to the base commit')
  const runTests = (ids: string[], junitName: string) => {
    const junit = resolve(materialDir, junitName)
    if (existsSync(junit)) rmSync(junit, { force: true })
    const result = run(venvPython, ['-m', 'pytest', ...ids, ...recipe.pytestArgs, '--junitxml=' + junit, '-q'], {
      cwd: repoDir,
      env: { PYTHONPATH: resolve(repoDir, 'src') },
    })
    if (result.status !== 0) console.log(`  [pytest ${junitName}] status=${result.status} out: ${result.stdout.slice(-300).replace(/\s+/g, ' ')}`)
    return parseJunit(junit)
  }
  const red = runTests(f2p, 'junit-red.xml')
  console.log(`  F2P @base: ${red.total - red.failures - red.errors}/${red.total} passed (期望 < 全过)`)
  if (red.failures + red.errors === 0) throw new Error('F2P unexpectedly green at base commit — 判分材料不自洽')
  console.log('verify: 绿灯(+ 金补丁,期望全过)')
  if (gitInRepo(['apply', resolve(materialDir, 'gold.patch')]).status !== 0) throw new Error('gold.patch does not apply cleanly')
  const greenF2p = runTests(f2p, 'junit-green-f2p.xml')
  console.log(`  F2P @gold: ${greenF2p.total - greenF2p.failures - greenF2p.errors}/${greenF2p.total} passed`)
  if (greenF2p.failures + greenF2p.errors > 0) throw new Error('F2P still red with gold patch')
  const greenP2p = runTests(p2p, 'junit-green-p2p.xml')
  console.log(`  P2P @gold: ${greenP2p.total - greenP2p.failures - greenP2p.errors}/${greenP2p.total} passed`)
  if (greenP2p.failures + greenP2p.errors > 0) throw new Error('gold patch breaks pass-to-pass tests')
  gitInRepo(['checkout', '--quiet', '--', '.'])
  gitInRepo(['clean', '-fdxq'])
  console.log('verify: OK(已还原为干净基线)')
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2)
  const value = (name: string) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined }
  const instanceId = value('--instance')
  if (!instanceId) throw new Error('用法: npx tsx scripts/swe-bench-prepare.ts --instance <instance_id> [--verify]')
  const instance = await loadInstance(instanceId)
  const materialDir = resolve(cacheRoot, 'swe-materials', instanceId)
  console.log(`准备实例 ${instanceId}(${instance.repo} @ ${instance.base_commit.slice(0, 10)})`)
  await mkdir(materialDir, { recursive: true })
  await writeFile(resolve(materialDir, 'test.patch'), instance.test_patch.replace(/\r\n/g, '\n'), 'utf8')
  await writeFile(resolve(materialDir, 'gold.patch'), instance.patch.replace(/\r\n/g, '\n'), 'utf8')
  await writeFile(resolve(materialDir, 'meta.json'), JSON.stringify({
    instance_id: instance.instance_id,
    repo: instance.repo,
    base_commit: instance.base_commit,
    problem_statement: instance.problem_statement,
    fail_to_pass: JSON.parse(instance.FAIL_TO_PASS),
    pass_to_pass: JSON.parse(instance.PASS_TO_PASS),
    venv_python_relative: 'venv/Scripts/python.exe',
    pytest_args: recipes[instance.repo]!.pytestArgs,
  }, null, 2), 'utf8')
  console.log('1/3 拉取仓库快照...')
  await fetchRepoSnapshot(instance, resolve(materialDir, 'repo'))
  console.log('2/3 构建依赖 venv(按实例配方钉版)...')
  const venvPython = await buildDependencyVenv(instance, resolve(materialDir, 'venv'))
  console.log('3/3 就绪。材料目录(已 gitignore):', materialDir)
  if (argv.includes('--verify')) await verify(instance, materialDir, venvPython)
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
})
