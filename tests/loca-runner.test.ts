import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  applyFixtureContextTokens,
  configurationServerTypes,
  contextConfig,
  filterConfigurations,
  isFilesystemOnlyConfiguration,
  locaConfigSourcePath,
  parseArguments,
  patchLocaFilesystemLoggingSource,
  patchLocaPythonExecutableSource,
  validateLocaResults,
  type LocaConfigFile,
  type LocaTaskConfiguration,
} from '../scripts/loca'

const config: LocaConfigFile = {
  version: 1,
  configurations: [
    {
      name: 'CanvasArrangeExamS2LEnv',
      env_class: 'gem.envs.canvas.CanvasArrangeExamS2LEnv',
      seed: 1,
      mcp_servers: {
        canvas: { enabled: true, type: 'canvas' },
        email: { enabled: true, type: 'email' },
        excel: { enabled: true, type: 'excel' },
        filesystem: { enabled: true, type: 'filesystem' },
        python_execute: { enabled: true, type: 'python_execute' },
        claim_done: { enabled: true, type: 'claim_done' },
        memory: { enabled: true, type: 'memory' },
      },
    },
    { name: 'ABTestingS2LEnv', env_class: 'gem.envs.ab.ABTestingS2LEnv', seed: 2 },
    { name: 'ABTestingS2LEnv', env_class: 'gem.envs.ab.ABTestingS2LEnv', seed: 3 },
  ],
}

