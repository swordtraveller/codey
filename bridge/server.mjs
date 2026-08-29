import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const MAX_BODY_BYTES = 256 * 1024
const MAX_SNAPSHOT_BYTES = 4 * 1024 * 1024
const MAX_SNAPSHOT_BODY_BYTES = MAX_SNAPSHOT_BYTES + 16 * 1024
const ENROLLMENT_TTL_MS = 2 * 60 * 1000
const REQUEST_TTL_MS = 10 * 60 * 1000
const EVENT_TTL_MS = 24 * 60 * 60 * 1000
const CHANNEL_TTL_MS = 30 * 24 * 60 * 60 * 1000
const MAX_EVENTS_PER_DEVICE = 20
const RATE_WINDOW_MS = 60 * 1000
const dataPath = process.env.BRIDGE_DATA_PATH || join(dirname(fileURLToPath(import.meta.url)), '.data', 'bridge.json')

const state = { channels: {} }
const limits = new Map()

const digest = (value) => createHash('sha256').update(value).digest('hex')
const randomToken = (bytes = 32) => randomBytes(bytes).toString('base64url')
const now = () => Date.now()
const json = (res, status, value) => {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'access-control-allow-origin': '*',
    'access-control-allow-headers': 'authorization, content-type',
    'access-control-allow-methods': 'GET, POST, PUT, OPTIONS',
  })
  res.end(JSON.stringify(value))
}
const fail = (res, status, error) => json(res, status, { error })
const opaque = (value) => value && typeof value === 'object' && typeof value.iv === 'string' && typeof value.ciphertext === 'string' && value.iv.length <= 128 && value.ciphertext.length <= MAX_SNAPSHOT_BYTES
const equalHash = (actual, expected) => {
  if (typeof actual !== 'string' || typeof expected !== 'string') return false
  const a = Buffer.from(actual); const b = Buffer.from(expected)
  return a.length === b.length && timingSafeEqual(a, b)
}

async function persist() {
  await mkdir(dirname(dataPath), { recursive: true })
  await writeFile(dataPath, JSON.stringify(state), 'utf8')
}
async function load() {
  try {
    const saved = JSON.parse(await readFile(dataPath, 'utf8'))
    if (saved && typeof saved.channels === 'object') state.channels = saved.channels
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
  cleanup()
}
function cleanup() {
  const time = now()
  for (const [id, channel] of Object.entries(state.channels)) {
    if (channel.createdAt + CHANNEL_TTL_MS < time) { delete state.channels[id]; continue }
    for (const [requestId, request] of Object.entries(channel.requests)) {
      if (request.createdAt + REQUEST_TTL_MS < time || request.status === 'rejected') delete channel.requests[requestId]
    }
    channel.events = channel.events.filter((event) => event.createdAt + EVENT_TTL_MS >= time)
    for (const [eventId, createdAt] of Object.entries(channel.eventIds)) if (createdAt + EVENT_TTL_MS < time) delete channel.eventIds[eventId]
  }
}
function body(req, maxBytes = MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > maxBytes) { reject(new Error('Request body is too large')); req.destroy(); return }
      chunks.push(chunk)
    })
    req.on('end', () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}) } catch { reject(new Error('Invalid JSON')) }
    })
    req.on('error', reject)
  })
}
function token(req) {
  const value = req.headers.authorization
  return typeof value === 'string' && value.startsWith('Bearer ') ? value.slice(7) : ''
}
function channelFor(res, id) {
  const channel = state.channels[id]
  if (!channel) { fail(res, 404, 'Channel not found'); return null }
  return channel
}
function owner(res, req, channel) {
  if (!equalHash(digest(token(req)), channel.ownerTokenHash)) { fail(res, 401, 'Owner authorization required'); return false }
  return true
}
function device(res, req, channel) {
  const hash = digest(token(req))
  const entry = Object.values(channel.devices).find((candidate) => equalHash(hash, candidate.tokenHash))
  if (!entry) { fail(res, 401, 'Approved device authorization required'); return null }
  return entry
}
function limit(res, key, count = 1) {
  const time = now(); const record = limits.get(key)
  if (!record || record.until <= time) { limits.set(key, { count, until: time + RATE_WINDOW_MS }); return true }
  if (record.count + count > MAX_EVENTS_PER_DEVICE) { fail(res, 429, 'Rate limit exceeded'); return false }
  record.count += count; return true
}

