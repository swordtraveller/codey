import type { ModelConfig, ModelConnectivityResult } from '../shared/types'

/** Probes an OpenAI-compatible endpoint: fetches /models with the configured
 *  API key and checks whether the configured model name is listed. */
export async function testModelConnectivity(model: ModelConfig): Promise<ModelConnectivityResult> {
  const base = model.baseUrl.replace(/\/+$/, '')
  let response: Response
  try {
    response = await fetch(`${base}/models`, {
      headers: { authorization: `Bearer ${model.apiKey}` },
      signal: AbortSignal.timeout(15_000),
    })
  } catch (error) {
    return { status: 'network-error', detail: error instanceof Error ? error.message : String(error) }
  }
  if (response.status === 401 || response.status === 403) {
    return { status: 'auth-error', detail: `HTTP ${response.status}` }
  }
  if (!response.ok) {
    return { status: 'endpoint-error', detail: `HTTP ${response.status}` }
  }
  try {
    const payload = await response.json() as { data?: Array<{ id?: string }> }
    const ids = (payload.data ?? []).map((entry) => entry.id).filter((id): id is string => Boolean(id))
    if (ids.some((id) => id.toLowerCase() === model.modelName.trim().toLowerCase())) {
      return { status: 'ok', models: ids.length }
    }
    return { status: 'model-not-found', available: ids.slice(0, 20) }
  } catch {
    return { status: 'endpoint-error', detail: 'unparseable /models response' }
  }
}
