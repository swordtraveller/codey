# LOCA-bench performance adapter

Codey runs LOCA-bench as an external, optional performance test. The Electron application does **not** package LOCA-bench, Python, datasets, model weights, or LOCA dependencies.

## Prepare the local evaluator

The upstream checkout is expected at the ignored path `tests/performance/.cache/loca-upstream/`. Create an isolated Python 3.10–3.12 environment inside that directory and install LOCA there:

```powershell
cd tests/performance/.cache/loca-upstream
uv python install 3.12
uv venv --python 3.12 .venv
uv pip install --python .\.venv\Scripts\python.exe -e .
```

`--install` repeats only the editable install in this environment. It never invokes host Python or modifies Codey's dependencies. The checkout, virtual environment, datasets, and results are all ignored by Git.

## Run with a remote OpenAI-compatible model

```powershell
$env:LOCA_BASE_URL = "https://api.example.com/v1"
$env:LOCA_API_KEY = "your-key"
$env:LOCA_MODEL = "your-model"
pnpm test:performance:loca:smoke
```

Default mode runs LOCA tasks through a small local HTTP proxy. Before forwarding each OpenAI-compatible request, the proxy applies Codey's built-in Hot/Warm/Cold context manager. LOCA still owns task generation, tool execution, trajectory recording, and scoring.

A smoke run deliberately selects **one** `ABTestingS2LEnv` configuration (or the first configuration if that task is absent), uses one worker, and has a five-minute overall watchdog. It therefore does not accidentally run the upstream `final_8k_set_config.json` set of 75 configurations.

Choose a task explicitly:

```powershell
pnpm test:performance:loca:smoke -- `
  --task ABTestingS2LEnv `
  --samples 1 `
  --max-context-size 8192 `
  --model-context-size 128000 `
  --max-tokens 256 `
  --timeout 120 `
  --total-timeout 300
```

## Long-context filesystem fixture

To exercise Codey context management rather than only the tool loop, add `--long-context` to the filesystem-only smoke run. The fixture injects a compact, deterministic background observation before the two-call write/claim task. `--fixture-context-tokens` controls the approximate number of filler tokens (one filler word ≈ one token).

The safe output margin no longer needs an override: when `--max-tokens` is passed explicitly the margin binds to it (256 below), and otherwise it scales with the window (`window / 8`, capped at the 16k default). Do not set `LOCA_SAFE_OUTPUT_MARGIN` unless you really want a manual override.

### Baseline (context management passes through, no compression)

```powershell
pnpm test:performance:loca:smoke -- `
  --filesystem-only `
  --long-context `
  --fixture-context-tokens 300 `
  --samples 1 `
  --max-context-size 4096 `
  --model-context-size 4096 `
  --max-tokens 256 `
  --timeout 180 `
  --total-timeout 300
```

Expected: accuracy 1.0 with two tool calls; every `codey-context-trace.jsonl` entry reports `compressionRatio` 1 (input stays under the trigger threshold, so nothing is compressed).

### Layered strategy under pressure (demotion actually fires)

The layered demotion of completed tool rounds only triggers when the hot budget is exceeded, so cap it between the two rounds with `LOCA_HOT_TOKEN_BUDGET`:

```powershell
$env:LOCA_HOT_TOKEN_BUDGET = '5550'
pnpm test:performance:loca:smoke -- `
  --filesystem-only `
  --long-context `
  --fixture-context-tokens 5300 `
  --samples 1 `
  --max-context-size 8192 `
  --model-context-size 8192 `
  --max-tokens 256 `
  --timeout 180 `
  --total-timeout 300
Remove-Item Env:LOCA_HOT_TOKEN_BUDGET -ErrorAction SilentlyContinue
```

Expected: the first request passes uncompressed; from the second request on, `compressedTokens < originalTokens` in the trace (ratio ≈ 1.02) — the completed tool round is demoted to the warm layer. Accuracy usually drops to 0 because the model loses sight of its completed write; that accuracy cost is exactly what this fixture measures. Note that LOCA's own harness trimming runs on top of the proxy (see `Avg API Tokens (+Trim)`), so proxy compression is only part of the total savings.

This fixture is deliberately limited to `filesystem` and `claim_done`; it does not represent LOCA's full multi-service task set.

## SWE-bench coding task (repo fix)

`tests/performance/loca/fixtures/swe_repo_fix.py` wraps a SWE-bench Verified instance as a deterministic coding task: the agent receives the original issue text (`problem_statement`) plus a repository snapshot and must fix it by editing `src/` only. Judging is binary — `resolved = 1` iff every baseline file outside `src/` is byte-identical (hash check), all fail-to-pass tests turn green, and all pass-to-pass tests stay green after the hidden test patch is applied at grading time. `info.failure_reason` distinguishes `pass | f2p | p2p | tampered`.

Materials never enter git (license-safe pattern): a fetch script builds everything into the ignored `tests/performance/.cache/swe-materials/<instance_id>/` — repo snapshot at `base_commit`, a pinned dependency venv (the "era recipe", e.g. pytest 8.x + werkzeug 2.3.8 for the flask instance on Python 3.12), the hidden test patch, and the gold patch used only for offline validation.

```powershell
# 1) prepare + offline red/green validation (no model involved)
npx tsx scripts/swe-bench-prepare.ts --instance pallets__flask-5014 --verify

