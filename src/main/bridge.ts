import { createHash, randomBytes, randomUUID, webcrypto } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { app, safeStorage } from 'electron'
import type { BridgeChannelStatus, BridgeEnvelope, BridgePendingRequest, HandoverCatalog, HandoverConversation, HandoverUserMessage } from '../shared/bridge'
import type { Project } from '../shared/types'
import { log } from './logger'

const crypto: Crypto = webcrypto as unknown as Crypto
const encoder = new TextEncoder()
const decoder = new TextDecoder()
const PROTOCOL = 1
const MAX_REMOTE_MESSAGE_CHARS = 12_000

type StoredBridgeChannel = {
  bridgeUrl: string
  channelId: string
  ownerToken: string
  enrollmentSecret: string
  enrollmentExpiresAt: string
  codeyPrivateKey: JsonWebKey
  codeyPublicKey: JsonWebKey
  dataKey: string
  processedEventIds: string[]
}

type StoredBridgeState = { channel: StoredBridgeChannel | null }

type RequestResponse = { requests: BridgePendingRequest[] }
type BootstrapApproval = { deviceId: string }

function bridgeStatePath(): string {
  return join(app.getPath('userData'), 'bridge-handover.json')
}

function base64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64url')
}
function fromBase64url(value: string): Uint8Array {
  return new Uint8Array(Buffer.from(value, 'base64url'))
}
function asBufferSource(value: Uint8Array): BufferSource {
  return value as unknown as BufferSource
}
function publicKeyFingerprint(publicKey: JsonWebKey): string {
  const canonical = JSON.stringify(Object.fromEntries(Object.keys(publicKey).sort().map((key) => [key, publicKey[key as keyof JsonWebKey]])))
  return createHash('sha256').update(canonical).digest('hex').slice(0, 24).match(/.{1,4}/g)?.join('-') ?? ''
}
function invitationUrl(channel: StoredBridgeChannel): string {
  const params = new URLSearchParams({
    v: String(PROTOCOL), bridge: channel.bridgeUrl, channel: channel.channelId,
    secret: channel.enrollmentSecret, pub: JSON.stringify(channel.codeyPublicKey),
  })
  return `codey-handover://pair?${params.toString()}`
}
function normalizeBridgeUrl(value: string): string {
  const url = new URL(value.trim())
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Bridge URL must use HTTP or HTTPS')
  if (url.protocol === 'http:' && !['localhost', '127.0.0.1', '::1'].includes(url.hostname)) throw new Error('Use HTTPS for a non-local Bridge server')
  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('Use the Bridge server origin only')
  return url.origin
}

async function derivePairwiseKey(privateJwk: JsonWebKey, publicJwk: JsonWebKey, info: string): Promise<CryptoKey> {
  const own = await crypto.subtle.importKey('jwk', privateJwk, { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits'])
  const other = await crypto.subtle.importKey('jwk', publicJwk, { name: 'ECDH', namedCurve: 'P-256' }, false, [])
  const bits = await crypto.subtle.deriveBits({ name: 'ECDH', public: other }, own, 256)
  const material = await crypto.subtle.importKey('raw', bits, 'HKDF', false, ['deriveKey'])
  return crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: encoder.encode('codey-handover-v1'), info: encoder.encode(info) }, material, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
}
async function aesEncrypt(key: CryptoKey, input: unknown, aad: string): Promise<BridgeEnvelope> {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: asBufferSource(encoder.encode(aad)) }, key, asBufferSource(encoder.encode(JSON.stringify(input))))
  return { iv: base64url(iv), ciphertext: base64url(new Uint8Array(encrypted)) }
}
async function aesDecrypt<T>(key: CryptoKey, envelope: BridgeEnvelope, aad: string): Promise<T> {
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: asBufferSource(fromBase64url(envelope.iv)), additionalData: asBufferSource(encoder.encode(aad)) }, key, asBufferSource(fromBase64url(envelope.ciphertext)))
  return JSON.parse(decoder.decode(plain)) as T
}
async function dataKey(channel: StoredBridgeChannel): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', asBufferSource(fromBase64url(channel.dataKey)), 'AES-GCM', false, ['encrypt', 'decrypt'])
}