describe('LOCA runner arguments and result validation', () => {
  it('keeps the LOCA benchmark limit separate from the real model context window', () => {
    expect(parseArguments([
      '--smoke',
      '--task', 'ABTestingS2LEnv',
      '--samples', '2',
      '--total-timeout', '180',
      '--max-context-size', '8192',
      '--model-context-size', '1000000',
    ])).toMatchObject({
      smoke: true,
      task: 'ABTestingS2LEnv',
      samples: 2,
      totalTimeout: 180,
      maxContextSize: 8_192,
      modelContextSize: 1_000_000,
    })
  })

  it('rejects invalid positive numeric options', () => {
    expect(() => parseArguments(['--samples', '0'])).toThrow('--samples must be a positive integer')
    expect(() => parseArguments(['--total-timeout', '-1'])).toThrow('--total-timeout must be a positive integer')
  })

  it('uses one preferred ABTesting task for a smoke run without mutating the source config', () => {
    const filtered = filterConfigurations(config, { smoke: true })
    expect(filtered.configurations).toHaveLength(1)
    expect(filtered.configurations[0]?.name).toBe('ABTestingS2LEnv')
    expect(config.configurations).toHaveLength(3)
    expect(filtered.version).toBe(1)
  })

  it('matches the task name or env-class suffix and limits matching samples', () => {
    const filtered = filterConfigurations(config, { smoke: false, task: 'abtestings2lenv', samples: 1 })
    expect(filtered.configurations).toHaveLength(1)
    expect(filtered.configurations[0]?.seed).toBe(2)
  })

  it('reports available tasks when a selection does not exist', () => {
    expect(() => filterConfigurations(config, { smoke: false, task: 'UnknownTask' })).toThrow('Available tasks:')
  })



  it('identifies enabled filesystem-only MCP configurations and ignores disabled servers', () => {
    const filesystemConfig: LocaTaskConfiguration = {
      name: 'FilesystemTask',
      mcp_servers: {
        filesystem: { enabled: true, type: 'filesystem' },
        claim_done: { enabled: true, type: 'claim_done' },
        email: { enabled: false, type: 'email' },
      },
    }
    expect(configurationServerTypes(filesystemConfig)).toEqual(['filesystem', 'claim_done'])
    expect(isFilesystemOnlyConfiguration(filesystemConfig)).toBe(true)
    expect(isFilesystemOnlyConfiguration({
      ...filesystemConfig,
      mcp_servers: {
        filesystem: { enabled: true, type: 'filesystem' },
        claim_done: { enabled: true, type: 'claim_done' },
        email: { enabled: true, type: 'email' },
      },
    })).toBe(false)
  })

  it('filters filesystem-only configurations and selects the fixture for an implicit smoke run', () => {
    const filtered = filterConfigurations({
      ...config,
      configurations: [
        config.configurations[0]!,
        {
          name: 'FilesystemTask',
          env_class: 'fixture.FilesystemTask',
          mcp_servers: {
            filesystem: { enabled: true, type: 'filesystem' },
            claim_done: { enabled: true, type: 'claim_done' },
          },
        },
      ],
    }, { smoke: true, filesystemOnly: true })
    expect(filtered.configurations).toHaveLength(1)
    expect(filtered.configurations[0]?.name).toBe('FilesystemTask')
  })

  it('fails explicitly when a requested filesystem-only task uses another MCP server', () => {
    expect(() => filterConfigurations(config, {
      smoke: false,
      task: 'CanvasArrangeExamS2LEnv',
      filesystemOnly: true,
    })).toThrow('unsupported MCP server(s): canvas, email, excel, memory, python_execute')
  })

  it('does not treat configurations without MCP declarations as filesystem-only', () => {
    expect(isFilesystemOnlyConfiguration({ name: 'ImplicitEnvironmentTask' })).toBe(false)
  })

  it('fails when filesystem-only filtering leaves no configurations', () => {
    expect(() => filterConfigurations(config, { smoke: false, filesystemOnly: true })).toThrow(
      'No LOCA configurations use only filesystem/claim_done',
    )
  })

  it('uses the repository fixture as the implicit filesystem-only source', () => {
    const args = parseArguments(['--smoke', '--filesystem-only'])
    expect(locaConfigSourcePath(args)).toMatch(/tests[\\/]performance[\\/]loca[\\/]configs[\\/]filesystem_only\.json$/)
  })

  it('selects and parameterizes the long-context filesystem fixture', () => {
    const args = parseArguments(['--smoke', '--filesystem-only', '--long-context', '--fixture-context-tokens', '4096'])
    expect(locaConfigSourcePath(args).replaceAll('\\', '/')).toContain('/tests/performance/loca/configs/filesystem_only_long.json')
    expect(args).toMatchObject({ longContext: true, fixtureContextTokens: 4096 })
    const configured = applyFixtureContextTokens({ configurations: [{ name: 'fixture', env_params: { expected_answer: 'ok' } }] }, 4096)
    expect(configured.configurations[0]?.env_params).toEqual({ expected_answer: 'ok', context_tokens: 4096 })
  })

  it('requires at least one actual successful LOCA task', () => {
    expect(() => validateLocaResults({
      metadata: { total_tasks: 2 },
      summary: { total_success: 0, total_error: 2 },
    })).toThrow('none succeeded')

    expect(validateLocaResults({
      metadata: { total_tasks: 2 },
      summary: { total_success: 1, total_error: 1 },
    })).toEqual({ totalTasks: 2, totalSuccess: 1, totalError: 1 })
  })

  it('patches LOCA filesystem cleanup to close task-local log handlers on Windows', () => {
    const source = [
      '"""Filesystem utilities with NFS compatibility."""',
      '',
      'import errno',
      'import os',
      'import shutil',
      '',
      'def nfs_safe_rmtree(path: str) -> None:',
      '    shutil.rmtree(path, onerror=onerror)',
    ].join('\n')

    const patched = patchLocaFilesystemLoggingSource(source)
    expect(patched).toContain('import logging')
    expect(patched).toContain('def _close_logging_handlers_under(path: str) -> None:')
    expect(patched).toContain('    _close_logging_handlers_under(path)\n    # Windows can briefly retain a sharing lock after a handler is closed.')
    expect(patched).toContain('            shutil.rmtree(path, onerror=onerror)')
    expect(patchLocaFilesystemLoggingSource(patched)).toBe(patched)
  })

  it('runs Python MCP servers with the LOCA virtual-environment interpreter', () => {
    const source = [
      'import os',
      '',
      '    def _build_python_command(self, config, params):',
      '        args = ["server.py"]',
      '        return "python", args',
    ].join('\n')

    const patched = patchLocaPythonExecutableSource(source)
    expect(patched).toContain('import os\nimport sys')
    expect(patched).toContain('# Codey LOCA Python executable compatibility patch')
    expect(patched).toContain('return sys.executable, args')
    expect(patchLocaPythonExecutableSource(patched)).toBe(patched)
  })

  it('rejects an unexpected LOCA Python command source', () => {
    expect(() => patchLocaPythonExecutableSource('import os\n')).toThrow(
      'Unsupported LOCA Python executable compatibility patch format',
    )
  })

  it('rejects an unexpected LOCA filesystem source instead of patching arbitrary code', () => {
    expect(() => patchLocaFilesystemLoggingSource('import shutil\n\nshutil.rmtree(path)')).toThrow(
      'Unsupported LOCA filesystem compatibility patch format',
    )
  })
})

