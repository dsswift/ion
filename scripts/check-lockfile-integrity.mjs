#!/usr/bin/env node
// Fail when a registry package in package-lock.json has no `resolved` URL or
// `integrity` hash. Without them npm ci must look each version up in the
// registry, skips hash verification, and under `prefer-offline` trusts a
// cached listing that can predate the locked version.
import fs from 'node:fs'

const path = process.argv[2] ?? 'package-lock.json'
const { packages } = JSON.parse(fs.readFileSync(path, 'utf8'))
const missing = Object.entries(packages)
  .filter(([key, entry]) => key.includes('node_modules/') && !entry.link && (!entry.resolved || !entry.integrity))
  .map(([key, entry]) => `${key}@${entry.version}`)

if (missing.length > 0) {
  console.error(`❌ ${path}: ${missing.length} package(s) lack resolved or integrity:`)
  for (const m of missing.slice(0, 20)) console.error(`  ${m}`)
  if (missing.length > 20) console.error(`  ... and ${missing.length - 20} more`)
  process.exit(1)
}
console.log(`✅ ${path}: every package carries resolved and integrity`)
