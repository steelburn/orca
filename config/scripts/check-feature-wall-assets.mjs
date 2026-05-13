#!/usr/bin/env node
import { readdir, stat } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(__dirname, '..', '..')
const FEATURE_WALL_ASSET_DIR = path.join(ROOT, 'resources', 'onboarding', 'feature-wall')
const MAX_BYTES = 11 * 1024 * 1024

async function collectFiles(dir) {
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      return []
    }
    throw error
  }

  const files = []
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      files.push(...(await collectFiles(fullPath)))
    } else if (entry.isFile()) {
      files.push(fullPath)
    }
  }
  return files
}

const files = await collectFiles(FEATURE_WALL_ASSET_DIR)
let totalBytes = 0
for (const file of files) {
  const fileStat = await stat(file)
  totalBytes += fileStat.size
}

if (totalBytes > MAX_BYTES) {
  const totalMb = (totalBytes / 1024 / 1024).toFixed(2)
  const maxMb = (MAX_BYTES / 1024 / 1024).toFixed(2)
  console.error(
    `Feature wall assets are ${totalMb} MB, which exceeds the ${maxMb} MB installer budget.`
  )
  process.exit(1)
}

console.log(
  `Feature wall assets: ${(totalBytes / 1024 / 1024).toFixed(2)} MB / ${(
    MAX_BYTES /
    1024 /
    1024
  ).toFixed(2)} MB`
)
