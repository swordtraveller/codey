# Tests

Install dependencies with `pnpm install` before running tests.

| Command | Scope |
| --- | --- |
| `pnpm test:regression` | Key user flows: fixture typecheck, focused Vitest suites, and three Chromium checks. Stops on the first failed step. |
| `pnpm test:settings` | Project and conversation settings hooks in Chromium. |
| `pnpm test` | Full Vitest suite. |
| `pnpm typecheck` | Application TypeScript checks. |

The regression command covers:

- Workspace persistence, lazy history loading, settings changes before loading history, restart recovery, and failed atomic writes without history loss.
- Agent tool budgets, cancellation of tool batches, continued execution with paired tool calls/results, tool failures, model configuration and failover, command review, and context management.
- Project and conversation settings: inheritance, overrides, validation, cancellation, interaction locks, failure/retry, scope selection, and saving to the original conversation after switching views.
- Conversation rendering: bounded mounted elements, long-history scrolling, reading anchors, pagination, lazy tool details, and read receipts.
- Todo/DAG tools, message navigation, code snapshots, architecture-node navigation to the owning conversation, diagram scrolling, and rendering fallback.

Renderer checks run real React code in Chromium using the installed Electron runtime. Model responses and settings IPC are mocked; persistence tests use isolated temporary files. These checks do not call a remote model API and are not a full end-to-end test of the installed application.

Build output and test logs are placed under the ignored `.agent_tmp/` directory; persistence fixtures are cleaned up by their tests. Existing shell-integration cases may be skipped when their required runtime is unavailable. Optional external performance harnesses are documented separately under [performance](performance/).
