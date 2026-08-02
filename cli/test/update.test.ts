// The network and binary-swap paths of `transcriber update` are exercised by
// hand against a real release (see README's smoke checklist); these cover the
// pure decisions — version comparison and asset selection.

import { describe, expect, test } from 'bun:test'
import { isNewer, pickAsset } from '../src/update.ts'

describe('isNewer', () => {
  test('plain newer/older/equal', () => {
    expect(isNewer('v0.2.0', '0.1.0')).toBe(true)
    expect(isNewer('v0.1.0', '0.2.0')).toBe(false)
    expect(isNewer('v0.1.0', '0.1.0')).toBe(false)
  })

  test('numeric, not lexicographic', () => {
    expect(isNewer('v0.10.0', '0.9.0')).toBe(true)
    expect(isNewer('v0.9.0', '0.10.0')).toBe(false)
  })

  test('patch and major precedence', () => {
    expect(isNewer('v0.1.1', '0.1.0')).toBe(true)
    expect(isNewer('v1.0.0', '0.99.99')).toBe(true)
  })

  test('junk tags never look newer', () => {
    expect(isNewer('vnightly', '0.1.0')).toBe(false)
  })
})

describe('pickAsset', () => {
  const url = 'https://example.com/dl/transcriber-v0.2.0-macos-arm64.zip'

  test('finds the macos-arm64 zip among other assets', () => {
    expect(
      pickAsset([
        { name: 'source.tar.gz', browser_download_url: 'x' },
        { name: 'transcriber-v0.2.0-macos-arm64.zip', browser_download_url: url }
      ])
    ).toBe(url)
  })

  test('null when a release has no matching asset', () => {
    expect(pickAsset([{ name: 'notes.txt', browser_download_url: 'x' }])).toBeNull()
    expect(pickAsset([])).toBeNull()
  })
})
