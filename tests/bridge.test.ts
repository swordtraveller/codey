import { createHash, randomBytes } from 'node:crypto'
import { rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const dataPath = join(tmpdir(), `codey-bridge-${process.pid}-${Date.now()}.json`)
let baseUrl = ''
let close: (() => Promise<void>) | undefined

async function request<T>(path: string, init: RequestInit = {}): Promise<{ status: number; body: T & { error?: string } }> {
  const response = await fetch(`${baseUrl}${path}`, init)
  return { status: response.status, body: await response.json() as T & { error?: string } }
}

beforeAll(async () => {
  process.env.BRIDGE_DATA_PATH = dataPath
  const { startBridgeServer } = await import('../bridge/server.mjs')
  const server = await startBridgeServer(0, '127.0.0.1')
  const address = server.address() as AddressInfo
  baseUrl = `http://127.0.0.1:${address.port}`
  close = () => new Promise<void>((resolve, reject) => server.close((error?: Error) => error ? reject(error) : resolve()))
})

afterAll(async () => {
  await close?.()
  await rm(dataPath, { force: true })
})

describe('Bridge relay', () => {
  it('requires approval, limits permissions, and stores only hashes for credentials', async () => {
    const ownerToken = randomBytes(32).toString('base64url')
    const created = await request<{ channelId: string; enrollmentSecret: string }>('/v1/channels', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ownerToken }),
    })
    expect(created.status).toBe(201)

    const channelId = created.body.channelId
    const deniedJoin = await request<{ error: string }>(`/v1/channels/${channelId}/join`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enrollmentSecret: 'invalid', deviceName: 'Handover PWA', devicePublicKey: { kty: 'EC' } }),
    })
    expect(deniedJoin.status).toBe(403)

    const joined = await request<{ requestId: string; joinTicket: string }>(`/v1/channels/${channelId}/join`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enrollmentSecret: created.body.enrollmentSecret, deviceName: 'Handover PWA', devicePublicKey: { kty: 'EC', crv: 'P-256', x: 'x', y: 'y' } }),
    })
    expect(joined.status).toBe(202)

    const ownerHeaders = { authorization: `Bearer ${ownerToken}`, 'content-type': 'application/json' }
    const envelope = { iv: 'a'.repeat(16), ciphertext: 'b'.repeat(32) }
    const pendingRead = await request<{ error: string }>(`/v1/channels/${channelId}/snapshots/catalog`, { headers: { authorization: 'Bearer unknown' } })
    expect(pendingRead.status).toBe(401)
    const deviceSnapshotWrite = await request<{ error: string }>(`/v1/channels/${channelId}/snapshots/catalog`, { method: 'PUT', headers: { authorization: 'Bearer unknown', 'content-type': 'application/json' }, body: JSON.stringify({ envelope }) })
    expect(deviceSnapshotWrite.status).toBe(401)

    const deviceToken = randomBytes(32).toString('base64url')
    const deviceTokenHash = createHash('sha256').update(deviceToken).digest('hex')
    const approved = await request<{ deviceId: string }>(`/v1/channels/${channelId}/requests/${joined.body.requestId}/approve`, { method: 'POST', headers: ownerHeaders, body: JSON.stringify({ deviceTokenHash, keyEnvelope: envelope }) })
    expect(approved.status).toBe(200)

    const bootstrap = await request<{ status: string; deviceId: string; keyEnvelope: typeof envelope }>(`/v1/channels/${channelId}/bootstrap`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ joinTicket: joined.body.joinTicket }) })
    expect(bootstrap.body).toMatchObject({ status: 'approved', deviceId: approved.body.deviceId, keyEnvelope: envelope })

    const snapshotWrite = await request<{ ok: boolean }>(`/v1/channels/${channelId}/snapshots/catalog`, { method: 'PUT', headers: ownerHeaders, body: JSON.stringify({ envelope }) })
    expect(snapshotWrite.status).toBe(200)
    const largeEnvelope = { iv: 'c'.repeat(16), ciphertext: 'd'.repeat(300 * 1024) }
    const largeSnapshotWrite = await request<{ ok: boolean }>(`/v1/channels/${channelId}/snapshots/large`, { method: 'PUT', headers: ownerHeaders, body: JSON.stringify({ envelope: largeEnvelope }) })
    expect(largeSnapshotWrite.status).toBe(200)
    const snapshotRead = await request<{ envelope: typeof envelope }>(`/v1/channels/${channelId}/snapshots/catalog`, { headers: { authorization: `Bearer ${deviceToken}` } })
    expect(snapshotRead.body.envelope).toEqual(envelope)

    const event = await request<{ ok: boolean }>(`/v1/channels/${channelId}/events`, { method: 'POST', headers: { authorization: `Bearer ${deviceToken}`, 'content-type': 'application/json' }, body: JSON.stringify({ id: 'event-1', envelope }) })
    expect(event.status).toBe(202)
    const events = await request<{ events: Array<{ id: string }> }>(`/v1/channels/${channelId}/events`, { headers: ownerHeaders })
    expect(events.body.events).toEqual([{ id: 'event-1', createdAt: expect.any(String), envelope }])
    const ack = await request<{ ok: boolean }>(`/v1/channels/${channelId}/events/event-1/ack`, { method: 'POST', headers: ownerHeaders, body: '{}' })
    expect(ack.status).toBe(200)
    expect((await request<{ events: unknown[] }>(`/v1/channels/${channelId}/events`, { headers: ownerHeaders })).body.events).toEqual([])

    const stored = await readFile(dataPath, 'utf8')
    expect(stored).not.toContain(ownerToken)
    expect(stored).not.toContain(deviceToken)
    expect(stored).toContain(deviceTokenHash)
  })
})
