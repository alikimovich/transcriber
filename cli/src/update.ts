/**
 * `transcriber update` — self-update from GitHub Releases.
 *
 * This is the ONE place in the product that touches the network, and only
 * when the user runs it. Recording, transcription, and every other command
 * stay fully offline — that invariant is documented in CLAUDE.md and the
 * README, and any second network call is a product decision, not a detail.
 *
 * The swap: download the notarized release zip, verify both binaries'
 * signatures (Developer ID, our team), copy them next to the running
 * executable, and atomically rename them into place. The bundle identifier
 * and certificate don't change, so TCC permission grants survive.
 */

import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdtempSync,
  realpathSync,
  renameSync,
  rmSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import pkg from '../package.json'

const REPO = 'alikimovich/transcriber'
const TEAM_ID = 'ZMVK3ALPSD'

export const VERSION: string = pkg.version

/** "v0.2.1" / "0.2.1" → [0, 2, 1]; missing or junk parts become 0. */
function parts(version: string): number[] {
  return version
    .replace(/^v/, '')
    .split('.')
    .map((p) => Number.parseInt(p, 10) || 0)
}

/** Numeric semver comparison — string comparison breaks at 0.10.0 vs 0.9.0. */
export function isNewer(candidate: string, current: string): boolean {
  const a = parts(candidate)
  const b = parts(current)
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const d = (a[i] ?? 0) - (b[i] ?? 0)
    if (d !== 0) return d > 0
  }
  return false
}

/** The release asset we ship, or null when a release has none (broken upload). */
export function pickAsset(
  assets: Array<{ name: string; browser_download_url: string }>
): string | null {
  const match = assets.find((a) => /^transcriber-v.+-macos-arm64\.zip$/.test(a.name))
  return match?.browser_download_url ?? null
}

function fail(message: string): never {
  process.stderr.write(`${message}\n`)
  process.exit(1)
}

/**
 * A binary is only installed if it verifies and was signed by us. The zip
 * came over TLS from GitHub, but a five-line check that the signature chain
 * is intact and carries our team ID costs nothing and turns a corrupted or
 * tampered download into a clean error instead of a broken install.
 */
function verifySignature(path: string, name: string): void {
  const verify = spawnSync('codesign', ['--verify', '--strict', path], { encoding: 'utf8' })
  if (verify.status !== 0) fail(`downloaded ${name} failed signature verification — aborting`)
  const info = spawnSync('codesign', ['-dv', path], { encoding: 'utf8' })
  if (!(info.stderr ?? '').includes(`TeamIdentifier=${TEAM_ID}`)) {
    fail(`downloaded ${name} is not signed by the expected team — aborting`)
  }
}

const BUNDLE = 'TranscriberCapture.app'

export async function runUpdate({ force = false }: { force?: boolean } = {}): Promise<void> {
  const out = (s: string) => process.stdout.write(`${s}\n`)

  // Only a compiled release install can self-update: bun standalone binaries
  // report their bundled sources under the /$bunfs virtual filesystem. A
  // source checkout updates with git.
  if (!import.meta.dirname.startsWith('/$bunfs')) {
    fail('running from source — update with `git pull` and `./install.sh` instead')
  }

  const execPath = realpathSync(process.execPath)
  if (execPath.includes('/Cellar/')) {
    fail('this install is managed by Homebrew — update with `brew upgrade transcriber`')
  }

  out(`current version: v${VERSION}`)
  const response = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'transcriber-update' }
  })
  if (!response.ok) fail(`could not check for updates: GitHub answered ${response.status}`)
  const release = (await response.json()) as {
    tag_name: string
    assets: Array<{ name: string; browser_download_url: string }>
  }

  if (!isNewer(release.tag_name, VERSION) && !force) {
    out(`already up to date (latest release is ${release.tag_name})`)
    out('run with --force to reinstall it anyway')
    return
  }

  const assetUrl = pickAsset(release.assets)
  if (!assetUrl) fail(`release ${release.tag_name} has no macos-arm64 asset — not updating`)

  out(`downloading ${release.tag_name}…`)
  const work = mkdtempSync(join(tmpdir(), 'transcriber-update-'))
  try {
    const zipPath = join(work, 'release.zip')
    const download = await fetch(assetUrl, {
      headers: { 'User-Agent': 'transcriber-update' }
    })
    if (!download.ok) fail(`download failed: GitHub answered ${download.status}`)
    await Bun.write(zipPath, download)

    const unzip = spawnSync('ditto', ['-x', '-k', zipPath, work], { encoding: 'utf8' })
    if (unzip.status !== 0) fail(`could not extract the release zip: ${unzip.stderr}`)

    // The zip contains a single versioned folder: the CLI, the helper's app
    // bundle, and a bare helper copy kept for pre-bundle installers.
    const extracted = join(work, `transcriber-${release.tag_name}-macos-arm64`)
    const targetDir = dirname(execPath)

    // Verify everything before touching anything.
    verifySignature(join(extracted, 'transcriber'), 'transcriber')
    verifySignature(join(extracted, BUNDLE), BUNDLE)

    // The CLI: copy into the target directory so the final rename is atomic
    // and never crosses filesystems; renaming over the running executable is
    // fine — the old inode lives on until this process exits.
    const stagedCli = join(targetDir, '.transcriber.update')
    copyFileSync(join(extracted, 'transcriber'), stagedCli)
    chmodSync(stagedCli, 0o755)
    renameSync(stagedCli, join(targetDir, 'transcriber'))

    // The helper: ditto preserves the bundle's signature and structure; a
    // stage-then-rename keeps the visible path valid at every moment.
    const stagedApp = join(targetDir, `.${BUNDLE}.update`)
    rmSync(stagedApp, { recursive: true, force: true })
    const copy = spawnSync('ditto', [join(extracted, BUNDLE), stagedApp], { encoding: 'utf8' })
    if (copy.status !== 0) fail(`could not install the capture helper: ${copy.stderr}`)
    rmSync(join(targetDir, BUNDLE), { recursive: true, force: true })
    renameSync(stagedApp, join(targetDir, BUNDLE))

    // Retire a pre-bundle flat helper so discovery can't find the stale one.
    // (Skip symlinks — a source checkout's convenience link points into the
    // bundle we just installed.)
    const flat = join(targetDir, 'tcapture')
    if (existsSync(flat) && realpathSync(flat) === flat) rmSync(flat)

    out(`updated v${VERSION} → ${release.tag_name}`)
    out('note: if macOS asks again for microphone or system-audio access, that is')
    out('the helper’s new app-bundle identity registering — grant once and done')
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
}
