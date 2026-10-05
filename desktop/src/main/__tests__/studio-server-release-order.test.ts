/**
 * Structural test for the Studio server bundle job.
 *
 * The same class of test as windows-release-provenance.test.ts: the workflow
 * cannot be run here, so what is pinned is the job ordering a release depends
 * on.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import path from 'path'
import { parse } from 'yaml'

interface Job {
  needs?: string | string[]
  if?: string
}

const workflow = parse(
  readFileSync(path.resolve(__dirname, '..', '..', '..', '..', '.github', 'workflows', 'build.yml'), 'utf-8'),
) as { jobs: Record<string, Job> }

describe('studio server bundle ordering', () => {
  const job = workflow.jobs['build-studio-server']

  // The bundle downloads the engine binary from the engine release, which is
  // still a draft then. ready-engine runs once every engine asset is
  // attached; a download before it can find the asset missing.
  it('waits for the engine release assets before downloading from it', () => {
    expect(job.needs).toContain('build-engine')
    expect(job.needs).toContain('ready-engine')
  })

  // ready-engine is skipped when the engine is not in the release and on a
  // dry run; the bundle must still build then.
  it('still runs when ready-engine is skipped', () => {
    expect(job.if).toMatch(/^always\(\)/)
    expect(job.if).not.toContain('ready-engine')
  })
})
