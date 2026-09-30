import type { ModelCapabilitiesResult } from '../shared/types'

const MODELS_DEV_CATALOG_URL = 'https://models.dev/api.json'
const FETCH_TIMEOUT_MS = 15_000
const CATALOG_CACHE_TTL_MS = 10 * 60 * 1000

type CatalogModel = {
  id?: unknown
  limit?: { context?: unknown; output?: unknown }
  modalities?: { input?: unknown }
}

type ModelCapabilities = {
  maxContextTokens?: number
  maxOutputTokens?: number
  image: boolean
  pdf: boolean
  video: boolean
  audio: boolean
}

let catalogCache: { fetchedAt: number; catalog: unknown } | null = null

export function clearModelCatalogCache(): void {
  catalogCache = null
}

function toPositiveInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined
}

function toCapabilities(model: CatalogModel): ModelCapabilities {
  const input = model.modalities?.input
  const inputs = Array.isArray(input) ? input.filter((entry): entry is string => typeof entry === 'string') : []
  return {
    maxContextTokens: toPositiveInteger(model.limit?.context),
    maxOutputTokens: toPositiveInteger(model.limit?.output),
    image: inputs.includes('image'),
    pdf: inputs.includes('pdf'),
    video: inputs.includes('video'),
    audio: inputs.includes('audio'),
  }
}

export function findModelCapabilities(catalog: unknown, modelName: string): ModelCapabilities | null {
  const trimmed = modelName.trim()
  if (!trimmed || typeof catalog !== 'object' || catalog === null) return null
  const slash = trimmed.indexOf('/')
  const providerHint = slash > 0 ? trimmed.slice(0, slash).trim().toLowerCase() : ''
  const modelHint = (slash > 0 ? trimmed.slice(slash + 1) : trimmed).trim().toLowerCase()
  if (!modelHint) return null
  let plainMatch: ModelCapabilities | null = null
  for (const [providerSlug, provider] of Object.entries(catalog as Record<string, unknown>)) {
    if (typeof provider !== 'object' || provider === null) continue
    const models = (provider as { models?: unknown }).models
    if (typeof models !== 'object' || models === null) continue
    for (const [slug, model] of Object.entries(models as Record<string, unknown>)) {
      if (typeof model !== 'object' || model === null) continue
      const entry = model as CatalogModel
      const id = typeof entry.id === 'string' ? entry.id.trim().toLowerCase() : ''
      if (id !== modelHint && slug.trim().toLowerCase() !== modelHint) continue
      if (providerHint && providerSlug.toLowerCase() === providerHint) {
        return toCapabilities(entry)
      }
      plainMatch ??= toCapabilities(entry)
    }
  }
  return plainMatch
}

async function loadCatalog(): Promise<unknown> {
  if (catalogCache && Date.now() - catalogCache.fetchedAt < CATALOG_CACHE_TTL_MS) {
    return catalogCache.catalog
  }
  const response = await fetch(MODELS_DEV_CATALOG_URL, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
  if (!response.ok) {
    throw new Error(`models.dev responded with HTTP ${response.status}`)
  }
  const catalog = await response.json()
  catalogCache = { fetchedAt: Date.now(), catalog }
  return catalog
}

export async function fetchModelCapabilities(modelName: string): Promise<ModelCapabilitiesResult> {
  const name = modelName.trim()
  if (!name) return { status: 'not-found' }
  let catalog: unknown
  try {
    catalog = await loadCatalog()
  } catch {
    return { status: 'network-error' }
  }
  const capabilities = findModelCapabilities(catalog, name)
  return capabilities ? { status: 'ok', ...capabilities } : { status: 'not-found' }
}
