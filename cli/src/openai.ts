/**
 * Interpretation via the OpenAI Responses API.
 *
 * Details here that look wrong from memory but are not:
 *
 * - The endpoint is `POST /v1/responses` with only `Authorization` and
 *   `Content-Type`. No beta header, no version header.
 * - Structured output lives at `text.format`, with `name`/`strict`/`schema` as
 *   siblings. The `{ json_schema: { name, schema } }` nesting is the Chat
 *   Completions shape and is rejected here. See `prompt.ts`.
 * - The result is read by walking `output[]`, not by reading `output_text`
 *   (an SDK convenience that does not exist on the wire) and not by indexing
 *   `output[0]` (which is a `reasoning` item on reasoning models).
 * - `x-ratelimit-reset-*` headers are Go duration strings — `"6m0s"`, not
 *   `"360"`. `parseInt` on those silently yields 6.
 *
 * Nothing in this module throws. Transport failures, refusals and unparseable
 * output are all outcomes a live UI has to render, so they come back as a
 * discriminated union instead.
 */

import { type BuildRequestArgs, buildRequestBody, type ResponsesRequest } from './prompt.ts'
import { type Interpretation, interpretationSchema } from './types.ts'

export const RESPONSES_URL = 'https://api.openai.com/v1/responses'

const DEFAULT_MAX_RETRIES = 2
const DEFAULT_BASE_DELAY_MS = 400
const DEFAULT_MAX_DELAY_MS = 8_000
const DEFAULT_TIMEOUT_MS = 20_000

export type TokenUsage = {
  inputTokens: number
  outputTokens: number
  totalTokens: number
  cachedInputTokens: number
}

export type InterpretResult =
  | {
      kind: 'ok'
      interpretation: Interpretation
      responseId: string | null
      usage: TokenUsage | null
    }
  /** The model declined to answer. `status` is still `completed` in this case. */
  | { kind: 'refusal'; message: string }
  /** The response did not finish — most often `max_output_tokens`. */
  | { kind: 'incomplete'; reason: string; message: string }
  /** Completed, but the payload was not a valid `Interpretation`. */
  | { kind: 'malformed'; message: string; raw: string | null }
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

export type InterpretOptions = {
  /** Defaults to `process.env.OPENAI_API_KEY`. */
  apiKey?: string
  model?: string
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
}

/**
 * Interpret the current transcript window. Never throws; inspect `kind`.
 */
export async function interpret(
  args: BuildRequestArgs,
  options: InterpretOptions = {}
): Promise<InterpretResult> {
  const body = buildRequestBody({ ...args, model: options.model ?? args.model })
  return sendInterpretRequest(body, options)
}

