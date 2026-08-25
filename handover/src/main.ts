import { LitElement, css, html, nothing, unsafeCSS, type TemplateResult } from 'lit'
import { repeat } from 'lit/directives/repeat.js'
import type { BridgeEnvelope, HandoverCatalog, HandoverConversation } from '../../src/shared/bridge'
import '@awesome.me/webawesome/dist/components/button/button.js'
import '@awesome.me/webawesome/dist/components/drawer/drawer.js'
import '@awesome.me/webawesome/dist/styles/webawesome.css'
import appStyles from './style.css?inline'
import './style.css'

type Invitation = { bridge: string; channel: string; secret?: string; pub: JsonWebKey }
type Persisted = { invitation?: Invitation; privateJwk?: JsonWebKey; publicJwk?: JsonWebKey; deviceFingerprint?: string; requestId?: string; joinTicket?: string; deviceId?: string; deviceToken?: string; dataKey?: string }
type PendingUserMessage = { projectId: string; conversationId: string; id: string; content: string; sentAt: number }
type AppState = Persisted & { status: string; catalog?: HandoverCatalog; conversation?: HandoverConversation; selectedProjectId?: string; selectedConversationId?: string; pendingUserMessages: PendingUserMessage[]; visibleMessageCount: number; collapsedProjects: Record<string, boolean>; mobileSidebarOpen: boolean; loadingOlder: boolean }

const DB_NAME = 'codey-handover'
const STORE_NAME = 'state'
const STATE_KEY = 'current'
const encoder = new TextEncoder()
const decoder = new TextDecoder()
const state: AppState = { status: '未连接', pendingUserMessages: [], visibleMessageCount: 5, collapsedProjects: {}, mobileSidebarOpen: false, loadingOlder: false }
let conversationRefreshTimer: ReturnType<typeof setInterval> | undefined
let conversationRefreshInFlight = false
let app: HandoverApp | undefined
let composerDraft = ''

function openDb(): Promise<IDBDatabase> { return new Promise((resolve, reject) => { const request = indexedDB.open(DB_NAME, 1); request.onupgradeneeded = () => request.result.createObjectStore(STORE_NAME); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error ?? new Error('无法打开本地存储')) }) }
async function loadPersisted(): Promise<void> { const db = await openDb(); const value = await new Promise<Persisted | undefined>((resolve, reject) => { const request = db.transaction(STORE_NAME).objectStore(STORE_NAME).get(STATE_KEY); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error) }); db.close(); if (value) Object.assign(state, value) }
async function savePersisted(): Promise<void> { const { status: _status, catalog: _catalog, conversation: _conversation, selectedProjectId: _project, selectedConversationId: _conversationId, pendingUserMessages: _pendingUserMessages, visibleMessageCount: _visible, collapsedProjects: _collapsedProjects, mobileSidebarOpen: _mobile, loadingOlder: _loading, ...persisted } = state; const db = await openDb(); await new Promise<void>((resolve, reject) => { const request = db.transaction(STORE_NAME, 'readwrite').objectStore(STORE_NAME).put(persisted, STATE_KEY); request.onsuccess = () => resolve(); request.onerror = () => reject(request.error) }); db.close() }
function b64(bytes: Uint8Array): string { return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '') }
function unb64(value: string): Uint8Array { const padded = value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - value.length % 4) % 4); return Uint8Array.from(atob(padded), (char) => char.charCodeAt(0)) }
function localHost(hostname: string): boolean { return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]' || hostname === '::1' }
function normalizeBridgeUrl(value: string): string { const url = new URL(value); if (!['http:', 'https:'].includes(url.protocol) || (url.protocol === 'http:' && !localHost(url.hostname))) throw new Error('远程 Bridge 必须使用 HTTPS'); if (url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('配对内容中的 Bridge 地址无效'); return url.origin }
async function api<T>(path: string, init: RequestInit = {}, token?: string): Promise<T> { const response = await fetch(`${state.invitation?.bridge ?? ''}${path}`, { ...init, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...(init.headers ?? {}) } }); const result = await response.json() as T & { error?: string }; if (!response.ok) throw new Error(result.error || 'Bridge 请求失败'); return result }
async function deviceFingerprint(publicKey: JsonWebKey): Promise<string> { const canonical = JSON.stringify(Object.fromEntries(Object.keys(publicKey).sort().map((key) => [key, publicKey[key as keyof JsonWebKey]]))); const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(canonical))); return Array.from(digest).map((byte) => byte.toString(16).padStart(2, '0')).join('').slice(0, 24).match(/.{1,4}/g)?.join('-') ?? '' }
async function derive(privateJwk: JsonWebKey, publicJwk: JsonWebKey, info: string): Promise<CryptoKey> { const own = await crypto.subtle.importKey('jwk', privateJwk, { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']); const other = await crypto.subtle.importKey('jwk', publicJwk, { name: 'ECDH', namedCurve: 'P-256' }, false, []); const bits = await crypto.subtle.deriveBits({ name: 'ECDH', public: other }, own, 256); const material = await crypto.subtle.importKey('raw', bits, 'HKDF', false, ['deriveKey']); return crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: encoder.encode('codey-handover-v1'), info: encoder.encode(info) }, material, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']) }
async function decrypt<T>(key: CryptoKey, envelope: BridgeEnvelope, aad: string): Promise<T> { const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(envelope.iv), additionalData: encoder.encode(aad) }, key, unb64(envelope.ciphertext)); return JSON.parse(decoder.decode(plain)) as T }
async function dataKey(): Promise<CryptoKey> { if (!state.dataKey) throw new Error('尚未完成配对'); return crypto.subtle.importKey('raw', unb64(state.dataKey), 'AES-GCM', false, ['encrypt', 'decrypt']) }
async function encrypt(key: CryptoKey, value: unknown, aad: string): Promise<BridgeEnvelope> { const iv = crypto.getRandomValues(new Uint8Array(12)); const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: encoder.encode(aad) }, key, encoder.encode(JSON.stringify(value))); return { iv: b64(iv), ciphertext: b64(new Uint8Array(ciphertext)) } }
function readInvitation(value: string): Invitation { const url = new URL(value.trim()); if (url.protocol !== 'codey-handover:' || url.hostname !== 'pair') throw new Error('配对内容格式无效'); const bridge = normalizeBridgeUrl(url.searchParams.get('bridge') ?? ''); const channel = url.searchParams.get('channel') ?? ''; const secret = url.searchParams.get('secret') ?? ''; const pub = JSON.parse(url.searchParams.get('pub') ?? '') as JsonWebKey; if (!channel || secret.length < 32 || pub.kty !== 'EC' || pub.crv !== 'P-256') throw new Error('配对内容缺少必要字段'); return { bridge, channel, secret, pub } }

