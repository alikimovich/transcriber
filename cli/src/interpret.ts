// The transport half of interpretation: auth, timeouts, retries, backoff.
//
// Everything vendor-specific lives in `providers/`. This file should never need
// to know which one it is talking to — if it grows a `provider.id === 'xai'`
// branch, that logic belongs in the provider instead.

import { loadApiKey } from './credentials.ts'
import { formatSetupContext, formatWindow, INSTRUCTIONS } from './prompt.ts'
import {
  type ParsedResponse,
  type Provider,
  type ProviderId,
  type ProviderRequest,
  resolveProvider
} from './providers/index.ts'
import { isRecord, str } from './providers/parsing.ts'
import { backoff, formatMs, suggestedDelayMs } from './retry.ts'
import type { SetupContext, Turn } from './types.ts'

const DEFAULT_MAX_RETRIES = 2
const DEFAULT_BASE_DELAY_MS = 400
const DEFAULT_MAX_DELAY_MS = 8_000
const DEFAULT_TIMEOUT_MS = 20_000

export type InterpretResult =
  | ParsedResponse
  /** Transport, auth or rate-limit failure. */
  | {
      kind: 'error'
      message: string
      status: number | null
      retryable: boolean
      /** Server-suggested wait, when it told us one. */
      retryAfterMs: number | null
      aborted: boolean
    }

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>

export type RetryInfo = {
  attempt: number
  delayMs: number
  status: number | null
  reason: string
}

export type InterpretArgs = {
  context: SetupContext
  turns: Turn[]
  model?: string
}

export type InterpretOptions = {
  /** Overrides the env var and the saved setting. */
  provider?: ProviderId
  /** Defaults to the provider's env var, then the login Keychain. */
  apiKey?: string
  model?: string
  /** Overrides the provider's endpoint. Testing hook. */
  baseUrl?: string
  /** Caller-owned cancellation, e.g. a newer question superseding this one. */
  signal?: AbortSignal
  /** Per-attempt timeout. 0 disables it. */
  timeoutMs?: number
  maxRetries?: number
  baseDelayMs?: number
  maxDelayMs?: number
  fetch?: FetchLike
  sleep?: (ms: number) => Promise<void>
  random?: () => number
  now?: () => number
  onRetry?: (info: RetryInfo) => void
  /** Provider preference read from settings, when the caller has it. */
  savedProvider?: ProviderId | null
}

/**
 * Interpret the current transcript window. Never throws; inspect `kind`.
 */
export async function interpret(
  args: InterpretArgs,
  options: InterpretOptions = {}
): Promise<InterpretResult> {
  const provider = resolveProvider(options.provider, options.savedProvider)
  const apiKey = options.apiKey ?? loadApiKey(provider)
  if (apiKey === undefined || apiKey === '') {
    return transportError(
      `no ${provider.label} API key: set ${provider.envVar}, or run ./install.sh to store one in the Keychain`,
      { retryable: false }
    )
  }

  const request = provider.buildRequest(
    {
      context: args.context,
      turns: args.turns,
      instructions: INSTRUCTIONS,
      contextText: formatSetupContext(args.context),
      windowText: formatWindow(args.turns),
      model: options.model ?? args.model
    },
    apiKey
  )
  if (options.baseUrl !== undefined) request.url = options.baseUrl

  return sendRequest(provider, request, options)
}

