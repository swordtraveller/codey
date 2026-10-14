# 工程架构图与代码快照

第一版使用助手消息中的 `architecture` JSON 代码块，不新增工具调用或 Mermaid 依赖。AI 使用现有文件、搜索和 LSP 工具研读代码，输出节点及关系。主进程和渲染进程共享同一格式校验器。

## 示例

下面的 `root` 必须替换为系统提示中项目目录列表的实际 folder ID，行号必须来自已读取的文件。

````markdown
```architecture
{
  "title": "消息展示与代码阅读",
  "nodes": [
    {
      "id": "messages",
      "label": "消息展示",
      "description": "展示助手回复与代码引用",
      "source": {
        "root": "project-folder-id",
        "path": "src/renderer/src/App.tsx",
        "startLine": 1,
        "endLine": 20
      }
    },
    { "id": "snapshot", "label": "代码快照", "description": "引用文件在消息保存时的内容" }
  ],
  "edges": [{ "from": "messages", "to": "snapshot", "label": "打开引用" }]
}
```
````

## 约定

- 代码块放在消息顶层；支持反引号和波浪号围栏，不嵌套在列表、引用或示例代码块中。
- 必填 `nodes`、`edges`，可选 `title`（最长 160 字符）。每图 1–60 个节点、最多 120 条边，JSON 最长 64,000 字符。
- 节点必填唯一 `id`（1–64 个 ASCII 字母、数字、下划线或连字符）及 `label`（最长 120 字符），可选 `description`（最长 500 字符）和一个 `source`。
- `source.root` 为项目目录 ID，`source.path` 为不做 URL 编码的相对 POSIX 路径。行号从 1 开始、范围含两端；可省略范围以打开整个文件，填写 `endLine` 必须同时填写 `startLine`。
- 无 `source` 的节点为概念节点，不提供跳转。路径、根目录、文件类型、文件大小和实际行范围仍由快照层校验。
- 边必填 `from`、`to`，可选 `label`（最长 80 字符）。箭头从调用方/导入方/发送方指向依赖方/接收方。支持循环、自引用和独立模块；相同方向的重复边合并说明。
- 架构图没有任务执行状态或强制起终点。复杂工程应拆成多张聚焦的图；第一版不支持分组容器、拖拽编辑、多代码位置或增量维护。

## 保存与交互

代码引用转换为已有 `codey://coderead/text` 链接，与普通引用一起去重、保存。节点点击使用项目、会话、助手消息和规范化链接打开已有代码阅读窗口；主进程再次核对消息归属。源文件后来改变，不影响已保存的快照。文件读取失败时保留错误，点击后展示原因，不改为读取当前文件。

图形从左到右分层，循环组件放在同一层。画布使用原生滚动条；长节点文字可悬停查看，完整边说明可在“关系明细”展开。未保存消息的节点禁用跳转。无效 JSON 保留原始内容并显示错误，不执行模型提供的 HTML、脚本或回调。

图形共享 `GraphCanvas` 的滚动、SVG 连线和箭头实现，但与任务 DAG 使用独立数据模型和布局。

## 验证

- `pnpm test -- tests/architecture.test.ts tests/code-reading.test.ts tests/code-reading-window.test.ts src/renderer/src/components/architecture-layout.test.ts src/main/dag-tool.test.ts`
- `node scripts/test-architecture-rendering.mjs`：隐藏 Electron 窗口检查真实组件的渲染、节点打开参数、滚动、错误回退和 DAG 回归；查看器调用使用桩，不向模型发送请求。
- `pnpm build`
