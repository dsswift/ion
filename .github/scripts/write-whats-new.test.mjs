// Pins write-whats-new.mjs: which commits the agent sees, how its answer
// becomes notes, that only notes passing the checks and kept by the reviewer
// reach the file, and that every failure leaves the file untouched without
// failing the release.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { composePrompt, composeReviewPrompt, desktopRelease, lintHighlight, parseHighlights, parseReview, shippedCommits, withEntry } from './write-whats-new.mjs'

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'write-whats-new.mjs')

const report = {
  components: ['desktop', 'engine', 'ios'],
  releases: [
    { component: 'desktop', new_version: '2.10.0', commits: [
      { sha: 'a1', type: 'feat', scope: 'desktop', description: 'show a build notice after studio updates', breaking: false },
    ] },
    { component: 'engine', new_version: '1.99.0', commits: [
      { sha: 'b2', type: 'fix', scope: 'engine', description: 'exit nonzero when a streamed prompt run fails', breaking: false },
      { sha: 'a1', type: 'feat', scope: 'desktop', description: 'show a build notice after studio updates', breaking: false },
    ] },
    { component: 'server', new_version: '1.11.0', commits: [
      { sha: 'd4', type: 'feat', scope: 'server', description: 'show a build notice after studio updates', breaking: false },
    ] },
    { component: 'ios', new_version: '2.9.0', commits: [
      { sha: 'c3', type: 'feat', scope: 'ios', description: 'iphone only change', breaking: false },
    ] },
  ],
}

test('finds the desktop release and the commits that ship in the app', () => {
  assert.equal(desktopRelease(report)?.new_version, '2.10.0')
  assert.equal(desktopRelease({ releases: [{ component: 'engine', new_version: '1.0.0' }] }), null)
  assert.deepEqual(shippedCommits(report).map((c) => c.sha), ['a1', 'b2'])
})