describe('LOCA context management configuration', () => {
  const marginEnvVars = ['LOCA_SAFE_OUTPUT_MARGIN', 'RULER_SAFE_OUTPUT_MARGIN'] as const
  let savedEnv: Record<string, string | undefined>

  beforeEach(() => {
    savedEnv = {}
    for (const key of marginEnvVars) {
      savedEnv[key] = process.env[key]
      delete process.env[key]
    }
  })

  afterEach(() => {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  })

  it('binds the output margin to an explicitly provided --max-tokens value', () => {
    const config = contextConfig({ modelContextSize: 4_096, maxTokens: 256, maxTokensProvided: true })
    expect(config.safeOutputMargin).toBe(256)
  })

  it('scales the margin with the model window when --max-tokens is not provided', () => {
    expect(contextConfig({ modelContextSize: 4_096, maxTokens: 256, maxTokensProvided: false }).safeOutputMargin).toBe(512)
    expect(contextConfig({ modelContextSize: 8_192, maxTokens: 256, maxTokensProvided: false }).safeOutputMargin).toBe(1_024)
  })

  it('keeps the 16k default margin for the default 128k full-run window', () => {
    expect(contextConfig({ modelContextSize: 128_000, maxTokens: 4_096, maxTokensProvided: false }).safeOutputMargin).toBe(16_000)
  })

  it('prefers an explicit LOCA_SAFE_OUTPUT_MARGIN override over both other strategies', () => {
    process.env.LOCA_SAFE_OUTPUT_MARGIN = '128'
    expect(contextConfig({ modelContextSize: 4_096, maxTokens: 256, maxTokensProvided: true }).safeOutputMargin).toBe(128)
    expect(contextConfig({ modelContextSize: 128_000, maxTokens: 4_096, maxTokensProvided: false }).safeOutputMargin).toBe(128)
  })

  it('rejects a non-numeric or negative LOCA_SAFE_OUTPUT_MARGIN instead of producing NaN', () => {
    process.env.LOCA_SAFE_OUTPUT_MARGIN = 'wat'
    expect(() => contextConfig({ modelContextSize: 4_096, maxTokens: 256, maxTokensProvided: true })).toThrow(
      'LOCA_SAFE_OUTPUT_MARGIN must be a non-negative number',
    )
    process.env.LOCA_SAFE_OUTPUT_MARGIN = '-1'
    expect(() => contextConfig({ modelContextSize: 4_096, maxTokens: 256, maxTokensProvided: true })).toThrow(
      'LOCA_SAFE_OUTPUT_MARGIN must be a non-negative number',
    )
  })

  it('never reserves more than the window minus one token', () => {
    const config = contextConfig({ modelContextSize: 200, maxTokens: 256, maxTokensProvided: true })
    expect(config.safeOutputMargin).toBe(199)
  })
})