export class BridgeHandoverService {
  private state: StoredBridgeState = { channel: null }
  private loaded = false

  private async load(): Promise<void> {
    if (this.loaded) return
    this.loaded = true
    try {
      const stored = JSON.parse(await readFile(bridgeStatePath(), 'utf8')) as { encrypted?: boolean; payload?: string } | StoredBridgeState
      if ('payload' in stored && stored.encrypted && stored.payload && safeStorage.isEncryptionAvailable()) {
        this.state = JSON.parse(safeStorage.decryptString(Buffer.from(stored.payload, 'base64')))
      } else if ('channel' in stored && stored.channel === null) this.state = stored
      else if ('channel' in stored) log.warn('bridge.state.unencrypted.ignored', {})
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') log.warn('bridge.state.read.failed', error)
    }
  }
  private async save(): Promise<void> {
    if (!safeStorage.isEncryptionAvailable()) throw new Error('OS secure storage is required for Bridge pairing')
    const raw = JSON.stringify(this.state)
    const stored = { encrypted: true, payload: safeStorage.encryptString(raw).toString('base64') }
    await writeFile(bridgeStatePath(), JSON.stringify(stored), 'utf8')
  }
  private async request<T>(path: string, init: RequestInit, owner = false): Promise<T> {
    await this.load()
    const channel = this.state.channel
    if (!channel) throw new Error('No Bridge channel')
    const response = await fetch(`${channel.bridgeUrl}${path}`, {
      ...init,
      headers: { 'content-type': 'application/json', ...(owner ? { authorization: `Bearer ${channel.ownerToken}` } : {}), ...(init.headers ?? {}) },
    })
    const result = await response.json() as T & { error?: string }
    if (!response.ok) throw new Error(result.error || 'Bridge request failed')
    return result
  }

  async status(): Promise<BridgeChannelStatus | null> {
    await this.load(); const channel = this.state.channel
    if (!channel) return null
    const requests = await this.request<RequestResponse>(`/v1/channels/${channel.channelId}/requests`, { method: 'GET' }, true).catch(() => ({ requests: [] }))
    return {
      channelId: channel.channelId, bridgeUrl: channel.bridgeUrl, enrollmentExpiresAt: channel.enrollmentExpiresAt,
      invitation: invitationUrl(channel), pendingRequests: requests.requests.map((request) => ({ ...request, fingerprint: publicKeyFingerprint(request.devicePublicKey) })), approvedDevices: (await this.request<{ devices: Array<{ id: string; name: string; approvedAt: string }> }>(`/v1/channels/${channel.channelId}/devices`, { method: 'GET' }, true).catch(() => ({ devices: [] }))).devices,
    }
  }

