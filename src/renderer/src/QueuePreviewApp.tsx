import { Fragment, useEffect, useLayoutEffect, useReducer, useRef, useState } from 'react'
import { Button, FluentProvider, Textarea, webLightTheme } from '@fluentui/react-components'
import { QueuedMessageList } from './components/QueuedMessageList'
import { createQueuePreviewState, queuePreviewReducer } from './queue-preview-state'

export function QueuePreviewApp(): React.JSX.Element {
  const [{ queue, turns }, dispatch] = useReducer(queuePreviewReducer, undefined, createQueuePreviewState)
  const [draft, setDraft] = useState('')
  const [expanded, setExpanded] = useState(true)
  const running = turns.at(-1)?.running ?? false
  const conversationRef = useRef<HTMLElement>(null)
  const trayRef = useRef<HTMLElement>(null)
  const followLatestRef = useRef(true)
  const [safeBottom, setSafeBottom] = useState(24)

  const measureTray = (): void => {
    const height = trayRef.current?.getBoundingClientRect().height ?? 0
    setSafeBottom(height > 0 ? height + 24 : 24)
  }

  useLayoutEffect(() => {
    measureTray()
  }, [queue.length, expanded])

  useEffect(() => {
    const conversation = conversationRef.current
    const tray = trayRef.current
    if (!conversation || !tray) return
    const observer = new ResizeObserver(measureTray)
    observer.observe(tray)
    return () => observer.disconnect()
  }, [queue.length])

  useLayoutEffect(() => {
    if (!followLatestRef.current) return
    const conversation = conversationRef.current
    if (conversation) conversation.scrollTop = conversation.scrollHeight
  }, [safeBottom, turns.length])

  const toggleQueue = (): void => {
    const conversation = conversationRef.current
    if (conversation) {
      followLatestRef.current = conversation.scrollHeight - conversation.scrollTop - conversation.clientHeight <= 48
    }
    setExpanded((value) => !value)
  }

  const addToQueue = (): void => {
    const text = draft.trim()
    if (!text) return
    dispatch({ type: 'enqueue', text })
    setDraft('')
  }

  return (
    <FluentProvider theme={webLightTheme}>
      <main className="queue-preview">
        <aside className="queue-preview-sidebar">
          <div className="queue-brand"><span className="queue-brand-mark">C</span><strong>Codey</strong></div>
          <Button appearance="primary" className="queue-new-chat">＋ 新建对话</Button>
          <div className="queue-side-label">项目</div>
          <button className="queue-side-item">▣　Codey</button>
          <div className="queue-side-label queue-history-label">对话</div>
          <button className="queue-side-item">○　故障转移优化</button>
          <button className="queue-side-item is-current">◉　队列设计调研</button>
          <button className="queue-side-item">○　上下文压缩策略</button>
          <div className="queue-sidebar-bottom"><span className="queue-avatar">W</span><span>Wisdo</span><span className="queue-ellipsis">···</span></div>
        </aside>

        <section className="queue-preview-workspace">
          <header className="queue-topbar">
            <div><div className="queue-breadcrumb">Codey <span>/</span> 队列设计调研</div><div className="queue-top-subtitle">本地演示会话</div></div>
            <div className="queue-top-actions"><span className="queue-demo-tag">UI 预览</span><Button appearance="subtle">⋯</Button></div>
          </header>

          <section className="queue-conversation-stage">
            <section
              ref={conversationRef}
              className="queue-conversation"
              style={{ '--queue-safe-bottom': `${safeBottom}px` } as React.CSSProperties}
              onScroll={(event) => {
                const element = event.currentTarget
                followLatestRef.current = element.scrollHeight - element.scrollTop - element.clientHeight <= 48
              }}
            >
            <div className="queue-conversation-inner">
              <div className="queue-date">今天</div>
              {turns.map((turn) => (
                <Fragment key={turn.id}>
                  <article className="queue-message user-message">
                    <div className="queue-message-avatar">W</div>
                    <div><div className="queue-message-heading">你</div><p>{turn.text}</p></div>
                  </article>
                  <article className="queue-message assistant-message">
                    <div className="queue-assistant-mark">C</div>
                    <div><div className="queue-message-heading">Codey <time>{turn.running ? '正在处理' : '已停止'}</time></div><p>{turn.reply}</p>
                      {turn.running && <div className="queue-working"><span className="queue-pulse"></span><span>正在处理当前消息（演示）</span></div>}
                    </div>
                  </article>
                </Fragment>
              ))}
            </div>
            </section>
            {queue.length > 0 && <section ref={trayRef} className={`queue-tray queue-tray-overlay ${expanded ? 'is-expanded' : 'is-collapsed'}`}>
              <div className="queue-tray-header">
                <button className="queue-tray-toggle" onClick={toggleQueue} aria-expanded={expanded}>
                  <span className="queue-tray-chevron">{expanded ? '⌄' : '›'}</span>
                  <strong>待发送</strong><span className="queue-count">{queue.length}</span>
                  <span className="queue-tray-summary">{expanded ? '会话空闲后按顺序发送' : queue[0]?.text}</span>
                </button>
                <Button appearance="subtle" size="small" onClick={() => dispatch({ type: 'clear' })}>清空</Button>
              </div>
              {expanded && <QueuedMessageList
                items={queue.map((item) => ({ ...item, attachmentCount: 0 }))}
                canRunNow
                onReorder={(source, target, placement) => dispatch({ type: 'reorder', source, target, placement })}
                onRunNow={(id) => dispatch({ type: 'run-now', id })}
                onRemove={(id) => dispatch({ type: 'remove', id })}
              />}
            </section>}
          </section>

          <footer className="queue-compose-area">

            <div className="queue-composer">
              <Textarea className="queue-draft" resize="none" rows={2} value={draft} onChange={(_, data) => setDraft(data.value)} placeholder="继续发送消息..." onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); addToQueue() } }} />
              <div className="queue-composer-toolbar">
                <div className="queue-composer-tools"><Button appearance="subtle" aria-label="添加附件" title="添加附件">＋</Button><Button appearance="subtle">工具　⌄</Button><span className="queue-input-hint">Enter 发送 · Shift+Enter 换行</span></div>
                <div className="queue-send-actions">
                  <span className="queue-queued-hint">{running ? '会话运行中，消息将加入队列' : '会话已暂停'}</span>
                </div>
              </div>
            </div>
            <div className="queue-run-controls">
              <span><span className={`queue-status-dot ${running ? 'is-running' : 'is-paused'}`}></span>{running ? '会话正在工作' : '会话已暂停'}</span>
              <Button appearance="subtle" size="small" onClick={() => dispatch({ type: 'toggle-running' })}>{running ? '■ 停止当前' : '▶ 继续会话'}</Button>
            </div>
          </footer>
        </section>
      </main>
    </FluentProvider>
  )
}