async function pair(raw: string): Promise<void> { state.invitation = readInvitation(raw); state.privateJwk = undefined; state.publicJwk = undefined; state.deviceFingerprint = undefined; state.requestId = undefined; state.joinTicket = undefined; state.deviceId = undefined; state.deviceToken = undefined; state.dataKey = undefined; state.catalog = undefined; state.conversation = undefined; state.status = '正在申请配对…'; app?.requestUpdate(); const keyPair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']); state.privateJwk = await crypto.subtle.exportKey('jwk', keyPair.privateKey); state.publicJwk = await crypto.subtle.exportKey('jwk', keyPair.publicKey); state.deviceFingerprint = await deviceFingerprint(state.publicJwk); const joined = await api<{ requestId: string; joinTicket: string }>(`/v1/channels/${state.invitation.channel}/join`, { method: 'POST', body: JSON.stringify({ enrollmentSecret: state.invitation.secret, deviceName: 'Handover PWA', devicePublicKey: state.publicJwk }) }); state.requestId = joined.requestId; state.joinTicket = joined.joinTicket; state.status = '等待 Codey 审批…'; await savePersisted(); app?.requestUpdate(); await waitApproval() }
async function waitApproval(): Promise<void> { for (let i = 0; i < 40; i += 1) { await new Promise((resolve) => setTimeout(resolve, 3000)); try { const result = await api<{ status: string; deviceId?: string; keyEnvelope?: BridgeEnvelope }>(`/v1/channels/${state.invitation!.channel}/bootstrap`, { method: 'POST', body: JSON.stringify({ joinTicket: state.joinTicket }) }); if (result.status !== 'approved') continue; if (!result.deviceId || !result.keyEnvelope || !state.privateJwk || !state.requestId) throw new Error('Bridge 返回的配对结果不完整'); const pairKey = await derive(state.privateJwk, state.invitation!.pub, `${state.invitation!.channel}:${state.requestId}`); const keys = await decrypt<{ dataKey: string; deviceToken: string }>(pairKey, result.keyEnvelope, `${state.invitation!.channel}:${state.requestId}`); if (!keys.dataKey || !keys.deviceToken) throw new Error('配对密钥无效'); state.deviceId = result.deviceId; state.deviceToken = keys.deviceToken; state.dataKey = keys.dataKey; state.invitation = { ...state.invitation!, secret: undefined }; state.status = '已连接'; await savePersisted(); await loadCatalog(); app?.requestUpdate(); return } catch (error) { state.status = error instanceof Error ? error.message : '配对失败'; app?.requestUpdate(); return } } state.status = '审批超时'; app?.requestUpdate() }
async function loadCatalog(): Promise<void> { const result = await api<{ envelope: BridgeEnvelope }>(`/v1/channels/${state.invitation!.channel}/snapshots/catalog`, {}, state.deviceToken); state.catalog = await decrypt(await dataKey(), result.envelope, `${state.invitation!.channel}:catalog`); state.conversation = undefined; startConversationRefresh() }
function reconcilePendingUserMessages(conversation: HandoverConversation): boolean { const before = state.pendingUserMessages.length; state.pendingUserMessages = state.pendingUserMessages.filter((pending) => !conversation.messages.some((message) => pending.projectId === conversation.projectId && pending.conversationId === conversation.conversationId && message.role === 'user' && message.content === pending.content && Date.parse(message.createdAt ?? '') >= pending.sentAt - 5_000)); return state.pendingUserMessages.length !== before }
function pendingMessagesForSelectedConversation(): HandoverConversation['messages'] { return state.pendingUserMessages.filter((pending) => pending.projectId === state.selectedProjectId && pending.conversationId === state.selectedConversationId).map((pending) => ({ id: `pending-${pending.id}`, role: 'user' as const, content: pending.content, createdAt: new Date(pending.sentAt).toISOString() })) }
async function loadConversation(projectId: string, conversationId: string): Promise<void> { state.selectedProjectId = projectId; state.selectedConversationId = conversationId; state.visibleMessageCount = 5; state.conversation = undefined; state.status = '正在加载会话…'; app?.requestUpdate(); const result = await api<{ envelope: BridgeEnvelope }>(`/v1/channels/${state.invitation!.channel}/snapshots/conversation-${encodeURIComponent(conversationId)}`, {}, state.deviceToken); if (state.selectedProjectId !== projectId || state.selectedConversationId !== conversationId) return; state.conversation = await decrypt(await dataKey(), result.envelope, `${state.invitation!.channel}:conversation-${conversationId}`); reconcilePendingUserMessages(state.conversation); state.status = '已连接'; app?.requestUpdate(); await app?.scrollToLatest() }
async function refreshSelectedConversation(): Promise<void> { if (conversationRefreshInFlight || !state.invitation || !state.deviceToken || !state.dataKey || !state.selectedProjectId || !state.selectedConversationId) return; const projectId = state.selectedProjectId; const conversationId = state.selectedConversationId; conversationRefreshInFlight = true; try { const result = await api<{ envelope: BridgeEnvelope }>(`/v1/channels/${state.invitation.channel}/snapshots/conversation-${encodeURIComponent(conversationId)}`, {}, state.deviceToken); const conversation = await decrypt<HandoverConversation>(await dataKey(), result.envelope, `${state.invitation.channel}:conversation-${conversationId}`); if (state.selectedProjectId === projectId && state.selectedConversationId === conversationId) { const previous = state.conversation; const previousLastMessage = previous?.messages.at(-1); const nextLastMessage = conversation.messages.at(-1); const changed = !previous || previous.updatedAt !== conversation.updatedAt || previous.messages.length !== conversation.messages.length || previousLastMessage?.id !== nextLastMessage?.id; state.conversation = conversation; const pendingReconciled = reconcilePendingUserMessages(conversation); if (changed || pendingReconciled) app?.requestUpdate() } } catch { /* 后台刷新失败时保留当前界面，下一轮继续尝试。 */ } finally { conversationRefreshInFlight = false } }
function startConversationRefresh(): void { if (conversationRefreshTimer !== undefined) return; conversationRefreshTimer = setInterval(() => { void refreshSelectedConversation() }, 3000) }
async function sendMessage(rawContent: string): Promise<void> { const content = rawContent.trim(); if (!content || !state.selectedProjectId || !state.selectedConversationId) return; const id = crypto.randomUUID(); const projectId = state.selectedProjectId; const conversationId = state.selectedConversationId; const envelope = await encrypt(await dataKey(), { projectId, conversationId, clientMessageId: id, content }, `${state.invitation!.channel}:event:${id}`); await api(`/v1/channels/${state.invitation!.channel}/events`, { method: 'POST', body: JSON.stringify({ id, envelope }) }, state.deviceToken); state.pendingUserMessages.push({ projectId, conversationId, id, content, sentAt: Date.now() }); state.status = '消息已排队，等待 Codey 处理'; state.visibleMessageCount = Math.max(state.visibleMessageCount, 5); app?.requestUpdate(); await app?.scrollToLatest() }
async function clearPersisted(): Promise<void> { const db = await openDb(); await new Promise<void>((resolve, reject) => { const request = db.transaction(STORE_NAME, 'readwrite').objectStore(STORE_NAME).delete(STATE_KEY); request.onsuccess = () => resolve(); request.onerror = () => reject(request.error) }); db.close() }
function resetPairing(): void { void clearPersisted().finally(() => location.reload()) }

function messageList(): HandoverConversation['messages'] { return [...(state.conversation?.messages ?? []), ...pendingMessagesForSelectedConversation()] }
function isProjectCollapsed(projectId: string): boolean { return state.collapsedProjects[projectId] ?? true }
function toggleProject(projectId: string): void { state.collapsedProjects = { ...state.collapsedProjects, [projectId]: !isProjectCollapsed(projectId) }; app?.requestUpdate() }
function conversationList(): TemplateResult { return html`${repeat(state.catalog?.projects ?? [], (project) => { const collapsed = isProjectCollapsed(project.id); return html`<section class="project"><button class="project-toggle" aria-expanded=${String(!collapsed)} @click=${() => toggleProject(project.id)}><span class="project-chevron" aria-hidden="true">${collapsed ? '▸' : '▾'}</span><span class="project-name">${project.name}</span><span class="project-count">${project.conversations.length}</span></button>${collapsed ? nothing : html`<div class="project-conversations">${repeat(project.conversations, (conversation) => html`<button class="conversation ${state.selectedConversationId === conversation.id ? 'selected' : ''}" @click=${() => { state.mobileSidebarOpen = false; void loadConversation(project.id, conversation.id).catch(showError) }}>${conversation.title}</button>`)}</div>`}</section>` })}` }
function showError(error: unknown, fallback = '操作失败'): void { state.status = error instanceof Error ? error.message : fallback; app?.requestUpdate() }


class HandoverThread extends HTMLElement {
  private readonly header: HTMLElement
  private readonly count: HTMLElement
  private readonly scroll: HTMLElement
  private readonly input: HTMLTextAreaElement
  private readonly sendButton: HTMLButtonElement
  private renderedConversationKey = ''
  private renderedVisibleCount = 0
  private renderedLoadingOlder = false

  constructor() {
    super()
    const shadow = this.attachShadow({ mode: 'open' })
    shadow.innerHTML = `
      <style>
        :host { display: flex; flex: 1 1 auto; flex-direction: column; min-width: 0; min-height: 0; overflow: hidden; }
        .thread-header { flex: 0 0 auto; min-height: 62px; padding: 14px 18px; border-bottom: 1px solid #edf0f4; display: flex; align-items: center; }
        h2, p { margin: 0; }
        h2 { font-size: .9rem; font-weight: 700; }
        small { display: block; margin-top: 4px; color: #8894a4; }
        .message-scroll { flex: 1 1 auto; min-height: 0; overflow-y: auto; padding: 14px 18px 20px; overscroll-behavior: contain; }
        .older-hint { position: sticky; top: 0; z-index: 1; width: fit-content; margin: -5px auto 10px; padding: 5px 10px; border-radius: 99px; color: #64748b; background: #f1f5f9; font-size: .75rem; }
        .message { max-width: min(780px, 92%); margin: 9px 0; padding: 10px 13px; border-radius: 14px; white-space: pre-wrap; overflow-wrap: anywhere; }
        .message strong { display: block; margin-bottom: 4px; font-size: .76rem; color: #64748b; }
        .message p { line-height: 1.5; }
        .message.user { margin-left: auto; background: #e4f2ff; }
        .message.assistant { margin-right: auto; background: #f1f3f5; }
        .empty-thread { flex: 1; display: grid; place-items: center; color: #8792a1; }
        form { flex: 0 0 auto; display: flex; align-items: flex-end; gap: 8px; padding: 12px 14px; border-top: 1px solid #edf0f4; background: #fff; }
        textarea { flex: 1 1 auto; min-width: 0; min-height: 48px; max-height: 140px; width: 100%; border: 1px solid #c9d1dc; border-radius: 12px; padding: 12px; color: #17212b; background: #fff; font: inherit; resize: none; }
        textarea:focus { outline: 2px solid color-mix(in srgb, #2563eb 28%, transparent); border-color: #2563eb; }
        button { min-height: 42px; padding: 0 16px; border: 0; border-radius: 10px; color: #fff; background: #2563eb; cursor: pointer; font: inherit; }
        button:hover:not(:disabled) { background: #1d4ed8; }
        button:disabled, textarea:disabled { cursor: not-allowed; opacity: .55; }
        @media (max-width: 700px) { .thread-header { padding: 12px 14px; } .message-scroll { padding-left: 12px; padding-right: 12px; } form { padding: 10px; } button { min-width: 64px; padding-inline: 10px; } }
      </style>
      <div class="thread-header"><div><h2></h2><small></small></div></div>
      <div class="message-scroll"></div>
      <form>
        <textarea rows="3" placeholder="发送用户消息…"></textarea>
        <button type="submit">发送</button>
      </form>
    `
    this.header = shadow.querySelector('h2')!
    this.count = shadow.querySelector('small')!
    this.scroll = shadow.querySelector('.message-scroll')!
    this.input = shadow.querySelector('textarea')!
    this.sendButton = shadow.querySelector('button')!
    this.input.value = composerDraft
    this.input.addEventListener('input', () => { composerDraft = this.input.value })
    this.scroll.addEventListener('scroll', () => {
      if (this.scroll.scrollTop <= 40) this.dispatchEvent(new CustomEvent('thread-load-older', { bubbles: true, composed: true }))
    })
    shadow.querySelector('form')!.addEventListener('submit', (event) => {
      event.preventDefault()
      const content = this.input.value.trim()
      if (!content || this.input.disabled) return
      this.dispatchEvent(new CustomEvent<{ content: string }>('composer-submit', { detail: { content }, bubbles: true, composed: true }))
    })
  }

  update(conversation: HandoverConversation | undefined, messages: HandoverConversation['messages'], visibleCount: number, loadingOlder: boolean): void {
    const key = conversation ? `${conversation.projectId}:${conversation.conversationId}:${conversation.updatedAt}:${messages.length}` : ''
    this.header.textContent = conversation?.title ?? '选择一个会话'
    this.count.textContent = conversation ? `${messages.length} 条消息，已显示最近 ${Math.min(messages.length, Math.max(1, visibleCount))} 条` : ''
    this.setComposerDisabled(!conversation)
    const changed = key !== this.renderedConversationKey || visibleCount !== this.renderedVisibleCount || loadingOlder !== this.renderedLoadingOlder
    if (!changed) return
    const oldHeight = this.scroll.scrollHeight
    const oldTop = this.scroll.scrollTop
    const visible = messages.slice(-Math.max(1, visibleCount))
    this.scroll.replaceChildren()
    const olderCount = Math.max(0, messages.length - visible.length)
    if (!conversation) {
      const empty = document.createElement('div')
      empty.className = 'empty-thread'
      empty.innerHTML = '<p>选择一个会话查看消息。</p>'
      this.scroll.append(empty)
    } else {
      if (olderCount > 0) {
        const hint = document.createElement('div')
        hint.className = 'older-hint'
        hint.textContent = loadingOlder ? '正在加载更早消息…' : '上滑加载更早消息'
        this.scroll.append(hint)
      }
      for (const message of visible) {
        const article = document.createElement('article')
        article.className = `message ${message.role}`
        const author = document.createElement('strong')
        author.textContent = message.role === 'user' ? '你' : 'Codey'
        article.append(author)
        const content = document.createElement('p')
        content.textContent = message.content
        article.append(content)
        for (const block of message.blocks ?? []) {
          const blockContent = document.createElement('p')
          blockContent.textContent = block.content
          article.append(blockContent)
        }
        this.scroll.append(article)
      }
    }
    this.renderedConversationKey = key
    this.renderedVisibleCount = visibleCount
    this.renderedLoadingOlder = loadingOlder
    if (loadingOlder) requestAnimationFrame(() => { this.scroll.scrollTop = oldTop + (this.scroll.scrollHeight - oldHeight) })
  }

  disconnectedCallback(): void { composerDraft = this.input.value }
  clearComposerIfValue(content: string): void {
    if (this.input.value.trim() !== content) return
    this.input.value = ''
    composerDraft = ''
  }
  setComposerDisabled(disabled: boolean): void {
    if (this.input.disabled !== disabled) this.input.disabled = disabled
    if (this.sendButton.disabled !== disabled) this.sendButton.disabled = disabled
  }
  async scrollToLatest(): Promise<void> { await Promise.resolve(); this.scroll.scrollTop = this.scroll.scrollHeight }
}
customElements.define('handover-thread', HandoverThread)

class HandoverApp extends LitElement {
  static styles = [css`:host { display:block; height:100%; }`, unsafeCSS(appStyles)]
  private thread?: HandoverThread

  connectedCallback(): void {
    super.connectedCallback()
    app = this
  }
  disconnectedCallback(): void { if (app === this) app = undefined; super.disconnectedCallback() }
  updated(): void {
    const thread = this.renderRoot.querySelector<HandoverThread>('handover-thread')
    if (!thread) {
      this.thread = undefined
      return
    }
    if (this.thread !== thread) {
      thread.addEventListener('composer-submit', (event) => { void this.onComposerSubmit(event as CustomEvent<{ content: string }>) })
      thread.addEventListener('thread-load-older', () => this.onMessageScroll())
    }
    this.thread = thread
    thread.update(state.conversation, messageList(), state.visibleMessageCount, state.loadingOlder)
    thread.setComposerDisabled(!state.conversation)
  }

  render(): TemplateResult {
    if (!state.invitation) return html`<main class="shell onboarding"><h1>Codey Handover</h1><p>将 Codey 提供的配对内容粘贴到这里。</p><textarea id="pairing" placeholder="codey-handover://pair?..." rows="6"></textarea><wa-button id="pair" @click=${() => void pair((this.renderRoot.querySelector('#pairing') as HTMLTextAreaElement).value).catch(showError)}>连接</wa-button><p class="status">${state.status}</p></main>`
    if (!state.catalog) return html`<main class="shell onboarding"><h1>Handover</h1><p>${state.status}</p>${state.deviceFingerprint ? html`<p class="fingerprint">设备指纹：<code>${state.deviceFingerprint}</code><br><small>请在 Codey 核对该指纹后再允许。</small></p>` : nothing}<wa-button @click=${resetPairing}>重新配对</wa-button></main>`
    return html`<main class="shell app-shell"><header class="app-header"><div class="title"><wa-button appearance="plain" class="mobile-only" @click=${() => { state.mobileSidebarOpen = true; this.requestUpdate() }}>☰</wa-button><div><h1>Handover</h1><span class="status">${state.status}</span></div></div></header><div class="layout"><aside class="conversation-sidebar"><div class="sidebar-heading"><strong>会话</strong><span>${state.catalog.projects.reduce((total, project) => total + project.conversations.length, 0)}</span></div>${conversationList()}</aside><section class="thread-panel"><handover-thread></handover-thread></section></div><wa-drawer label="会话列表" ?open=${state.mobileSidebarOpen} @wa-after-hide=${() => { state.mobileSidebarOpen = false; this.requestUpdate() }}>${conversationList()}</wa-drawer></main>`
  }
  private async onComposerSubmit(event: CustomEvent<{ content: string }>): Promise<void> { try { await sendMessage(event.detail.content); this.thread?.clearComposerIfValue(event.detail.content) } catch (error) { showError(error) } }
  private onMessageScroll(): void { if (state.loadingOlder || !state.conversation) return; const all = messageList(); if (state.visibleMessageCount >= all.length) return; state.loadingOlder = true; state.visibleMessageCount = Math.min(all.length, state.visibleMessageCount + 5); this.requestUpdate(); void this.updateComplete.then(() => { state.loadingOlder = false; this.requestUpdate() }) }
  async scrollToLatest(): Promise<void> { await this.updateComplete; await this.thread?.scrollToLatest() }
}
customElements.define('handover-app', HandoverApp)

document.getElementById('root')!.replaceChildren(document.createElement('handover-app'))
async function restore(): Promise<void> { await loadPersisted(); if (state.publicJwk && !state.deviceFingerprint) { state.deviceFingerprint = await deviceFingerprint(state.publicJwk); await savePersisted() }; if (state.invitation && state.deviceToken && state.dataKey) { try { state.status = '已连接'; await loadCatalog() } catch (error) { showError(error, '恢复连接失败') } } else if (state.invitation && state.joinTicket && state.privateJwk && state.requestId) { state.status = '等待 Codey 审批…'; app?.requestUpdate(); await waitApproval() }; app?.requestUpdate() }
if ('serviceWorker' in navigator && window.isSecureContext) window.addEventListener('load', () => { void navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => undefined) })
void restore().catch((error) => showError(error, '初始化失败'))