/** The transport half of {@link interpret}, for callers that built their own body. */
export async function sendInterpretRequest(
  body: ResponsesRequest,
  options: InterpretOptions = {}
): Promise<InterpretResult> {
  const apiKey = options.apiKey ?? process.env.OPENAI_API_KEY
  if (apiKey === undefined || apiKey === '') {
    return transportError('OPENAI_API_KEY is not set', { retryable: false })
  }

  const doFetch = options.fetch ?? ((input, init) => fetch(input, init))
  const sleep = options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)))
  const random = options.random ?? Math.random
  const now = options.now ?? Date.now
  const url = options.baseUrl ?? RESPONSES_URL
  const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES
  const baseDelayMs = options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS
  const maxDelayMs = options.maxDelayMs ?? DEFAULT_MAX_DELAY_MS
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const payload = JSON.stringify(body)

  for (let attempt = 0; ; attempt++) {
    if (isAborted(options.signal)) {
      return transportError('request aborted', { retryable: false, aborted: true })
    }

    let response: Response
    try {
      response = await attemptFetch(doFetch, url, payload, apiKey, options.signal, timeoutMs)
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

    if (response.ok) return await readSuccess(response)

    const status = response.status
    const detail = await readErrorBody(response)
    const message = `OpenAI request failed (${status}${detail === null ? '' : `: ${detail}`})`
    // 400/401/403/404 are the request's fault; retrying just burns time.
    const retryable = status === 429 || status >= 500
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
// Response reading
// ---------------------------------------------------------------------------

/**
 * Turn a decoded `/v1/responses` payload into a result.
 *
 * Exported because it is the part worth testing without a socket: the walk down
 * `output[] → message → content[] → output_text` has to skip the leading
 * `reasoning` item, notice a `refusal` part even though the response reports
 * `status: "completed"`, and treat anything else as malformed rather than
 * throwing into the render loop.
 */
export function parseInterpretationResponse(value: unknown): InterpretResult {
  if (!isRecord(value)) {
    return { kind: 'malformed', message: 'response was not a JSON object', raw: null }
  }

  const status = typeof value.status === 'string' ? value.status : 'unknown'
  if (status !== 'completed') {
    const details = isRecord(value.incomplete_details) ? value.incomplete_details : null
    const error = isRecord(value.error) ? value.error : null
    const reason =
      str(details?.reason) ?? str(error?.message) ?? (status === 'unknown' ? 'missing' : status)
    return {
      kind: 'incomplete',
      reason,
      message: `response did not complete (status ${status}, reason ${reason})`
    }
  }

  if (!Array.isArray(value.output)) {
    return { kind: 'malformed', message: 'response had no output array', raw: null }
  }

  let refusal: string | null = null
  const chunks: string[] = []
  for (const item of value.output) {
    // Reasoning items and tool calls sit alongside the message; skip them.
    if (!isRecord(item) || item.type !== 'message' || !Array.isArray(item.content)) continue
    for (const part of item.content) {
      if (!isRecord(part)) continue
      if (part.type === 'refusal') {
        refusal ??= str(part.refusal) ?? str(part.text) ?? 'the model refused to answer'
      } else if (part.type === 'output_text') {
        const text = str(part.text)
        if (text !== null) chunks.push(text)
      }
    }
  }

  if (refusal !== null) return { kind: 'refusal', message: refusal }
  if (chunks.length === 0) {
    return { kind: 'malformed', message: 'response contained no output_text content', raw: null }
  }

  const raw = chunks.join('')
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (cause) {
    return { kind: 'malformed', message: `output was not JSON: ${describe(cause)}`, raw }
  }

  // Defense in depth: `strict: true` should guarantee this, but a schema drift
  // or a future model change should degrade to "no suggestion", not a crash.
  const validated = interpretationSchema.safeParse(parsed)
  if (!validated.success) {
    return {
      kind: 'malformed',
      message: `output did not match the interpretation schema: ${summarizeIssues(validated.error)}`,
      raw
    }
  }

  return {
    kind: 'ok',
    interpretation: validated.data,
    responseId: str(value.id),
    usage: readUsage(value.usage)
  }
}

/**
 * Parse a Go duration string, the format OpenAI uses for `x-ratelimit-reset-*`
 * headers: `"6m0s"`, `"1.5s"`, `"88ms"`, `"1h2m3s"`. Returns milliseconds, or
 * `null` if the value is not one. `parseInt("6m0s")` returns 6 — hence this.
 */
export function parseGoDuration(value: string): number | null {
  const input = value.trim()
  if (input === '') return null

  let sign = 1
  let cursor = 0
  const lead = input[0]
  if (lead === '+' || lead === '-') {
    sign = lead === '-' ? -1 : 1
    cursor = 1
  }
  if (input.slice(cursor) === '0') return 0

  const unit = /(\d+(?:\.\d+)?)(ns|us|µs|μs|ms|s|m|h)/y
  unit.lastIndex = cursor
  let total = 0
  let matched = false
  while (unit.lastIndex < input.length) {
    const match = unit.exec(input)
    if (match === null) return null
    const amount = Number(match[1])
    const scale = UNIT_MS[match[2] ?? '']
    if (!Number.isFinite(amount) || scale === undefined) return null
    total += amount * scale
    matched = true
  }
  return matched ? sign * total : null
}

const UNIT_MS: Record<string, number> = {
  ns: 1e-6,
  us: 1e-3,
  µs: 1e-3,
  μs: 1e-3,
  ms: 1,
  s: 1_000,
  m: 60_000,
  h: 3_600_000
}

/**
 * How long the server wants us to wait. `Retry-After` is seconds or an HTTP
 * date per RFC 9110; the OpenAI rate-limit reset headers are Go durations.
 */
export function suggestedDelayMs(headers: Headers, nowMs: number): number | null {
  const retryAfter = headers.get('retry-after')
  if (retryAfter !== null) {
    const trimmed = retryAfter.trim()
    if (/^\d+(\.\d+)?$/.test(trimmed)) return Number(trimmed) * 1_000
    const asDate = Date.parse(trimmed)
    if (!Number.isNaN(asDate)) return Math.max(0, asDate - nowMs)
    const asDuration = parseGoDuration(trimmed)
    if (asDuration !== null) return Math.max(0, asDuration)
  }

  const candidates: number[] = []
  for (const name of ['x-ratelimit-reset-requests', 'x-ratelimit-reset-tokens']) {
    const raw = headers.get(name)
    if (raw === null) continue
    const ms = parseGoDuration(raw)
    if (ms !== null && ms > 0) candidates.push(ms)
  }
  if (candidates.length === 0) return null
  return Math.min(...candidates)
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

async function attemptFetch(
  doFetch: FetchLike,
  url: string,
  payload: string,
  apiKey: string,
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
    return await doFetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: payload,
      signal: controller.signal
    })
  } finally {
    if (timer !== null) clearTimeout(timer)
    signal?.removeEventListener('abort', forward)
  }
}

