import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { CodeReadMarkdown } from '../../../src/renderer/src/components/CodeReadMarkdown'
import { DagPanel } from '../../../src/renderer/src/components/DagToolCard'
import { setAppLanguage } from '../../../src/renderer/src/i18n'
import type { ArchitectureGraph } from '../../../src/shared/architecture'
import '../../../src/renderer/src/styles.css'

const root = createRoot(document.getElementById('root')!)
const requests: unknown[][] = []
let rejectOpen = false
Object.assign(window, { IS_REACT_ACT_ENVIRONMENT: true, codey: {
  openCodeRead: async (...args: unknown[]) => { requests.push(args); if (rejectOpen) throw Error('Snapshot unavailable') },
} })
function assert(value: unknown, message: string): asserts value { if (!value) throw Error(message) }
const graph: ArchitectureGraph = {
  title: 'Codey · 代码阅读架构',
  nodes: [
    { id: 'agent', label: 'Agent 回复', description: '读取项目并描述架构', source: { root: 'folder one', path: 'src/模块.ts', startLine: 3, endLine: 8 } },
    { id: 'snapshot', label: '代码快照', description: '保存引用文件的原始内容' },
    { id: 'renderer', label: '消息与架构图', description: '展示模块与依赖关系' },
    { id: 'viewer', label: '代码文本查看器', source: { root: 'folder two', path: 'viewer.tsx', startLine: 20 } },
    { id: 'project', label: '项目目录', description: '多个独立的项目根目录' },
  ],
  edges: [{ from: 'agent', to: 'snapshot', label: '保存引用' }, { from: 'snapshot', to: 'renderer', label: '完成消息' },
    { from: 'renderer', to: 'viewer', label: '打开快照' }, { from: 'viewer', to: 'renderer', label: '返回查看' },
    { from: 'agent', to: 'viewer', label: '引用范围' }, { from: 'viewer', to: 'viewer', label: '定位行号' }],
}
const fence = (value: unknown) => '```architecture\n' + JSON.stringify(value) + '\n```'
const content = '# 工程架构\n\n以下节点引用已研读的源码。\n\n' + fence(graph) + '\n\n[普通代码链接](codey://coderead/text?root=folder%20one&path=src%2F%E6%A8%A1%E5%9D%97.ts#L3-L8)'
async function render(saved = true, value = content) {
  await act(async () => root.render(<div style={{ width: 600 }} className="message-card"><CodeReadMarkdown content={value} {...(saved ? { projectId: 'p', conversationId: 'c', messageId: 'm' } : {})} /></div>))
}
async function runTests() {
  await setAppLanguage('zh-CN')
  await render()
  assert(document.querySelectorAll('.architecture-node').length === 5, 'All architecture nodes must render')
  assert(document.querySelectorAll('.architecture-panel svg marker').length === 1, 'Arrow marker is present')
  const viewport = document.querySelector<HTMLElement>('.architecture-panel .dag-viewport')!
  assert(viewport.scrollWidth > viewport.clientWidth, 'Narrow panels must overflow internally')
  viewport.scrollLeft = 140
  assert(viewport.scrollLeft === 140, 'Native horizontal scrolling must work')
  assert(document.documentElement.scrollWidth === document.documentElement.clientWidth, 'No document-level horizontal overflow')
  const button = document.querySelector<HTMLButtonElement>('.architecture-node button')!
  await act(async () => button.click())
  assert(JSON.stringify(requests[0]) === JSON.stringify(['p','c','m','codey://coderead/text?root=folder%20one&path=src%2F%E6%A8%A1%E5%9D%97.ts#L3-L8']), 'Node click must use canonical source and message owner')
  const link = document.querySelector<HTMLAnchorElement>('a')!
  await act(async () => link.click())
  assert(JSON.stringify(requests[1]) === JSON.stringify(requests[0]), 'Ordinary citation and graph must share viewer entry')
  rejectOpen = true
  await act(async () => button.click())
  assert(document.querySelector('[role=alert]')?.textContent?.includes('Snapshot unavailable'), 'Snapshot failure must be visible')
  rejectOpen = false
  await render(false)
  assert([...document.querySelectorAll<HTMLButtonElement>('.architecture-node button')].every((item) => item.disabled), 'Unsaved nodes must not navigate')
  await render(true, '```architecture\ninvalid\n```')
  assert(document.querySelector('.architecture-invalid pre')?.textContent === 'invalid', 'Invalid JSON must remain readable')
  await render(true, '````markdown\n' + fence(graph) + '\n````')
  assert(!document.querySelector('.architecture-panel'), 'Example code fences must not render graphs')
  await render(true, fence({ nodes: [{ id: 'safe', label: '<img src=x onerror=alert(1)>' }], edges: [] }))
  assert(!document.querySelector('img'), 'Model labels must be escaped')
  await act(async () => root.render(<div style={{ width: 600 }}><DagPanel snapshot={{kind:'dag-snapshot',version:1,success:true,action:'set',readyNodeIds:['a'],nodes:[
    {id:'a',name:'任务 A',status:'pending',dependsOn:[]}, {id:'b',name:'任务 B',status:'finished',dependsOn:['a']}
  ]}} /></div>))
  assert(document.querySelectorAll('.dag-node').length === 4, 'DAG retains start/task/end nodes')
  assert(document.querySelector('.dag-node.dag-status-finished'), 'DAG retains status styling')
  const dag = document.querySelector<HTMLElement>('.dag-viewport')!
  dag.scrollLeft = 60
  assert(dag.scrollLeft === 60, 'DAG remains scrollable')
  await render(true, content + '\n\n' + fence({ nodes: [{id:'single',label:'另一个图'}],edges:[] }))
  const ids = [...document.querySelectorAll('marker')].map((marker) => marker.id)
  assert(new Set(ids).size === 2, 'Multiple graphs need independent arrow IDs')
  return { passed: true, nodeNavigation: true, immutableOwnerArguments: requests[0], scrolling: true, fallback: true, dagRegression: true }
}
Object.assign(window, { runTests })
