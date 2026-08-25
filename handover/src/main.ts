import type { BridgeEnvelope, HandoverCatalog, HandoverConversation } from '../../src/shared/bridge'
import './style.css'

type Invitation = { bridge: string; channel: string; secret?: string; pub: JsonWebKey }
type Persisted = {
  invitation?: Invitation
  privateJwk?: JsonWebKey
  publicJwk?: JsonWebKey
  deviceFingerprint?: string
  requestId?: string
  joinTicket?: string
  deviceId?: string
  deviceToken?: string
  dataKey?: string
}
type PendingUserMessage = {
  projectId: string
  conversationId: string
  id: string
  content: string
  sentAt: number
}
type AppState = Persisted & {
  status: string
  catalog?: HandoverCatalog
  conversation?: HandoverConversation
  selectedProjectId?: string
  selectedConversationId?: string
  pendingUserMessages: PendingUserMessage[]
  message: string
}

const DB_NAME = 'codey-handover'
const STORE_NAME = 'state'
const STATE_KEY = 'current'
const encoder = new TextEncoder()
const decoder = new TextDecoder()
const state: AppState = { status: '未连接', message: '', pendingUserMessages: [] }
let conversationRefreshTimer: ReturnType<typeof setInterval> | undefined
let conversationRefreshInFlight = false