  async createChannel(bridgeUrlInput: string): Promise<BridgeChannelStatus> {
    await this.load()
    if (!safeStorage.isEncryptionAvailable()) throw new Error('OS secure storage is required for Bridge pairing')
    const bridgeUrl = normalizeBridgeUrl(bridgeUrlInput)
    const ownerToken = base64url(randomBytes(32))
    const keyPair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'])
    const codeyPrivateKey = await crypto.subtle.exportKey('jwk', keyPair.privateKey)
    const codeyPublicKey = await crypto.subtle.exportKey('jwk', keyPair.publicKey)
    const response = await fetch(`${bridgeUrl}/v1/channels`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ownerToken }) })
    const created = await response.json() as { channelId?: string; enrollmentSecret?: string; enrollmentExpiresAt?: string; error?: string }
    if (!response.ok || !created.channelId || !created.enrollmentSecret || !created.enrollmentExpiresAt) throw new Error(created.error || 'Could not create channel')
    this.state.channel = { bridgeUrl, channelId: created.channelId, ownerToken, enrollmentSecret: created.enrollmentSecret, enrollmentExpiresAt: created.enrollmentExpiresAt, codeyPrivateKey, codeyPublicKey, dataKey: base64url(randomBytes(32)), processedEventIds: [] }
    await this.save()
    return (await this.status())!
  }

  async approve(requestId: string, devicePublicKey: JsonWebKey, projects: Project[]): Promise<void> {
    await this.load(); const channel = this.state.channel
    if (!channel) throw new Error('No Bridge channel')
    const key = await derivePairwiseKey(channel.codeyPrivateKey, devicePublicKey, `${channel.channelId}:${requestId}`)
    const deviceToken = base64url(randomBytes(32))
    const keyEnvelope = await aesEncrypt(key, { dataKey: channel.dataKey, deviceToken }, `${channel.channelId}:${requestId}`)
    await this.request<BootstrapApproval>(`/v1/channels/${channel.channelId}/requests/${requestId}/approve`, { method: 'POST', body: JSON.stringify({ keyEnvelope, deviceTokenHash: createHash('sha256').update(deviceToken).digest('hex') }) }, true)
    await this.sync(projects)
  }
  async reject(requestId: string): Promise<void> {
    await this.load(); const channel = this.state.channel; if (!channel) return
    await this.request(`/v1/channels/${channel.channelId}/requests/${requestId}/reject`, { method: 'POST', body: '{}' }, true)
  }
  async sync(projects: Project[]): Promise<void> {
    await this.load(); const channel = this.state.channel; if (!channel) return
    const key = await dataKey(channel)
    const catalog: HandoverCatalog = { updatedAt: new Date().toISOString(), projects: projects.map((project) => ({ id: project.id, name: project.name, conversations: project.conversations.map((conversation) => ({ id: conversation.id, title: conversation.title, updatedAt: conversation.messages.at(-1)?.createdAt })) })) }
    await this.putSnapshot('catalog', await aesEncrypt(key, catalog, `${channel.channelId}:catalog`))
    for (const project of projects) for (const conversation of project.conversations) {
      const safe: HandoverConversation = { projectId: project.id, conversationId: conversation.id, title: conversation.title, updatedAt: conversation.messages.at(-1)?.createdAt ?? new Date().toISOString(), messages: conversation.messages.map((message) => ({ id: message.id, role: message.role, content: message.content, blocks: message.blocks?.filter((block): block is { type: 'content'; content: string } => block.type === 'content'), createdAt: message.createdAt })) }
      await this.putSnapshot(`conversation-${conversation.id}`, await aesEncrypt(key, safe, `${channel.channelId}:conversation-${conversation.id}`))
    }
  }
  private async putSnapshot(name: string, envelope: BridgeEnvelope): Promise<void> {
    const channel = this.state.channel!; await this.request(`/v1/channels/${channel.channelId}/snapshots/${encodeURIComponent(name)}`, { method: 'PUT', body: JSON.stringify({ envelope }) }, true)
  }
  async processEvents(process: (message: HandoverUserMessage) => Promise<boolean>): Promise<void> {
    await this.load(); const channel = this.state.channel; if (!channel) return
    const result = await this.request<{ events: Array<{ id: string; envelope: BridgeEnvelope }> }>(`/v1/channels/${channel.channelId}/events`, { method: 'GET' }, true)
    const key = await dataKey(channel)
    for (const event of result.events) {
      if (channel.processedEventIds.includes(event.id)) continue
      try {
        const message = await aesDecrypt<HandoverUserMessage>(key, event.envelope, `${channel.channelId}:event:${event.id}`)
        if (!message || typeof message.content !== 'string' || message.content.trim().length === 0 || message.content.length > MAX_REMOTE_MESSAGE_CHARS || !message.projectId || !message.conversationId || !message.clientMessageId) throw new Error('Invalid handover message')
        if (await process(message)) {
          await this.request(`/v1/channels/${channel.channelId}/events/${event.id}/ack`, { method: 'POST', body: '{}' }, true)
          channel.processedEventIds = [...channel.processedEventIds, event.id].slice(-50)
          await this.save()
        }
      } catch (error) { log.warn('bridge.event.process.failed', error) }
    }
  }
}
