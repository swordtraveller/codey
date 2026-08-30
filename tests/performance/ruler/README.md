# RULER performance subset

This directory contains a small, remote-model performance harness for Codey's context-management strategies. It is intentionally not embedded in the Electron runtime and does not vendor RULER source, models, datasets, or Python environments.

The initial task subset is:

- `niah_single`: single hidden-value retrieval.
- `niah_multi`: ordered multi-value retrieval.
- `variable_tracking`: simple state-update tracking.

These tasks exercise context retention and are a lightweight adapter, not a claim of full official RULER coverage. The evaluator sends the managed context to an OpenAI-compatible `/chat/completions` endpoint and records correctness, token counts, compression, context-build time, Rhai time, remote latency, and overflow status.

## Run

Set the remote model configuration in the shell; do not commit the API key:

```powershell
$env:RULER_BASE_URL = "https://api.example.com/v1"
$env:RULER_API_KEY = "your-key"
$env:RULER_MODEL = "your-model"
pnpm test:performance:ruler:smoke
```

The full entry point runs three samples for each task by default:

```powershell
pnpm test:performance:ruler
```

Useful options:

```powershell
pnpm test:performance:ruler:smoke -- --task niah_single --samples 1
pnpm test:performance:ruler:smoke -- --rhai-script tests/performance/ruler/example-strategy.rhai
pnpm test:performance:ruler -- --filler-items 512 --output tests/performance/results/manual.json
```

The built-in policy is always evaluated. A Rhai policy is evaluated when `--rhai-script` is provided. Results are JSON files under the ignored `tests/performance/results/` directory unless `--output` is specified.

Optional context settings use `RULER_*` environment variables, including `RULER_MODEL_MAX_CONTEXT`, `RULER_SAFE_OUTPUT_MARGIN`, `RULER_HOT_TOKEN_BUDGET`, `RULER_WARM_TOKEN_BUDGET`, and `RULER_COLD_RECALL_TOKEN_BUDGET`.