function $(id: string): HTMLElement { const element = document.getElementById(id); if (!element) throw new Error(`Missing element: ${id}`); return element }
function b64(bytes: Uint8Array): string { return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '') }
function unb64(value: string): Uint8Array { const padded = value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - value.length % 4) % 4); return Uint8Array.from(atob(padded), (char) => char.charCodeAt(0)) }
function escapeHtml(value: string): string { return value.replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char] ?? char)) }
function localHost(hostname: string): boolean { return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]' || hostname === '::1' }
function normalizeBridgeUrl(value: string): string {
  const url = new URL(value)
  if (!['http:', 'https:'].includes(url.protocol) || (url.protocol === 'http:' && !localHost(url.hostname))) throw new Error('远程 Bridge 必须使用 HTTPS')
  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('配对内容中的 Bridge 地址无效')
  return url.origin
}
function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1)
    request.onupgradeneeded = () => request.result.createObjectStore(STORE_NAME)
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('无法打开本地存储'))
  })
}
async function loadPersisted(): Promise<void> {
  const db = await openDb()
  const value = await new Promise<Persisted | undefined>((resolve, reject) => { const request = db.transaction(STORE_NAME).objectStore(STORE_NAME).get(STATE_KEY); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error) })
  db.close()
  if (value) Object.assign(state, value)
}
async function savePersisted(): Promise<void> {
  const { status: _status, catalog: _catalog, conversation: _conversation, selectedProjectId: _project, selectedConversationId: _conversationId, pendingUserMessages: _pendingUserMessages, message: _message, ...persisted } = state
  const db = await openDb()
  await new Promise<void>((resolve, reject) => { const request = db.transaction(STORE_NAME, 'readwrite').objectStore(STORE_NAME).put(persisted, STATE_KEY); request.onsuccess = () => resolve(); request.onerror = () => reject(request.error) })
  db.close()
}
async function api<T>(path: string, init: RequestInit = {}, token?: string): Promise<T> {
  const response = await fetch(`${state.invitation?.bridge ?? ''}${path}`, { ...init, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...(init.headers ?? {}) } })
  const result = await response.json() as T & { error?: string }
  if (!response.ok) throw new Error(result.error || 'Bridge 请求失败')
  return result
}
async function deviceFingerprint(publicKey: JsonWebKey): Promise<string> {
  const canonical = JSON.stringify(Object.fromEntries(Object.keys(publicKey).sort().map((key) => [key, publicKey[key as keyof JsonWebKey]])))
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(canonical)))
  return Array.from(digest).map((byte) => byte.toString(16).padStart(2, '0')).join('').slice(0, 24).match(/.{1,4}/g)?.join('-') ?? ''
}
async function derive(privateJwk: JsonWebKey, publicJwk: JsonWebKey, info: string): Promise<CryptoKey> {
  const own = await crypto.subtle.importKey('jwk', privateJwk, { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits'])
  const other = await crypto.subtle.importKey('jwk', publicJwk, { name: 'ECDH', namedCurve: 'P-256' }, false, [])
  const bits = await crypto.subtle.deriveBits({ name: 'ECDH', public: other }, own, 256)
  const material = await crypto.subtle.importKey('raw', bits, 'HKDF', false, ['deriveKey'])
  return crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: encoder.encode('codey-handover-v1'), info: encoder.encode(info) }, material, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
}
async function decrypt<T>(key: CryptoKey, envelope: BridgeEnvelope, aad: string): Promise<T> {
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(envelope.iv), additionalData: encoder.encode(aad) }, key, unb64(envelope.ciphertext))
  return JSON.parse(decoder.decode(plain)) as T
}
async function dataKey(): Promise<CryptoKey> {
  if (!state.dataKey) throw new Error('尚未完成配对')
  return crypto.subtle.importKey('raw', unb64(state.dataKey), 'AES-GCM', false, ['encrypt', 'decrypt'])
}
async function encrypt(key: CryptoKey, value: unknown, aad: string): Promise<BridgeEnvelope> {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: encoder.encode(aad) }, key, encoder.encode(JSON.stringify(value)))
  return { iv: b64(iv), ciphertext: b64(new Uint8Array(ciphertext)) }
}
function readInvitation(value: string): Invitation {
  const url = new URL(value.trim())
  if (url.protocol !== 'codey-handover:' || url.hostname !== 'pair') throw new Error('配对内容格式无效')
  const bridge = normalizeBridgeUrl(url.searchParams.get('bridge') ?? '')
  const channel = url.searchParams.get('channel') ?? ''
  const secret = url.searchParams.get('secret') ?? ''
  const pub = JSON.parse(url.searchParams.get('pub') ?? '') as JsonWebKey
  if (!channel || secret.length < 32 || pub.kty !== 'EC' || pub.crv !== 'P-256') throw new Error('配对内容缺少必要字段')
  return { bridge, channel, secret, pub }
}
async function pair(raw: string): Promise<void> {
  state.invitation = readInvitation(raw)
  state.privateJwk = undefined; state.publicJwk = undefined; state.deviceFingerprint = undefined; state.requestId = undefined; state.joinTicket = undefined; state.deviceId = undefined; state.deviceToken = undefined; state.dataKey = undefined; state.catalog = undefined; state.conversation = undefined
  state.status = '正在申请配对…'; render()
  const keyPair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'])
  state.privateJwk = await crypto.subtle.exportKey('jwk', keyPair.privateKey)
  state.publicJwk = await crypto.subtle.exportKey('jwk', keyPair.publicKey)
  state.deviceFingerprint = await deviceFingerprint(state.publicJwk)
  const joined = await api<{ requestId: string; joinTicket: string }>(`/v1/channels/${state.invitation.channel}/join`, { method: 'POST', body: JSON.stringify({ enrollmentSecret: state.invitation.secret, deviceName: 'Handover PWA', devicePublicKey: state.publicJwk }) })
  state.requestId = joined.requestId; state.joinTicket = joined.joinTicket; state.status = '等待 Codey 审批…'
  await savePersisted(); render(); await waitApproval()
}
async function waitApproval(): Promise<void> {
  for (let i = 0; i < 40; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 3000))
    try {
      const result = await api<{ status: string; deviceId?: string; keyEnvelope?: BridgeEnvelope }>(`/v1/channels/${state.invitation!.channel}/bootstrap`, { method: 'POST', body: JSON.stringify({ joinTicket: state.joinTicket }) })
      if (result.status !== 'approved') continue
      if (!result.deviceId || !result.keyEnvelope || !state.privateJwk || !state.requestId) throw new Error('Bridge 返回的配对结果不完整')
      const pairKey = await derive(state.privateJwk, state.invitation!.pub, `${state.invitation!.channel}:${state.requestId}`)
      const keys = await decrypt<{ dataKey: string; deviceToken: string }>(pairKey, result.keyEnvelope, `${state.invitation!.channel}:${state.requestId}`)
      if (!keys.dataKey || !keys.deviceToken) throw new Error('配对密钥无效')
      state.deviceId = result.deviceId; state.deviceToken = keys.deviceToken; state.dataKey = keys.dataKey; state.invitation = { ...state.invitation!, secret: undefined }; state.status = '已连接'; await savePersisted(); await loadCatalog(); render(); return
    } catch (error) { state.status = error instanceof Error ? error.message : '配对失败'; render(); return }
  }
  state.status = '审批超时'; render()
}
async function loadCatalog(): Promise<void> { const result = await api<{ envelope: BridgeEnvelope }>(`/v1/channels/${state.invitation!.channel}/snapshots/catalog`, {}, state.deviceToken); state.catalog = await decrypt(await dataKey(), result.envelope, `${state.invitation!.channel}:catalog`); state.conversation = undefined; startConversationRefresh() }
function reconcilePendingUserMessages(conversation: HandoverConversation): boolean {
  const before = state.pendingUserMessages.length
  state.pendingUserMessages = state.pendingUserMessages.filter((pending) => !conversation.messages.some((message) => (
    pending.projectId === conversation.projectId
    && pending.conversationId === conversation.conversationId
    && message.role === 'user'
    && message.content === pending.content
    && Date.parse(message.createdAt ?? '') >= pending.sentAt - 5_000
  )))
  return state.pendingUserMessages.length !== before
}
function pendingMessagesForSelectedConversation(): HandoverConversation['messages'] {
  return state.pendingUserMessages
    .filter((pending) => pending.projectId === state.selectedProjectId && pending.conversationId === state.selectedConversationId)
    .map((pending) => ({ id: `pending-${pending.id}`, role: 'user' as const, content: pending.content, createdAt: new Date(pending.sentAt).toISOString() }))
}
async function loadConversation(projectId: string, conversationId: string): Promise<void> { state.selectedProjectId = projectId; state.selectedConversationId = conversationId; const result = await api<{ envelope: BridgeEnvelope }>(`/v1/channels/${state.invitation!.channel}/snapshots/conversation-${encodeURIComponent(conversationId)}`, {}, state.deviceToken); if (state.selectedProjectId !== projectId || state.selectedConversationId !== conversationId) return; state.conversation = await decrypt(await dataKey(), result.envelope, `${state.invitation!.channel}:conversation-${conversationId}`); reconcilePendingUserMessages(state.conversation); render() }
async function refreshSelectedConversation(): Promise<void> {
  if (conversationRefreshInFlight || !state.invitation || !state.deviceToken || !state.dataKey || !state.selectedProjectId || !state.selectedConversationId) return
  const projectId = state.selectedProjectId
  const conversationId = state.selectedConversationId
  conversationRefreshInFlight = true
  try {
    const result = await api<{ envelope: BridgeEnvelope }>(`/v1/channels/${state.invitation.channel}/snapshots/conversation-${encodeURIComponent(conversationId)}`, {}, state.deviceToken)
    const conversation = await decrypt<HandoverConversation>(await dataKey(), result.envelope, `${state.invitation.channel}:conversation-${conversationId}`)
    if (state.selectedProjectId === projectId && state.selectedConversationId === conversationId) {
      const previous = state.conversation
      const previousLastMessage = previous?.messages.at(-1)
      const nextLastMessage = conversation.messages.at(-1)
      const changed = !previous || previous.updatedAt !== conversation.updatedAt || previous.messages.length !== conversation.messages.length || previousLastMessage?.id !== nextLastMessage?.id
      state.conversation = conversation
      const pendingReconciled = reconcilePendingUserMessages(conversation)
      if (changed || pendingReconciled) render()
    }
  } catch {
    // 后台刷新失败时保留当前界面，下一轮继续尝试。
  } finally {
    conversationRefreshInFlight = false
  }
}
function startConversationRefresh(): void {
  if (conversationRefreshTimer !== undefined) return
  conversationRefreshTimer = setInterval(() => { void refreshSelectedConversation() }, 3000)
}
async function sendMessage(): Promise<void> { const content = state.message.trim(); if (!content || !state.selectedProjectId || !state.selectedConversationId) return; const id = crypto.randomUUID(); const projectId = state.selectedProjectId; const conversationId = state.selectedConversationId; const envelope = await encrypt(await dataKey(), { projectId, conversationId, clientMessageId: id, content }, `${state.invitation!.channel}:event:${id}`); await api(`/v1/channels/${state.invitation!.channel}/events`, { method: 'POST', body: JSON.stringify({ id, envelope }) }, state.deviceToken); state.pendingUserMessages.push({ projectId, conversationId, id, content, sentAt: Date.now() }); state.message = ''; state.status = '消息已排队，等待 Codey 处理'; render() }
async function clearPersisted(): Promise<void> {
  const db = await openDb()
  await new Promise<void>((resolve, reject) => { const request = db.transaction(STORE_NAME, 'readwrite').objectStore(STORE_NAME).delete(STATE_KEY); request.onsuccess = () => resolve(); request.onerror = () => reject(request.error) })
  db.close()
}
function resetPairing(): void { void clearPersisted().finally(() => location.reload()) }
function render(): void {
  const root = $('root')
  if (!state.invitation) { root.innerHTML = `<main class="shell"><h1>Codey Handover</h1><p>将 Codey 提供的配对内容粘贴到这里。</p><textarea id="pairing" placeholder="codey-handover://pair?..." rows="6"></textarea><button id="pair">连接</button><p class="status">${escapeHtml(state.status)}</p></main>`; $('pair').onclick = () => pair(($('pairing') as HTMLTextAreaElement).value).catch((error) => { state.status = error instanceof Error ? error.message : '配对失败'; render() }); return }
  if (!state.catalog) { root.innerHTML = `<main class="shell"><h1>Handover</h1><p>${escapeHtml(state.status)}</p>${state.deviceFingerprint ? `<p class="fingerprint">设备指纹：<code>${escapeHtml(state.deviceFingerprint)}</code><br><small>请在 Codey 核对该指纹后再允许。</small></p>` : ''}<button id="reset">重新配对</button></main>`; $('reset').onclick = resetPairing; return }
  const projects = state.catalog.projects.map((project) => `<section><h2>${escapeHtml(project.name)}</h2>${project.conversations.map((conversation) => `<button class="conversation" data-p="${escapeHtml(project.id)}" data-c="${escapeHtml(conversation.id)}">${escapeHtml(conversation.title)}</button>`).join('')}</section>`).join('')
  const selectedMessages = state.conversation ? [...state.conversation.messages, ...pendingMessagesForSelectedConversation()] : []
  const messages = state.conversation ? selectedMessages.map((message) => `<article class="${message.role}"><strong>${message.role === 'user' ? '你' : 'Codey'}</strong><p>${escapeHtml(message.content)}</p>${(message.blocks ?? []).map((block) => `<p>${escapeHtml(block.content)}</p>`).join('')}</article>`).join('') : '<p>选择一个会话查看卡片。</p>'
  root.innerHTML = `<main class="shell"><header><h1>Handover</h1><span class="status">${escapeHtml(state.status)}</span></header><div class="layout"><aside>${projects}</aside><section class="thread">${messages}<form id="send"><textarea id="message" rows="3" placeholder="发送用户消息…"></textarea><button>发送</button></form></section></div></main>`
  document.querySelectorAll<HTMLButtonElement>('.conversation').forEach((button) => { button.onclick = () => loadConversation(button.dataset.p!, button.dataset.c!).catch((error) => { state.status = error instanceof Error ? error.message : '加载失败'; render() }) })
  $('send').onsubmit = (event) => { event.preventDefault(); state.message = ($('message') as HTMLTextAreaElement).value; sendMessage().catch((error) => { state.status = error instanceof Error ? error.message : '发送失败'; render() }) }
}
async function restore(): Promise<void> {
  await loadPersisted()
  if (state.publicJwk && !state.deviceFingerprint) {
    state.deviceFingerprint = await deviceFingerprint(state.publicJwk)
    await savePersisted()
  }
  if (state.invitation && state.deviceToken && state.dataKey) {
    try { state.status = '已连接'; await loadCatalog() } catch (error) { state.status = error instanceof Error ? error.message : '恢复连接失败' }
  } else if (state.invitation && state.joinTicket && state.privateJwk && state.requestId) {
    state.status = '等待 Codey 审批…'; render(); await waitApproval()
  }
  render()
}
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => undefined)
void restore().catch((error) => { state.status = error instanceof Error ? error.message : '初始化失败'; render() })
