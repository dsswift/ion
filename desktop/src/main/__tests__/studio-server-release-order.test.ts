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

  // The bundle downloads the engine binary from the engine release. A download
  // that runs while publish-engine flips that release from draft to public
  // can find it under neither state and fail with "release not found".
  it('waits for the engine release to be published before downloading from it', () => {
    expect(job.needs).toContain('build-engine')
    expect(job.needs).toContain('publish-engine')
  })

  // publish-engine is skipped when the engine is not in the release and on a
  // dry run; the bundle must still build then.
  it('still runs when publish-engine is skipped', () => {
    expect(job.if).toMatch(/^always\(\)/)
    expect(job.if).not.toContain('publish-engine')
  })
})