async function readSuccess(response: Response): Promise<InterpretResult> {
  let text: string
  try {
    text = await response.text()
  } catch (cause) {
    return transportError(`could not read response body: ${describe(cause)}`, { retryable: true })
  }
  try {
    return parseInterpretationResponse(JSON.parse(text))
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
    if (isRecord(parsed) && isRecord(parsed.error)) {
      const message = str(parsed.error.message)
      if (message !== null) return message
    }
  } catch {
    // Not JSON — fall through to the raw body.
  }
  return text.slice(0, 300)
}

/** Exponential backoff with half jitter, so retries neither sync up nor fire instantly. */
function backoff(attempt: number, baseMs: number, maxMs: number, random: () => number): number {
  const ceiling = Math.min(maxMs, baseMs * 2 ** attempt)
  return Math.round(ceiling / 2 + random() * (ceiling / 2))
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

function readUsage(value: unknown): TokenUsage | null {
  if (!isRecord(value)) return null
  const details = isRecord(value.input_tokens_details) ? value.input_tokens_details : null
  return {
    inputTokens: num(value.input_tokens) ?? 0,
    outputTokens: num(value.output_tokens) ?? 0,
    totalTokens: num(value.total_tokens) ?? 0,
    cachedInputTokens: num(details?.cached_tokens) ?? 0
  }
}

function summarizeIssues(error: { issues: { path: PropertyKey[]; message: string }[] }): string {
  return error.issues
    .slice(0, 3)
    .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
    .join('; ')
}

function formatMs(ms: number): string {
  return ms >= 1_000 ? `${Math.round(ms / 100) / 10}s` : `${Math.round(ms)}ms`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function str(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function describe(cause: unknown): string {
  if (cause instanceof Error) return cause.message
  return String(cause)
}

/**
 * Read through a function so control-flow analysis does not assume the flag is
 * still whatever it was before the `await`.
 */
function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true
}

/** `DOMException` is not reliably an `instanceof Error` across runtimes. */
function errorName(cause: unknown): string | null {
  if (typeof cause !== 'object' || cause === null) return null
  return str((cause as { name?: unknown }).name)
}
