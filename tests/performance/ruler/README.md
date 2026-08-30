# RULER performance subset

This directory contains a small remote-model performance harness for Codey's context-management strategies. It runs outside the Electron runtime and does not vendor RULER source, datasets, models, or Python environments.

The adapter supports two modes:

- **Codey subset**: the existing lightweight tasks `niah_single`, `niah_multi`, and `variable_tracking`.
- **Official-compatible subset**: official-style generation, tokenizer selection, deterministic seed, and scoring semantics for `niah_single`, `niah_multivalue`, and `variable_tracking`.

The official-compatible mode is intentionally lightweight. It does not embed the full official NeMo-Skills/vLLM evaluation stack or copy the upstream dataset byte-for-byte. It generates deterministic official-style cases locally, projects the generated input into Codey's context messages, runs the selected built-in or Rhai strategy, and sends the managed context to an OpenAI-compatible remote endpoint. This lets the benchmark measure Codey's context strategy while retaining comparable RULER task semantics.

## Run

Set the remote model configuration in the shell; never commit the API key:

```powershell
$env:RULER_BASE_URL = "https://api.example.com/v1"
$env:RULER_API_KEY = "your-key"
$env:RULER_MODEL = "your-model"
pnpm test:performance:ruler:smoke
```

The full Codey-subset entry point runs three samples for each task by default:

```powershell
pnpm test:performance:ruler
```

Run the official-compatible subset with the same remote model:

```powershell
pnpm test:performance:ruler:official:smoke
pnpm test:performance:ruler:official
```

The official-compatible mode supports these tasks:

```text
niah_single, niah_multivalue, variable_tracking
```

Useful options:

```powershell
pnpm test:performance:ruler:official:smoke -- --task niah_single --samples 1 --max-len 4096
pnpm test:performance:ruler:official -- --max-len 131072 --tokens-to-generate 1024 --seed 42 --tokenizer cl100k_base
pnpm test:performance:ruler:official -- --rhai-script tests/performance/ruler/example-strategy.rhai
pnpm test:performance:ruler -- --filler-items 512 --output tests/performance/results/manual.json
```

`--max-len` is the target total token budget for the generated input plus the requested output reservation. `--tokens-to-generate` is subtracted from that target when creating the input. The default seed is `42`; supported tokenizers are `cl100k_base` and `o200k_base`, with `cl100k_base` as the default. Larger targets, including million-token cases, are intended for developer-local runs only and may consume substantial memory, time, and remote-model quota.

The built-in policy is always evaluated. A Rhai policy is evaluated in addition to it when `--rhai-script` is supplied. Results are JSON files under the ignored `tests/performance/results/` directory unless `--output` is specified.

## Context settings

The script accepts these optional environment variables:

```powershell
$env:RULER_MODEL_MAX_CONTEXT = "1048576"
$env:RULER_SAFE_OUTPUT_MARGIN = "131072"
$env:RULER_HOT_TOKEN_BUDGET = "64000"
$env:RULER_WARM_TOKEN_BUDGET = "32000"
$env:RULER_COLD_RECALL_TOKEN_BUDGET = "8000"
$env:RULER_TIMEOUT_MS = "120000"
$env:RULER_MAX_OUTPUT_TOKENS = "1024"
$env:RULER_LAYERED = "true"
$env:RULER_TOKENIZER = "cl100k_base"
```

Set `RULER_LAYERED=false` to compare with the non-layered context path. To evaluate a user strategy, pass a Rhai file with `--rhai-script`; the script is loaded locally and is not sent as a remote code artifact.

## Local-only artifacts

The upstream RULER source may be cached under `tests/performance/.cache/ruler-upstream/` for developer reference. It is ignored and must not be committed. Do not commit upstream source, generated datasets, model weights, Python environments, API keys, or benchmark results. The lightweight adapter itself is TypeScript in `src/main/ruler-official.ts`.