/** The transport loop, exposed for callers that built their own request. */
export async function sendRequest(
  provider: Provider,
  request: ProviderRequest,
  options: InterpretOptions = {}
): Promise<InterpretResult> {
  const doFetch = options.fetch ?? ((input, init) => fetch(input, init))
  const sleep = options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)))
  const random = options.random ?? Math.random
  const now = options.now ?? Date.now
  const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES
  const baseDelayMs = options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS
  const maxDelayMs = options.maxDelayMs ?? DEFAULT_MAX_DELAY_MS
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const payload = JSON.stringify(request.body)

  for (let attempt = 0; ; attempt++) {
    if (isAborted(options.signal)) {
      return transportError('request aborted', { retryable: false, aborted: true })
    }

    let response: Response
    try {
      response = await attemptFetch(doFetch, request, payload, options.signal, timeoutMs)
    } catch (cause) {
      if (isAborted(options.signal)) {
        return transportError('request aborted', { retryable: false, aborted: true })
      }
      // Our own per-attempt timeout, not the caller's cancellation.
      const message =
        errorName(cause) === 'TimeoutError'
          ? `request timed out after ${timeoutMs}ms`
          : `network error: ${describe(cause)}`
      if (attempt >= maxRetries) return transportError(message, { retryable: true })
      const delayMs = backoff(attempt, baseDelayMs, maxDelayMs, random)
      options.onRetry?.({ attempt, delayMs, status: null, reason: message })
      await sleep(delayMs)
      continue
    }

    if (response.ok) return await readSuccess(provider, response)

    const status = response.status
    const detail = await readErrorBody(response)
    const message = `${provider.label} request failed (${status}${detail === null ? '' : `: ${detail}`})`
    // 400/401/403/404 are the request's fault; retrying just burns time.
    const retryable = status === 429 || status >= 500
    // xAI documents no rate-limit headers, so this is null there and we fall
    // back to blind backoff — which is what their docs recommend.
    const suggestedMs = suggestedDelayMs(response.headers, now())

    if (!retryable || attempt >= maxRetries) {
      return transportError(message, { status, retryable, retryAfterMs: suggestedMs })
    }
    if (suggestedMs !== null && suggestedMs > maxDelayMs) {
      // Waiting minutes is useless mid-interview; surface it and let the UI say so.
      return transportError(`${message}; retry in ${formatMs(suggestedMs)}`, {
        status,
        retryable: true,
        retryAfterMs: suggestedMs
      })
    }
    const delayMs = Math.min(
      maxDelayMs,
      Math.max(backoff(attempt, baseDelayMs, maxDelayMs, random), suggestedMs ?? 0)
    )
    options.onRetry?.({ attempt, delayMs, status, reason: message })
    await sleep(delayMs)
  }
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

async function attemptFetch(
  doFetch: FetchLike,
  request: ProviderRequest,
  payload: string,
  signal: AbortSignal | undefined,
  timeoutMs: number
): Promise<Response> {
  const controller = new AbortController()
  const forward = () => controller.abort(signal?.reason)
  signal?.addEventListener('abort', forward, { once: true })
  const timer =
    timeoutMs > 0
      ? setTimeout(() => controller.abort(new DOMException('timed out', 'TimeoutError')), timeoutMs)
      : null
  try {
    return await doFetch(request.url, {
      method: 'POST',
      headers: request.headers,
      body: payload,
      signal: controller.signal
    })
  } finally {
    if (timer !== null) clearTimeout(timer)
    signal?.removeEventListener('abort', forward)
  }
}

async function readSuccess(provider: Provider, response: Response): Promise<InterpretResult> {
  let text: string
  try {
    text = await response.text()
  } catch (cause) {
    return transportError(`could not read response body: ${describe(cause)}`, { retryable: true })
  }
  try {
    return provider.parseResponse(JSON.parse(text))
  } catch (cause) {
    return {
      kind: 'malformed',
      message: `response body was not JSON: ${describe(cause)}`,
      raw: text.slice(0, 500)
    }
  }
}

async function readErrorBody(response: Response): Promise<string | null> {
  let text: string
  try {
    text = await response.text()
  } catch {
    return null
  }
  if (text === '') return null
  try {
    const parsed: unknown = JSON.parse(text)
    // OpenAI nests under `error.message`; xAI's inference error shape is
    // undocumented but observed as `{error: {code, message}}` elsewhere. Fall
    // back to the raw body when neither matches.
    if (isRecord(parsed) && isRecord(parsed.error)) {
      const message = str(parsed.error.message)
      if (message !== null && message !== '') return message
    }
    if (isRecord(parsed)) {
      const message = str(parsed.message) ?? str(parsed.error)
      if (message !== null && message !== '') return message
    }
  } catch {
    // Not JSON — fall through to the raw body.
  }
  return text.slice(0, 300)
}

function transportError(
  message: string,
  options: {
    status?: number
    retryable: boolean
    retryAfterMs?: number | null
    aborted?: boolean
  }
): InterpretResult {
  return {
    kind: 'error',
    message,
    status: options.status ?? null,
    retryable: options.retryable,
    retryAfterMs: options.retryAfterMs ?? null,
    aborted: options.aborted ?? false
  }
}

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true
}

function errorName(cause: unknown): string | null {
  return cause instanceof Error ? cause.name : null
}

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}
