# TaskRun 事件与 Todo（第一版）

## 任务和执行

- `taskId` 标识逻辑任务。普通用户输入创建新任务，Todo 初始为空。
- `runId` 标识一次执行。点击“继续”产生新的执行，通过 `continuedFromRunId` 关联前次执行，沿用 `taskId` 和 Todo。
- “继续”通过明确的 `continueFromMessageId` 关联最后一条用户消息，不根据消息文字猜测。旧会话没有事件记录时，从当前执行建立任务记录。
- `normal` 只表示执行正常结束，不代表目标已完成或验证通过；验证结果单独记录。

## 单一 todo 工具

工具参数为 JSON 对象：

```json
{"action":"get"}
{"action":"add","name":"实现接口"}
{"action":"set","updates":{"todo_<id>":{"status":"finished"}}}
{"action":"del","id":"todo_<id>"}
```

状态：`pending`、`in_progress`、`finished`、`blocked`、`skipped`。
使用 add/get 返回的稳定 ID 更新或删除，允许名称重复。名称为 1–160 个字符，最多 100 条待办。set 整批校验后应用，任一项无效则整批不变。

工具每次返回 `todo-snapshot`，包含 `version`、`success`、`action`、`items`、`changes`，失败时附带 `error`。参数错误也记录当前快照。写入日志成功后才确认状态修改。

每张 Todo 工具卡片展示调用当时的快照；删除项保留在该次 changes 中。最新快照默认展开，展开另一张会收起先前卡片。展开状态由会话列表上层维护，不因单行虚拟化卸载而丢失。专属工具卡片统一经 `renderSpecializedToolCard` 分派，后续可增加其他工具的展示。

## 事件日志

每个会话在其 JSON 文件旁追加 `.task-runs.jsonl` 日志。事件具有 `version: 1`、`id`、`runId`、`sequence` 和 `at`；序号在会话内递增。

当前事件：`run-started`、`run-finished`、`model-call`、`tool-call`、`approval`、`validation`、`todo-snapshot`。
模型重试和模型切换按实际请求记录不同的 callId。工具停止记录 cancelled。审批与 node_validate 验证结果独立记录。

日志串行写入；重开时校验事件结构和序号。日志损坏会拒绝继续追加，写入失败会终止当前执行并保留已有文件，不自动覆盖或修复。进程崩溃可能留下没有结束事件的执行，本版不自动推断其最终结果。

## 实现边界

本版提供事件基础和 Todo 可见面板，尚不包含 DAG、会话历史导航、任务详情面板、日志导出入口或统计分析。事件日志也不是完整模型请求/响应归档；排查完整上下文仍需结合会话历史。

验证包括工具与日志单元测试、模拟模型的事件集成测试、生产构建以及真实 Todo 组件的浏览器交互检查；尚未完成真实模型驱动的完整 Electron 端到端验收。
