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
