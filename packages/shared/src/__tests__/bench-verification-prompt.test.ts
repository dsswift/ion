/**
 * bench-verification-prompt — the analysis-only instruction, pinned so it
 * cannot silently drift from what openBenchVerificationAnalysis actually needs.
 */
import { describe, it, expect } from 'vitest'
import { buildVerificationAnalysisPrompt } from '../bench-verification-prompt'

describe('buildVerificationAnalysisPrompt', () => {
  it('carries the verify command, its output, and every suspect with its worktree path', () => {
    const prompt = buildVerificationAnalysisPrompt({
      sourceBranch: 'josh',
      verifyCommand: 'cd engine && go build ./... && cd ../desktop && npm run typecheck',
      outputTail: 'src/renderer/components/WorktreeRowMenu.tsx(122,8): error TS1109',
      replayedMembers: [
        { branchName: 'wt/a', worktreePath: '/wt/a' },
        { branchName: 'wt/c', worktreePath: '/wt/c' },
      ],
    })

    expect(prompt).toContain('cd engine && go build ./... && cd ../desktop && npm run typecheck')
    expect(prompt).toContain('error TS1109')
    expect(prompt).toContain('wt/a (worktree: /wt/a)')
    expect(prompt).toContain('wt/c (worktree: /wt/c)')
    expect(prompt).toContain('josh')
  })

  it('states both verdict labels and requires them in the output shape', () => {
    const prompt = buildVerificationAnalysisPrompt({
      sourceBranch: 'josh',
      verifyCommand: 'exit 1',
      outputTail: '',
      replayedMembers: [],
    })

    expect(prompt).toContain('Verdict: Mechanical')
    expect(prompt).toContain('Verdict: Semantic')
  })

  it('forbids editing the bench and forbids any bench-local shim, with the reason stated', () => {
    const prompt = buildVerificationAnalysisPrompt({
      sourceBranch: 'josh',
      verifyCommand: 'exit 1',
      outputTail: '',
      replayedMembers: [],
    })

    expect(prompt).toMatch(/do not edit any file in this bench/i)
    expect(prompt).toMatch(/shim, adapter, or/i)
    expect(prompt).toMatch(/rebuilt from scratch on every assembly/i)
  })

  it('recommends isolating and landing one member for the semantic case', () => {
    const prompt = buildVerificationAnalysisPrompt({
      sourceBranch: 'josh',
      verifyCommand: 'exit 1',
      outputTail: '',
      replayedMembers: [],
    })

    expect(prompt).toMatch(/disable one of the colliding members/i)
    expect(prompt).toMatch(/land it so/i)
    expect(prompt).toMatch(/sync the other member upward/i)
  })

  it('requires a paste-ready fenced code block for the semantic case, naming the bench and the verify command', () => {
    const prompt = buildVerificationAnalysisPrompt({
      sourceBranch: 'josh',
      verifyCommand: 'npm run typecheck',
      outputTail: '',
      replayedMembers: [],
    })

    expect(prompt).toMatch(/fenced code block/i)
    expect(prompt).toMatch(/paste-ready prompt for the OWNING member/i)
    expect(prompt).toContain('josh')
    expect(prompt).toMatch(/quote the verify command/i)
  })

  it('falls back to an explicit "none recorded" line when no member replayed', () => {
    const prompt = buildVerificationAnalysisPrompt({
      sourceBranch: 'josh',
      verifyCommand: 'exit 1',
      outputTail: '',
      replayedMembers: [],
    })

    expect(prompt).toMatch(/none recorded/i)
  })

  it('terminates on the verdict: no questions, no attempted fix', () => {
    const prompt = buildVerificationAnalysisPrompt({
      sourceBranch: 'josh',
      verifyCommand: 'exit 1',
      outputTail: '',
      replayedMembers: [],
    })

    expect(prompt).toMatch(/do not ask questions/i)
    expect(prompt).toMatch(/do not attempt any fix/i)
  })
})
