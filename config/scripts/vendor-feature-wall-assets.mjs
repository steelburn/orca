#!/usr/bin/env node
import { copyFile, mkdir, writeFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { homedir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(__dirname, '..', '..')
const DEFAULT_MARKETING_REPO = path.join(
  homedir(),
  'source',
  'repos',
  'Stably',
  'orca-marketing-website'
)
const MARKETING_REPO = process.env.ORCA_MARKETING_REPO || DEFAULT_MARKETING_REPO
const SOURCE_ROOT = path.join(MARKETING_REPO, 'public', 'whats-new')
const DEST_ROOT = path.join(ROOT, 'resources', 'onboarding', 'feature-wall')

const TILES = [
  { id: 'tile-01', sourceName: 'orca-design-mode' },
  { id: 'tile-02', sourceName: 'feature-wall-02' },
  { id: 'tile-03', sourceName: 'feature-wall-03' },
  { id: 'tile-04', sourceName: 'feature-wall-04' },
  { id: 'tile-05', sourceName: 'ssh-demo' },
  { id: 'tile-06', sourceName: 'codex-account-switcher' },
  { id: 'tile-07', sourceName: 'annotate-ai-diff' }
]

function gitRecordedAtSeconds(marketingRelativePath) {
  const result = spawnSync('git', ['log', '--format=%at', '-1', '--', marketingRelativePath], {
    cwd: MARKETING_REPO,
    encoding: 'utf8'
  })
  if (result.status !== 0) {
    throw new Error(
      `git log failed for ${marketingRelativePath}: ${result.stderr || result.stdout}`
    )
  }
  const value = result.stdout.trim()
  if (!value) {
    throw new Error(`No git history found for ${marketingRelativePath}`)
  }
  return Number(value)
}

await mkdir(DEST_ROOT, { recursive: true })

for (const tile of TILES) {
  const gifRelativePath = ['public', 'whats-new', `${tile.sourceName}.gif`].join('/')
  const posterRelativePath = ['public', 'whats-new', 'posters', `${tile.sourceName}.jpg`].join('/')
  const sourceGif = path.join(SOURCE_ROOT, `${tile.sourceName}.gif`)
  const sourcePoster = path.join(SOURCE_ROOT, 'posters', `${tile.sourceName}.jpg`)
  const destGif = path.join(DEST_ROOT, `${tile.id}.gif`)
  const destPoster = path.join(DEST_ROOT, `${tile.id}.poster.jpg`)
  const recordedAtSeconds = gitRecordedAtSeconds(gifRelativePath)

  await copyFile(sourceGif, destGif)
  await copyFile(sourcePoster, destPoster)
  await writeFile(
    path.join(DEST_ROOT, `${tile.id}.recorded-at.json`),
    `${JSON.stringify(
      {
        recordedAtUnixSeconds: recordedAtSeconds,
        recordedAtIso: new Date(recordedAtSeconds * 1000).toISOString(),
        marketingRepo: MARKETING_REPO,
        sourceGif: gifRelativePath,
        sourcePoster: posterRelativePath
      },
      null,
      2
    )}\n`
  )

  console.log(`Vendored ${tile.sourceName} -> ${tile.id}`)
}