test('the prompt carries the instructions, the version, and each commit with its body', () => {
  const prompt = composePrompt('Write notes.', '2.10.0', shippedCommits(report), (sha) => (sha === 'a1' ? 'Why it changed.' : ''))
  assert.match(prompt, /^Write notes\./)
  assert.match(prompt, /## Changes in Ion Studio 2\.10\.0/)
  assert.match(prompt, /### feat\(desktop\): show a build notice after studio updates\n\nWhy it changed\./)
  assert.match(prompt, /### fix\(engine\): exit nonzero when a streamed prompt run fails/)
  assert.doesNotMatch(prompt, /iphone only change/)
})

test('parses bullets, NONE, and rejects what is not notes', () => {
  assert.deepEqual(parseHighlights('- Studio says when it was updated.\n- Prompts fail loudly — not silently.\n'), {
    kind: 'bullets',
    items: ['Studio says when it was updated.', 'Prompts fail loudly, not silently.'],
  })
  assert.deepEqual(parseHighlights('Here are the notes:\n* One thing.\n'), { kind: 'bullets', items: ['One thing.'] })
  assert.deepEqual(parseHighlights(' NONE\n'), { kind: 'none' })
  assert.equal(parseHighlights('Nothing to report.').kind, 'invalid')
  assert.equal(parseHighlights('- a\n- b\n- c\n- d\n- e\n- f').kind, 'invalid')
})

test('the checks pass plain sentences and drop engineering text', () => {
  for (const ok of [
    'Fixed a problem where lists lost their bullet points.',
    'You can now see how much quota each account has left.',
  ]) assert.equal(lintHighlight(ok), null, ok)
  for (const [bad, reason] of [
    ['Refactored the store.', /technical word/],
    ['Fixed a crash in the engine.', /technical word "engine"/],
    ['You can now open `notes` quickly.', /code formatting/],
    ['You can now open notes.md directly.', /names a file/],
    ['See https://example.org for details.', /link/],
    ['Fixed a problem with a1b2c3d4e here.', /commit id/],
    ['Fixed issue #476 on Windows.', /names an issue/],
    ['You can now set showBuildNotice.', /code identifier/],
    ['Fixed the build_notice toggle.', /code identifier/],
    ['Great news, it all works now!', /period/],
    ['feat(desktop): add a fleet hub.', /capital letter/],
    ['Faster.', /shorter/],
    [`You can now ${'do more '.repeat(30)}.`, /longer/],
  ]) assert.match(lintHighlight(bad) ?? 'passed', reason, bad)
})

test('the reviewer keeps or drops each note, and an unclear answer keeps none', () => {
  assert.deepEqual(parseReview('1: KEEP\n2: DROP not plain\n3: KEEP\n', 3), { kept: [1, 3], dropped: new Map([[2, 'not plain']]) })
  assert.deepEqual(parseReview('1. KEEP', 1), { kept: [1], dropped: new Map() })
  assert.match(parseReview('1: KEEP', 2).invalid, /judged 1 of 2/)
  assert.match(parseReview('1: KEEP\nLooks good.', 1).invalid, /unexpected line/)
  assert.match(parseReview('1: KEEP\n1: DROP', 1).invalid, /bad note number/)
  assert.match(parseReview('3: KEEP', 1).invalid, /bad note number/)
  assert.match(parseReview('', 1).invalid, /judged 0 of 1/)
})

test('the reviewer sees the changes and the proposed notes', () => {
  const prompt = composeReviewPrompt('Review notes.', '2.10.0', shippedCommits(report), () => '', ['Studio tells you when it was updated.'])
  assert.match(prompt, /^Review notes\./)
  assert.match(prompt, /### feat\(desktop\): show a build notice after studio updates/)
  assert.match(prompt, /## Proposed notes\n\n1\. Studio tells you when it was updated\.\n/)
})

test('a new entry goes first and a rerun replaces its own entry', () => {
  const notes = withEntry({ '2.9.0': ['old'] }, '2.10.0', ['new'])
  assert.deepEqual(Object.keys(notes), ['2.10.0', '2.9.0'])
  assert.deepEqual(withEntry(notes, '2.10.0', ['again'])['2.10.0'], ['again'])
})

/**
 * Runs the script with a fake agent: the writer answers `writer`, the
 * reviewer answers `review`, and the step named by `fail` (`writer`,
 * `review`) exits 1.
 */
function runScript({ writer = '', review = '1: KEEP', fail = '', env = {}, notes = '{\n  "2.9.0": ["Older note."]\n}\n' } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'whats-new-test-'))
  const notesFile = join(dir, 'whats-new.json')
  const writerFile = join(dir, 'writer.md')
  const reviewFile = join(dir, 'review.md')
  const runner = join(dir, 'runner.sh')
  writeFileSync(notesFile, notes)
  writeFileSync(writerFile, 'Write notes.\n')
  writeFileSync(reviewFile, 'Review notes.\n')
  writeFileSync(join(dir, 'writer-answer'), writer)
  writeFileSync(join(dir, 'review-answer'), review)
  // The script names each prompt file after its step: writer, review.
  writeFileSync(runner, [
    '#!/usr/bin/env bash',
    'step=$(basename "$1" -prompt.md)',
    `cp "$1" "${dir}/seen-$step-prompt.md"`,
    `[ "$step" = "${fail}" ] && exit 1`,
    `cp "${dir}/$step-answer" "$2"`,
    '',
  ].join('\n'))
  chmodSync(runner, 0o755)
  const stdout = execFileSync('node', [SCRIPT, runner], {
    encoding: 'utf8',
    env: { ...process.env, RELEASE_REPORT: JSON.stringify(report), WHATS_NEW_FILE: notesFile, WHATS_NEW_PROMPT: writerFile, WHATS_NEW_REVIEW: reviewFile, ...env },
  })
  const seen = (step) => {
    try { return readFileSync(join(dir, `seen-${step}-prompt.md`), 'utf8') } catch { return null }
  }
  return { stdout, notes: readFileSync(notesFile, 'utf8'), seen }
}

const BEFORE = '{\n  "2.9.0": ["Older note."]\n}\n'

test('writes reviewed notes under the new desktop version', () => {
  const { notes, seen, stdout } = runScript({ writer: '- You can now see when Studio was updated.\n' })
  assert.deepEqual(JSON.parse(notes), { '2.10.0': ['You can now see when Studio was updated.'], '2.9.0': ['Older note.'] })
  assert.match(seen('writer'), /## Changes in Ion Studio 2\.10\.0/)
  assert.match(seen('review'), /## Proposed notes\n\n1\. You can now see when Studio was updated\./)
  assert.match(stdout, /wrote 1 reviewed notes for desktop 2\.10\.0/)
})

test('drops a note that fails the checks and reviews only the rest', () => {
  const { notes, seen, stdout } = runScript({ writer: '- You can now see when Studio was updated.\n- Refactored the engine socket.\n' })
  assert.deepEqual(JSON.parse(notes)['2.10.0'], ['You can now see when Studio was updated.'])
  assert.doesNotMatch(seen('review'), /Refactored/)
  assert.match(stdout, /dropped a note that uses the technical word/)
})

test('writes only the notes the reviewer keeps', () => {
  const { notes, stdout } = runScript({
    writer: '- You can now see when Studio was updated.\n- You can now do everything faster than ever.\n',
    review: '1: KEEP\n2: DROP overstates the change\n',
  })
  assert.deepEqual(JSON.parse(notes)['2.10.0'], ['You can now see when Studio was updated.'])
  assert.match(stdout, /reviewer dropped a note \(overstates the change\): You can now do everything faster than ever\./)
})

test('writes nothing when the reviewer keeps nothing or answers unclearly', () => {
  for (const [review, expect] of [['1: DROP not plain', /kept no notes/], ['APPROVE', /::warning.*review answer is unclear/]]) {
    const { notes, stdout } = runScript({ writer: '- You can now see when Studio was updated.\n', review })
    assert.equal(notes, BEFORE)
    assert.match(stdout, expect)
  }
})

test('leaves the file alone and warns, never fails, when a run fails or answers badly', () => {
  for (const run of [
    { fail: 'writer', expect: /writer run failed/ },
    { writer: '- You can now see when Studio was updated.\n', fail: 'review', expect: /review run failed/ },
    { writer: 'I could not do that.', expect: /no bullets/ },
    { writer: '- Refactored the engine socket.\n', expect: /every drafted note failed the checks/ },
  ]) {
    const { notes, stdout } = runScript(run)
    assert.equal(notes, BEFORE)
    assert.match(stdout, /::warning title=What's new notes::/)
    assert.match(stdout, run.expect)
  }
})

test('writes nothing for NONE, a push with no desktop release, or a bad report', () => {
  const none = runScript({ writer: 'NONE' })
  assert.equal(none.notes, BEFORE)
  assert.equal(none.seen('review'), null)
  const noDesktop = JSON.stringify({ releases: [{ component: 'engine', new_version: '1.0.0', commits: [{ sha: 'x' }] }] })
  assert.match(runScript({ env: { RELEASE_REPORT: noDesktop } }).stdout, /released no desktop version/)
  assert.match(runScript({ env: { RELEASE_REPORT: 'not json' } }).stdout, /::warning.*not JSON/)
})
