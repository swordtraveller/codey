import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { resolve } from 'node:path'
import {
  applyFixtureContextTokens,
  configurationServerTypes,
  contextConfig,
  filterConfigurations,
  isFilesystemOnlyConfiguration,
  locaConfigSourcePath,
  parseArguments,
  patchLocaFilesystemLoggingSource,
  patchLocaPythonExecuteSource,
  patchLocaPythonExecutableSource,
  patchLocaReactRetrySource,
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

  it('resolves a repo-relative --config path before falling back to the upstream cache', () => {
    const args = parseArguments(['--config', 'tests/performance/loca/configs/swe_flask5014.json'])
    expect(locaConfigSourcePath(args)).toBe(resolve('tests/performance/loca/configs/swe_flask5014.json'))
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

  it('patches python_execute to run scripts without uv and kill stuck process trees', () => {
    const source = [
      'import os',
      'import sys',
      '',
      'def get_workspace() -> str:',
      '    """Get the workspace directory from environment or use default."""',
      '    return os.environ.get("PYTHON_EXECUTE_WORKSPACE", DEFAULT_WORKSPACE)',
      '',
      '        # Ensure filename ends with .py',
      '        if not filename.endswith(".py"):',
      '            filename += ".py"',
      '',
      '        # Execute Python file',
      '        cmd = f"uv run --directory {agent_workspace} ./.python_tmp/{filename}"',
      '        try:',
      '            result = subprocess.run(',
      '                cmd,',
      '                shell=True,',
      '                capture_output=True,',
      '                text=True,',
      "                encoding='utf-8',",
      '                timeout=timeout',
      '            )',
      '        except subprocess.TimeoutExpired:',
      '            execution_time = time.time() - start_time',
      '            return f"=== EXECUTION TIMEOUT ===\\nExecution timed out after {timeout} seconds\\nExecution time: {execution_time:.3f} seconds"',
      '        output_parts = []',
      '        if result.stdout:',
      '            output_parts.append(result.stdout.rstrip())',
      '        if result.stderr:',
      '            output_parts.append(result.stderr.rstrip())',
    ].join('\n')

    const patched = patchLocaPythonExecuteSource(source)
    expect(patched).toContain('# Codey LOCA python_execute compatibility patch')
    expect(patched).toContain('        filename = os.path.basename(filename)')
    expect(patched).toContain('        cmd = [sys.executable, os.path.abspath(file_path)]')
    expect(patched).not.toContain('uv run')
    expect(patched).not.toContain('shell=True')
    expect(patched).toContain('# Codey LOCA python_execute timeout patch')
    expect(patched).toContain('def _kill_process_tree(process):')
    expect(patched).toContain("'taskkill', '/T', '/F', '/PID'")
    expect(patched).toContain('        if timeout > 30:')
    expect(patched).toContain('subprocess.Popen(')
    expect(patched).toContain('stdin=subprocess.DEVNULL,')
    expect(patched).toContain('_kill_process_tree(process)')
    expect(patched).toContain('# Codey LOCA python_execute output truncation patch')
    expect(patched).toContain('def _clip(text: str, limit: int = 2000) -> str:')
    expect(patched).toContain('output_parts.append(_clip(result.stdout.rstrip()))')
    expect(patched).toContain('output_parts.append(_clip(result.stderr.rstrip()))')
    expect(patchLocaPythonExecuteSource(patched)).toBe(patched)
  })

  it('upgrades an already timeout-patched source that still inherits the MCP stdin pipe', () => {
    const source = [
      'import os',
      'import sys',
      '',
      'def get_workspace() -> str:',
      '    """Get the workspace directory from environment or use default."""',
      '    return os.environ.get("PYTHON_EXECUTE_WORKSPACE", DEFAULT_WORKSPACE)',
      '',
      '        # Codey LOCA python_execute compatibility patch',
      '        filename = os.path.basename(filename)',
      '        cmd = [sys.executable, os.path.abspath(file_path)]',
      '        # Codey LOCA python_execute timeout patch',
      '        if timeout > 30:',
      '            timeout = 30',
      '        try:',
      '            process = subprocess.Popen(',
      '                cmd,',
      '                cwd=agent_workspace,',
      '                stdout=subprocess.PIPE,',
      '                stderr=subprocess.PIPE,',
      '            )',
      '        output_parts = []',
      '        if result.stdout:',
      '            output_parts.append(result.stdout.rstrip())',
      '        if result.stderr:',
      '            output_parts.append(result.stderr.rstrip())',
    ].join('\n')

    const patched = patchLocaPythonExecuteSource(source)
    expect(patched).toContain('                stdin=subprocess.DEVNULL,')
    expect(patched.indexOf('stdin=subprocess.DEVNULL')).toBeLessThan(patched.indexOf('stdout=subprocess.PIPE'))
    expect(patchLocaPythonExecuteSource(patched)).toBe(patched)
  })

  it('applies the timeout patch to a source that already carries the first patch', () => {
    const source = [
      'import os',
      'import sys',
      '',
      'def get_workspace() -> str:',
      '    """Get the workspace directory from environment or use default."""',
      '    return os.environ.get("PYTHON_EXECUTE_WORKSPACE", DEFAULT_WORKSPACE)',
      '',
      '        # Codey LOCA python_execute compatibility patch',
      '        filename = os.path.basename(filename)',
      '        cmd = [sys.executable, os.path.abspath(file_path)]',
      '        try:',
      '            result = subprocess.run(',
      '                cmd,',
      '                cwd=agent_workspace,',
      '                capture_output=True,',
      '                text=True,',
      "                encoding='utf-8',",
      '                timeout=timeout',
      '            )',
      '        except subprocess.TimeoutExpired:',
      '            execution_time = time.time() - start_time',
      '            return f"=== EXECUTION TIMEOUT ===\\nExecution timed out after {timeout} seconds\\nExecution time: {execution_time:.3f} seconds"',
      '        output_parts = []',
      '        if result.stdout:',
      '            output_parts.append(result.stdout.rstrip())',
      '        if result.stderr:',
      '            output_parts.append(result.stderr.rstrip())',
    ].join('\n')

    const patched = patchLocaPythonExecuteSource(source)
    expect(patched).toContain('# Codey LOCA python_execute timeout patch')
    expect(patched).toContain('def _kill_process_tree(process):')
    expect(patchLocaPythonExecuteSource(patched)).toBe(patched)
  })

  it('rejects an unexpected python_execute server source', () => {
    expect(() => patchLocaPythonExecuteSource('import os\nimport sys\n')).toThrow(
      'Unsupported LOCA python_execute compatibility patch format',
    )
    const missingHelper = [
      '        # Codey LOCA python_execute compatibility patch',
      '        filename = os.path.basename(filename)',
      '        cmd = [sys.executable, os.path.abspath(file_path)]',
      '        try:',
      '            result = subprocess.run(',
      '                cmd,',
      '                cwd=agent_workspace,',
      '                capture_output=True,',
      '                text=True,',
      "                encoding='utf-8',",
      '                timeout=timeout',
      '            )',
      '        except subprocess.TimeoutExpired:',
      '            execution_time = time.time() - start_time',
      '            return f"=== EXECUTION TIMEOUT ===\\nExecution timed out after {timeout} seconds\\nExecution time: {execution_time:.3f} seconds"',
    ].join('\n')
    expect(() => patchLocaPythonExecuteSource(missingHelper)).toThrow(
      'Unsupported LOCA python_execute timeout patch format',
    )
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

  it('bounds react invalid-response retries and tool calls per response', () => {
    const source = [
      'def make_aihubmix_api_request(messages, model_name, aihubmix_api_keys, aihubmix_api_url,',
      '                              tools=None, tool_choice=None, temperature=1.0, top_p=1.0,',
      '                              max_tokens=4096, max_context_size=None, context_awareness=False,',
      '                              reasoning_effort=None, reasoning_max_tokens=None,',
      '                              reasoning_enabled=True, reasoning_exclude=False,',
      '                              max_retries=200, verbose=False):',
      '    # Track retry attempts',
      '    times = 0',
      '',
      '    while times < max_retries:',
      '        try:',
      '            response = requests.post(',
      '                aihubmix_api_url,',
      '                headers=headers,',
      '                json=json_data,',
      '                timeout=60',
      '            )',
      '            if response.status_code == 200:',
      '                res = json.loads(response.text)',
      '                result = []',
      '                is_tool = False',
      '                should_retry = False',
      '',
      '                for choice in res[\'choices\']:',
      "                    finish_reason = choice.get('finish_reason', '')",
      '                    message = choice.get(\'message\', {})',
      "                    has_tool_calls = 'tool_calls' in message and message['tool_calls']",
      '',
      '                            if has_tool_calls:',
      '                                # Handle tool calls regardless of finish_reason',
      "                                result.extend(message.get('tool_calls', []))",
      '',
      '                    # If we should retry, continue to the next iteration',
      '                    if should_retry:',
      '                        times += 1',
      '                        continue',
      '',
      '        except Exception as e:',
      '            if verbose:',
      '                print(f"Request error: {e}")',
    ].join('\n')

    const patched = patchLocaReactRetrySource(source)
    expect(patched).toContain('# Codey LOCA react retry policy patch')
    expect(patched).toContain('class CodeyInvalidResponseError(RuntimeError):')
    expect(patched).toContain("os.environ.get('LOCA_REACT_MAX_INVALID_RETRIES', '3')")
    expect(patched).toContain("os.environ.get('LOCA_REACT_MAX_TOOL_CALLS_PER_RESPONSE', '32')")
    expect(patched).toContain('if len(message.get(\'tool_calls\', [])) > max_tool_calls_per_response:')
    expect(patched).toContain('invalid_times += 1')
    expect(patched).toContain('raise CodeyInvalidResponseError(')
    expect(patched).toContain('if isinstance(e, CodeyInvalidResponseError):')
    expect(patched).toContain('# Codey LOCA quota guard patch')
    expect(patched).toContain('quota_fatal = response.status_code in (402, 403)')
    expect(patched).toContain("quota_markers = ('insufficient', 'arrearage', 'billing', 'payment', 'quota', 'balance', '额度', '余额', '欠费', '充值')")
    expect(patched).toContain("timeout=max(60, int(os.environ.get('LOCA_REACT_REQUEST_TIMEOUT_SECONDS', '300'))),")
    expect(patched).toContain("if str(e).startswith('CodeyFatal:'):")
    expect(patched).not.toContain('                        times += 1')
    expect(patchLocaReactRetrySource(patched)).toBe(patched)
  })

  it('preserves CRLF line endings in the react retry patch', () => {
    const source = [
      '    # Track retry attempts',
      '    times = 0',
      '            response = requests.post(',
      '                aihubmix_api_url,',
      '                headers=headers,',
      '                json=json_data,',
      '                timeout=60',
      '            )',
      '                            if has_tool_calls:',
      '                                # Handle tool calls regardless of finish_reason',
      "                                result.extend(message.get('tool_calls', []))",
      '                    # If we should retry, continue to the next iteration',
      '                    if should_retry:',
      '                        times += 1',
      '        except Exception as e:',
      '            if verbose:',
      '                print(f"Request error: {e}")',
    ].join('\r\n')

    const patched = patchLocaReactRetrySource(source)
    expect(patched).toContain('# Codey LOCA react retry policy patch')
    expect(patched).toContain('# Codey LOCA quota guard patch')
    expect(patched).toContain('\r\n    invalid_times = 0')
    expect(patchLocaReactRetrySource(patched)).toBe(patched)
  })

  it('adds the quota guard to a runner source that already carries the retry patch', () => {
    const cached = [
      '    # Codey LOCA react retry policy patch: invalid responses get a bounded budget.',
      '    invalid_times = 0',
      '    while times < max_retries:',
      '        try:',
      '            response = requests.post(',
      '                aihubmix_api_url,',
      '                headers=headers,',
      '                json=json_data,',
      '                timeout=60',
      '            )',
      '            if response.status_code == 200:',
      '                pass',
      '        except Exception as e:',
      '            if isinstance(e, CodeyInvalidResponseError):',
      '                raise',
      '            if verbose:',
      '                print(f"Request error: {e}")',
    ].join('\n')

    const patched = patchLocaReactRetrySource(cached)
    expect(patched).toContain('# Codey LOCA quota guard patch')
    expect(patched).toContain('quota_fatal = response.status_code in (402, 403)')
    expect(patched).toContain('CodeyFatal: upstream rejected the request permanently')
    expect(patched).toContain("timeout=max(60, int(os.environ.get('LOCA_REACT_REQUEST_TIMEOUT_SECONDS', '300'))),")
    expect(patched).toContain("if str(e).startswith('CodeyFatal:'):")
    expect(patched).not.toContain('invalid_times += 1')
    expect(patchLocaReactRetrySource(patched)).toBe(patched)
  })

  it('upgrades a cached quota guard that still uses the hardcoded 60s read timeout', () => {
    const cached = [
      '    # Codey LOCA react retry policy patch: invalid responses get a bounded budget.',
      '    # Codey LOCA quota guard patch: fatal rejections abort immediately.',
      '    while times < max_retries:',
      '        try:',
      '            response = requests.post(',
      '                aihubmix_api_url,',
      '                headers=headers,',
      '                json=json_data,',
      '                timeout=60',
      '            )',
      '        except Exception as e:',
      '            if isinstance(e, CodeyInvalidResponseError):',
      '                raise',
      "            if str(e).startswith('CodeyFatal:'):",
      '                raise',
    ].join('\n')

    const patched = patchLocaReactRetrySource(cached)
    expect(patched).toContain("timeout=max(60, int(os.environ.get('LOCA_REACT_REQUEST_TIMEOUT_SECONDS', '300'))),")
    expect(patched).not.toContain('timeout=60')
    expect(patchLocaReactRetrySource(patched)).toBe(patched)
  })

  it('rejects an unexpected react runner source', () => {
    expect(() => patchLocaReactRetrySource('import requests\n')).toThrow(
      'Unsupported LOCA react retry policy patch format',
    )
  })
})

describe('LOCA context management configuration', () => {
  const marginEnvVars = ['LOCA_MAX_INPUT_TOKENS', 'RULER_MAX_INPUT_TOKENS'] as const
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

  it('rejects a --max-tokens that cannot fit inside the model window', () => {
    expect(() => contextConfig({ modelContextSize: 128_000, maxTokens: 131_072, maxTokensProvided: true })).toThrow(
      '--max-tokens (131072) must be smaller than --model-context-size (128000)',
    )
  })

  it('rejects a --max-tokens that cannot fit inside the benchmark context', () => {
    expect(() => parseArguments(['--max-context-size', '128000', '--max-tokens', '131072'])).toThrow(
      '--max-tokens (131072) must be smaller than --max-context-size (128000)',
    )
  })

  it('defaults the non-smoke output window to the glm-5.3 output window', () => {
    expect(parseArguments([]).maxTokens).toBe(131_072)
    expect(parseArguments(['--smoke']).maxTokens).toBe(256)
  })

  it('leaves max input tokens unset (runtime derivation) by default', () => {
    expect(contextConfig({ modelContextSize: 4_096, maxTokens: 256, maxTokensProvided: false }).maxInputTokens).toBe(0)
    expect(contextConfig({ modelContextSize: 128_000, maxTokens: 4_096, maxTokensProvided: false }).maxInputTokens).toBe(0)
  })

  it('prefers an explicit LOCA_MAX_INPUT_TOKENS override and clamps it to the window', () => {
    process.env.LOCA_MAX_INPUT_TOKENS = '2048'
    expect(contextConfig({ modelContextSize: 4_096, maxTokens: 256, maxTokensProvided: true }).maxInputTokens).toBe(2_048)
    expect(contextConfig({ modelContextSize: 128_000, maxTokens: 4_096, maxTokensProvided: false }).maxInputTokens).toBe(2_048)
  })

  it('rejects a non-numeric or negative LOCA_MAX_INPUT_TOKENS instead of producing NaN', () => {
    process.env.LOCA_MAX_INPUT_TOKENS = 'wat'
    expect(() => contextConfig({ modelContextSize: 4_096, maxTokens: 256, maxTokensProvided: true })).toThrow(
      'LOCA_MAX_INPUT_TOKENS must be a non-negative number',
    )
    process.env.LOCA_MAX_INPUT_TOKENS = '-1'
    expect(() => contextConfig({ modelContextSize: 4_096, maxTokens: 256, maxTokensProvided: true })).toThrow(
      'LOCA_MAX_INPUT_TOKENS must be a non-negative number',
    )
  })

  it('never sets max input tokens above the model window', () => {
    process.env.LOCA_MAX_INPUT_TOKENS = '999999'
    const config = contextConfig({ modelContextSize: 200, maxTokens: 100, maxTokensProvided: true })
    expect(config.maxInputTokens).toBe(200)
  })
})
