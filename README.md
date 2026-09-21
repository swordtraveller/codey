# codey

An open, functional desktop agent app for conversation, work and coding.  

<img src="docs/assets/codey_conversation_screenshot.png" style="width: 60dvw; height: auto;" />

## Highlights

### Multimodal Capabilities (Image Input) and Web‑Search Agent Tools

<img src="docs/assets/codey_conversation_image_input_screenshot.png" style="width: 60dvw; height: auto;" />

<small>The uploaded image in the demo above is sourced from: <a target="_blank" href="https://commons.wikimedia.org/wiki/File:Starry_Night_Over_the_Rhone.jpg">commons.wikimedia.org/wiki/File:Starry_Night_Over_the_Rhone.jpg</a>. Per the statement on the linked page, this image is in the public‑domain and is used in this project for demonstration purposes.</small>

### Layered Context‑Management Strategy and Context Debugger

<img src="docs/assets/codey_context_debugger_screenshot.png" style="width: 60dvw; height: auto;" />

### Agent Keeps Running Even When the Device Is Asleep

<img src="docs/assets/codey_keep_computer_awake_screenshot.png" style="width: 60dvw; height: auto;" />

### Freedom to Choose Model Providers and Models

<img src="docs/assets/codey_add_model_config_screenshot.png" style="width: 60dvw; height: auto;" />

### Write Your Preferred Context‑Management Strategies in Rhai

<img src="docs/assets/codey_rhai_screenshot.png" style="width: 60dvw; height: auto;" />

## MCP and agent-lsp

Codey can connect to user-installed MCP servers over stdio. To use Python language intelligence through [agent-lsp](https://github.com/blackwell-systems/agent-lsp):

1. Install `agent-lsp` using its [official instructions](https://www.agent-lsp.com/getting-started/installation/) and ensure `agent-lsp` is on `PATH`. One supported option is `npm install -g @blackwell-systems/agent-lsp`.
2. Install a Python language server, for example `npm install -g pyright`.
3. Run `agent-lsp doctor` to verify the local setup.
4. In Codey, open **Settings → MCP**, choose **Add agent-lsp**, test the connection, enable the server, and save settings.
5. Open a Python project and ask the Agent to use the available language-intelligence tools.

The preset uses the `agent-lsp` command with no arguments, so agent-lsp auto-detects language servers on `PATH`. Use the arguments field for an explicit server selection such as `python:pyright-langserver,--stdio`.

If `start_lsp` reports `daemon: broker did not start within 30s`, changing `ready_timeout_seconds` or path separators will not fix that startup stage. Check the installed agent-lsp version (v0.12.0 fixed a known Windows broker-spawn path issue), inspect `~/.cache/agent-lsp/spawn-logs/<language>.log`, and upgrade or fix the broker error before calling tools that require an initialized LSP client. `AGENT_LSP_BROKER_TIMEOUT_MS` can extend the broker wait in the MCP server environment, but a longer wait may only mask an actual startup failure.

## Development

```bash
pnpm install
pnpm dev
```

## Build

```bash
pnpm build
```

## Packaging

```bash
pnpm dist
```

Build artifacts are written to `dist/`.


## Public deployment

Use the Compose deployment package in [docker/README.md](docker/README.md).

## Performance evaluation

LOCA-bench and RULER are optional external performance harnesses. They run outside Electron with developer-local dependencies and remote OpenAI-compatible models; see [tests/performance/loca/README.md](tests/performance/loca/README.md) and [tests/performance/ruler/README.md](tests/performance/ruler/README.md).