async function route(req, res) {
  if (req.method === 'OPTIONS') return json(res, 204, {})
  const url = new URL(req.url || '/', 'http://bridge.invalid')
  const parts = url.pathname.split('/').filter(Boolean)
  cleanup()
  try {
    if (req.method === 'GET' && url.pathname === '/health') return json(res, 200, { ok: true, protocolVersion: 1 })
    if (req.method === 'POST' && url.pathname === '/v1/channels') {
      const input = await body(req)
      if (typeof input.ownerToken !== 'string' || input.ownerToken.length < 32) return fail(res, 400, 'Invalid owner credential')
      const channelId = randomUUID()
      const enrollmentSecret = randomToken()
      state.channels[channelId] = {
        createdAt: now(), ownerTokenHash: digest(input.ownerToken), enrollmentHash: digest(enrollmentSecret), enrollmentExpiresAt: now() + ENROLLMENT_TTL_MS,
        requests: {}, devices: {}, snapshots: {}, events: [], eventIds: {},
      }
      await persist()
      return json(res, 201, { channelId, enrollmentSecret, enrollmentExpiresAt: new Date(state.channels[channelId].enrollmentExpiresAt).toISOString() })
    }
    if (parts[0] !== 'v1' || parts[1] !== 'channels' || !parts[2]) return fail(res, 404, 'Not found')
    const channel = channelFor(res, parts[2]); if (!channel) return
    const action = parts.slice(3)
    if (req.method === 'POST' && action[0] === 'enrollment' && action[1] === 'refresh') {
      if (!owner(res, req, channel)) return
      const enrollmentSecret = randomToken()
      channel.enrollmentHash = digest(enrollmentSecret)
      channel.enrollmentExpiresAt = now() + ENROLLMENT_TTL_MS
      await persist()
      return json(res, 200, { enrollmentSecret, enrollmentExpiresAt: new Date(channel.enrollmentExpiresAt).toISOString() })
    }
    if (req.method === 'POST' && action[0] === 'join') {
      const input = await body(req)
      if (!limit(res, `join:${parts[2]}:${req.socket.remoteAddress || ''}`, 1)) return
      if (channel.enrollmentExpiresAt < now() || !equalHash(digest(input.enrollmentSecret || ''), channel.enrollmentHash)) return fail(res, 403, 'Invitation expired or invalid')
      if (typeof input.deviceName !== 'string' || input.deviceName.trim().length < 1 || input.deviceName.length > 64 || !input.devicePublicKey || typeof input.devicePublicKey !== 'object') return fail(res, 400, 'Invalid device request')
      const requestId = randomUUID(); const joinTicket = randomToken()
      channel.requests[requestId] = { id: requestId, deviceName: input.deviceName.trim(), devicePublicKey: input.devicePublicKey, joinTicketHash: digest(joinTicket), createdAt: now(), status: 'pending' }
      await persist(); return json(res, 202, { requestId, joinTicket, expiresAt: new Date(channel.enrollmentExpiresAt).toISOString() })
    }
    if (req.method === 'GET' && action[0] === 'requests') {
      if (!owner(res, req, channel)) return
      const requests = Object.values(channel.requests).filter((item) => item.status === 'pending').map(({ id, deviceName, devicePublicKey, createdAt }) => ({ id, deviceName, devicePublicKey, createdAt: new Date(createdAt).toISOString() }))
      return json(res, 200, { requests })
    }
    if (req.method === 'GET' && action[0] === 'devices') {
      if (!owner(res, req, channel)) return
      const devices = Object.values(channel.devices).map(({ id, name, approvedAt }) => ({ id, name, approvedAt: new Date(approvedAt).toISOString() }))
      return json(res, 200, { devices })
    }
    if (req.method === 'POST' && action[0] === 'requests' && action[1] && action[2] === 'approve') {
      if (!owner(res, req, channel)) return
      const input = await body(req); const request = channel.requests[action[1]]
      if (!request || request.status !== 'pending' || !opaque(input.keyEnvelope) || typeof input.deviceTokenHash !== 'string' || !/^[a-f0-9]{64}$/.test(input.deviceTokenHash)) return fail(res, 400, 'Invalid approval')
      const deviceId = randomUUID()
      request.status = 'approved'; request.deviceId = deviceId
      channel.devices[deviceId] = { id: deviceId, name: request.deviceName, tokenHash: input.deviceTokenHash, keyEnvelope: input.keyEnvelope, approvedAt: now() }
      await persist(); return json(res, 200, { deviceId })
    }
    if (req.method === 'POST' && action[0] === 'requests' && action[1] && action[2] === 'reject') {
      if (!owner(res, req, channel)) return
      const request = channel.requests[action[1]]; if (!request || request.status !== 'pending') return fail(res, 404, 'Pending request not found')
      request.status = 'rejected'; await persist(); return json(res, 200, { ok: true })
    }
    if (req.method === 'POST' && action[0] === 'bootstrap') {
      const input = await body(req)
      const request = Object.values(channel.requests).find((item) => equalHash(digest(input.joinTicket || ''), item.joinTicketHash))
      if (!request) return fail(res, 401, 'Join ticket required')
      if (request.status !== 'approved' || !request.deviceId) return json(res, 202, { status: request.status })
      const entry = channel.devices[request.deviceId]
      return json(res, 200, { status: 'approved', deviceId: entry.id, keyEnvelope: entry.keyEnvelope })
    }
    if (req.method === 'PUT' && action[0] === 'snapshots' && action[1]) {
      if (!owner(res, req, channel)) return
      const input = await body(req, MAX_SNAPSHOT_BODY_BYTES); if (!opaque(input.envelope) || JSON.stringify(input.envelope).length > MAX_SNAPSHOT_BYTES) return fail(res, 400, 'Invalid encrypted snapshot')
      channel.snapshots[action[1]] = { envelope: input.envelope, updatedAt: now() }; await persist(); return json(res, 200, { ok: true })
    }
    if (req.method === 'GET' && action[0] === 'snapshots' && action[1]) {
      if (!device(res, req, channel)) return
      const snapshot = channel.snapshots[action[1]]; if (!snapshot) return fail(res, 404, 'Snapshot not found')
      return json(res, 200, snapshot)
    }
    if (req.method === 'POST' && action[0] === 'events' && action.length === 1) {
      const entry = device(res, req, channel); if (!entry) return
      if (!limit(res, `event:${parts[2]}:${entry.id}`)) return
      const input = await body(req)
      if (typeof input.id !== 'string' || input.id.length > 128 || !opaque(input.envelope)) return fail(res, 400, 'Invalid encrypted event')
      if (channel.eventIds[input.id]) return json(res, 200, { ok: true, duplicate: true })
      channel.eventIds[input.id] = now(); channel.events.push({ id: input.id, deviceId: entry.id, envelope: input.envelope, createdAt: now() }); await persist(); return json(res, 202, { ok: true })
    }
    if (req.method === 'GET' && action[0] === 'events') {
      if (!owner(res, req, channel)) return
      const events = channel.events.slice(0, 20)
      return json(res, 200, { events: events.map(({ id, envelope, createdAt }) => ({ id, envelope, createdAt: new Date(createdAt).toISOString() })) })
    }
    if (req.method === 'POST' && action[0] === 'events' && action[1] && action[2] === 'ack') {
      if (!owner(res, req, channel)) return
      const index = channel.events.findIndex((event) => event.id === action[1])
      if (index < 0) return fail(res, 404, 'Event not found')
      channel.events.splice(index, 1); await persist(); return json(res, 200, { ok: true })
    }
    return fail(res, 404, 'Not found')
  } catch (error) { return fail(res, error?.message === 'Request body is too large' ? 413 : 400, error?.message || 'Bad request') }
}

export async function startBridgeServer(port = 8787, host = '127.0.0.1') {
  await load()
  const server = createServer((req, res) => void route(req, res))
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, resolve) })
  return server
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const portIndex = process.argv.indexOf('--port'); const port = portIndex >= 0 ? Number(process.argv[portIndex + 1]) : 8787
  startBridgeServer(Number.isInteger(port) ? port : 8787, process.env.BRIDGE_HOST || '0.0.0.0').then((server) => {
    console.log(`Bridge listening on http://${process.env.BRIDGE_HOST || '0.0.0.0'}:${port}`)
    for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close(() => process.exit(0)))
  }).catch((error) => { console.error(error); process.exit(1) })
}

