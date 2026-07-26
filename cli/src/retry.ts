// Backoff and rate-limit helpers.
//
// The Go-duration parsing exists because OpenAI reports `x-ratelimit-reset-*`
// in that format. xAI documents no rate-limit headers at all, so these simply
// return null there and the caller falls back to blind exponential backoff —
// which is what xAI's own docs recommend.

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

export /** Exponential backoff with half jitter, so retries neither sync up nor fire instantly. */
function backoff(attempt: number, baseMs: number, maxMs: number, random: () => number): number {
  const ceiling = Math.min(maxMs, baseMs * 2 ** attempt)
  return Math.round(ceiling / 2 + random() * (ceiling / 2))
}

export function formatMs(ms: number): string {
  return ms >= 1_000 ? `${Math.round(ms / 100) / 10}s` : `${Math.round(ms)}ms`
}