# 2) run one seed with its own per-task timeout (recommended: one invocation per seed
#    so a slow seed cannot starve the others; timeout counts as a failed seed)
pnpm test:performance:loca -- `
  --config tests/performance/loca/configs/swe_flask5014.json `
  --samples 1 `
  --max-context-size 128000 `
  --model-context-size 128000 `
  --max-tokens 1024 `
  --max-workers 1 `
  --timeout 600 `
  --total-timeout 1800 `
  --output tests/performance/results/swe-A-layered
```

A `run_tests.py` helper is placed next to the repo copy so the agent can run the pinned test environment (`python run_tests.py tests/ -q`). Adding another instance requires a recipe entry in `scripts/swe-bench-prepare.ts` and a small config JSON.

## Filesystem-only verification

Some upstream LOCA configurations require service-specific MCP servers (for example Canvas, email, Excel, or cloud backends). Those tasks are unsuitable for a quick verification of Codey's context proxy because a missing or incompatible external service can consume the full task timeout before the model reaches a meaningful step.

Use `--filesystem-only` for the narrow integration check. Without an explicit `--config`, Codey uses the repository's small deterministic `CodeyFilesystemOnly` fixture: the model must make one `filesystem_write_file` call to write the exact value to `answer.txt`, then call the exposed `claim_done_claim_done` completion tool. The fixture starts only the `filesystem` and `claim_done` MCP servers, so a successful result demonstrates the remote model → Codey proxy → LOCA tool loop without Canvas, email, Excel, or other external services.

```powershell
$env:LOCA_API_KEY = "your-key"
$env:LOCA_BASE_URL = "https://api.example.com/v1"
$env:LOCA_MODEL = "your-model"
$env:LOCA_MODEL_MAX_CONTEXT = "1000000"
pnpm test:performance:loca:smoke -- `
  --filesystem-only `
  --samples 1 `
  --max-context-size 8192 `
  --max-tokens 256 `
  --timeout 120 `
  --total-timeout 300
```

If `--config` is supplied, Codey filters only that config. A requested `--task` that enables another MCP server fails before LOCA starts and lists the unsupported server types; it is never silently substituted with the fixture. This mode is an integration smoke test, **not** a substitute for evaluating Codey on LOCA's complete multi-service task set.

Evaluate a user Rhai strategy instead:

```powershell
pnpm test:performance:loca:smoke -- `
  --strategy rhai `
  --rhai-script tests/performance/ruler/example-strategy.rhai
```

Run upstream LOCA without Codey interception:

```powershell
pnpm test:performance:loca:official:smoke
```

## Options

```text
--config <path>             LOCA config, relative to the upstream checkout by default
--task <name>               Match a task name or its env-class suffix, case-insensitively
--samples <n>               Keep the first n selected configurations
--strategy builtin|rhai     Codey context strategy used by the proxy
--rhai-script <path>        Local Rhai script; required for the rhai strategy
--max-context-size <n>      LOCA benchmark task context limit for this run
--model-context-size <n>    Actual remote model context window used by Codey proxy
--max-tokens <n>            Maximum output tokens per request
--max-workers <n>           LOCA parallel workers; smoke defaults to 1
--timeout <seconds>         Per remote-model request timeout used by LOCA
--total-timeout <seconds>   Wrapper watchdog; on Windows it stops the LOCA process tree
--output <directory>        Ignored result directory
--install                   Install LOCA into its local .venv before running
--official                  Disable the Codey proxy and use LOCA's own strategy
--filesystem-only           Permit only filesystem/claim_done; defaults to Codey's small local fixture
--long-context              Use the deterministic long-context filesystem fixture
--fixture-context-tokens <n> Approximate filler tokens for --long-context
```

`--task` and `--samples` create an `effective-config.json` beneath the run output; the upstream config is never changed. With `--task`, samples are selected from that task. With `--samples` alone, the first n configurations from the whole config are retained.

A zero process exit code alone is not treated as success. Codey requires a readable `results.json` with at least one successful task; otherwise the command exits nonzero and points to the task trajectories. This avoids reporting success when LOCA catches task errors internally.

## Context settings

`--max-context-size` controls LOCA's benchmark task limit only. The Codey proxy uses the remote model's real context window, configured independently by `--model-context-size`, `LOCA_MODEL_MAX_CONTEXT`, or the compatible `RULER_MODEL_MAX_CONTEXT` variable (in that order); it defaults to Codey's 128,000-token model default. For a 1M-context model, use for example:

```powershell
$env:LOCA_MODEL_MAX_CONTEXT = "1000000"
pnpm test:performance:loca:smoke -- --max-context-size 8192
```

This separation is important: an 8,192-token smoke workload is not evidence that the remote model itself has only an 8,192-token context. Context budgets use `LOCA_*` variables and fall back to their `RULER_*` equivalents where practical:

```powershell
$env:LOCA_SAFE_OUTPUT_MARGIN = "1024"
$env:LOCA_HOT_TOKEN_BUDGET = "4096"
$env:LOCA_WARM_TOKEN_BUDGET = "2048"
$env:LOCA_COLD_RECALL_TOKEN_BUDGET = "512"
$env:LOCA_LAYERED = "true"
```

Results and proxy traces are written under the ignored `tests/performance/results/` directory. The trace records timing and context metrics only, never API keys. Large configurations can consume substantial memory, remote-model quota, time, and disk space; million-token runs are developer-local experiments.
