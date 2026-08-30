import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { defaultModelConfig } from '../src/shared/types'
import { RULER_TASKS, runRulerEvaluation, type RulerTaskName } from '../src/main/ruler'

type Arguments = {
  smoke: boolean
  tasks: RulerTaskName[]
  samples: number
  fillerItems: number
  rhaiScriptPath?: string
  outputPath: string
}

function positiveInteger(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`${name} must be a positive integer`)
  return parsed
}

function nonNegativeInteger(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < 0) throw new Error(`${name} must be a non-negative integer`)
  return parsed
}

function parseArguments(argv: string[]): Arguments {
  const smoke = argv.includes('--smoke')
  const value = (name: string): string | undefined => {
    const index = argv.indexOf(name)
    return index >= 0 ? argv[index + 1] : undefined
  }
  const taskValue = value('--task')
  const tasks = (taskValue ? taskValue.split(',') : [...RULER_TASKS]) as RulerTaskName[]
  if (tasks.some((task) => !RULER_TASKS.includes(task))) throw new Error(`Unsupported RULER task. Use: ${RULER_TASKS.join(', ')}`)
  return {
    smoke,
    tasks,
    samples: positiveInteger(value('--samples'), smoke ? 1 : 3, '--samples'),
    fillerItems: nonNegativeInteger(value('--filler-items'), smoke ? 8 : 48, '--filler-items'),
    rhaiScriptPath: value('--rhai-script'),
    outputPath: value('--output') ?? resolve('tests/performance/results', `ruler-${Date.now()}.json`),
  }
}

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`Missing ${name}. Configure the remote OpenAI-compatible model before running RULER.`)
  return value
}

async function main(): Promise<void> {
  const args = parseArguments(process.argv.slice(2))
  const rhaiScript = args.rhaiScriptPath
    ? await readFile(resolve(args.rhaiScriptPath), 'utf8')
    : undefined
  const modelMaxContext = Number(process.env.RULER_MODEL_MAX_CONTEXT ?? defaultModelConfig.modelMaxContext)
  const modelConfig = {
    ...defaultModelConfig,
    id: 'ruler-evaluation',
    name: 'RULER evaluation model',
    baseUrl: requiredEnvironment('RULER_BASE_URL'),
    apiKey: requiredEnvironment('RULER_API_KEY'),
    modelName: requiredEnvironment('RULER_MODEL'),
    modelMaxContext: Number.isFinite(modelMaxContext) ? modelMaxContext : defaultModelConfig.modelMaxContext,
  }
  const result = await runRulerEvaluation({
    modelConfig,
    remote: {
      baseUrl: modelConfig.baseUrl,
      apiKey: modelConfig.apiKey,
      modelName: modelConfig.modelName,
      timeoutMs: Number(process.env.RULER_TIMEOUT_MS ?? 120_000),
      maxOutputTokens: Number(process.env.RULER_MAX_OUTPUT_TOKENS ?? 256),
    },
    tasks: args.tasks,
    samplesPerTask: args.samples,
    fillerItems: args.fillerItems,
    contextConfig: {
      layeredEnabled: process.env.RULER_LAYERED !== 'false',
      hotTokenBudget: Number(process.env.RULER_HOT_TOKEN_BUDGET ?? 64_000),
      warmTokenBudget: Number(process.env.RULER_WARM_TOKEN_BUDGET ?? 32_000),
      coldRecallTokenBudget: Number(process.env.RULER_COLD_RECALL_TOKEN_BUDGET ?? 8_000),
      safeOutputMargin: Number(process.env.RULER_SAFE_OUTPUT_MARGIN ?? 16_000),
    },
    rhaiScript,
  })
  await mkdir(dirname(resolve(args.outputPath)), { recursive: true })
  await writeFile(resolve(args.outputPath), `${JSON.stringify(result, null, 2)}\n`, 'utf8')
  for (const [strategy, summary] of Object.entries(result.summary)) {
    console.log(`${strategy}: ${summary.correct}/${summary.cases} correct (${(summary.accuracy * 100).toFixed(1)}%), context ${summary.averageContextBuildMs.toFixed(1)}ms, remote ${summary.averageRemoteRequestMs.toFixed(1)}ms`)
  }
  console.log(`RULER result: ${resolve(args.outputPath)}`)
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})
