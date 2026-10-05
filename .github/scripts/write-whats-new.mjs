#!/usr/bin/env node
// write-whats-new.mjs — write the desktop release's "What's new" notes into
// desktop/whats-new.json, keyed by the new desktop version. The desktop build
// bakes in the entry for its own version and the Build Notice shows it.
//
// Every person who uses Ion Studio reads these notes, so nothing reaches the
// file unless it passes three gates in order: the writer prompt asks for plain
// consumer language, lintHighlight drops any bullet that carries technical or
// unsafe text, and a second, separate review run must keep each bullet on its
// own. Only kept bullets are written; an unclear review keeps none.
//
// Usage:
//   node write-whats-new.mjs <runner> [runner args...]
//
// The runner is called as `<runner> [runner args...] <prompt-file> <out-file>`
// and writes the agent's answer to <out-file> (run-ion-prompt.sh in CI).
//
// Environment:
//   RELEASE_REPORT   the release-damnit report for this push (required)
//   WHATS_NEW_FILE   notes file (default desktop/whats-new.json)
//   WHATS_NEW_PROMPT writer instructions (default .github/ion/whats-new-prompt.md)
//   WHATS_NEW_REVIEW reviewer instructions (default .github/ion/whats-new-review-prompt.md)
//
// Notes are a nicety. Every failure is a warning and exit 0: a release never
// waits on them, and a version with no entry shows no notes.

import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

/** Components whose code ships inside the desktop app built from this commit. */
export const SHIPPED_IN_DESKTOP = ['desktop', 'server', 'engine']
export const MAX_BULLETS = 5
export const MAX_BULLET_LENGTH = 200
const MIN_BULLET_LENGTH = 15
const MAX_BODY_LENGTH = 1500

/** The desktop release in the report, or null when this push released none. */
export function desktopRelease(report) {
  const releases = Array.isArray(report?.releases) ? report.releases : []
  const release = releases.find((r) => r?.component === 'desktop')
  return release && typeof release.new_version === 'string' && release.new_version !== '' ? release : null
}

/**
 * The commits that ship in the desktop app, once each, in report order. One
 * change committed per component carries one subject on several commits, so
 * a repeated subject is the same change.
 */
export function shippedCommits(report) {
  const seen = new Set()
  const commits = []
  for (const release of report?.releases ?? []) {
    if (!SHIPPED_IN_DESKTOP.includes(release?.component)) continue
    for (const commit of release.commits ?? []) {
      if (typeof commit?.sha !== 'string') continue
      const subject = `${commit.type}:${commit.description}`
      if (seen.has(commit.sha) || seen.has(subject)) continue
      seen.add(commit.sha)
      seen.add(subject)
      commits.push(commit)
    }
  }
  return commits
}

/** One commit as the agent reads it: its message, and its body when git has it. */
export function describeCommit(commit, bodyOf) {
  const scope = commit.scope ? `(${commit.scope})` : ''
  const head = `${commit.type ?? 'change'}${scope}${commit.breaking ? '!' : ''}: ${commit.description ?? ''}`
  const body = bodyOf(commit.sha).trim().slice(0, MAX_BODY_LENGTH)
  return body ? `### ${head}\n\n${body}` : `### ${head}`
}

export function composePrompt(instructions, version, commits, bodyOf) {
  return [
    instructions.trim(),
    '',
    `## Changes in Ion Studio ${version}`,
    '',
    commits.map((c) => describeCommit(c, bodyOf)).join('\n\n'),
    '',
  ].join('\n')
}

/** The reviewer's prompt: the same changes, then the notes it judges, numbered. */
export function composeReviewPrompt(instructions, version, commits, bodyOf, items) {
  return [
    composePrompt(instructions, version, commits, bodyOf).trimEnd(),
    '',
    '## Proposed notes',
    '',
    items.map((item, i) => `${i + 1}. ${item}`).join('\n'),
    '',
  ].join('\n')
}

/** Words an everyday reader would not know, as whole words, any case. */
const TECHNICAL_WORDS = [
  'api', 'sdk', 'cli', 'ipc', 'json', 'yaml', 'regex', 'refactor', 'refactored', 'commit', 'commits',
  'rebase', 'repo', 'repository', 'regression', 'null', 'undefined', 'nil', 'daemon', 'socket', 'stdout',
  'stderr', 'endpoint', 'payload', 'schema', 'mutex', 'goroutine', 'deadlock', 'typescript', 'golang',
  'electron', 'zustand', 'npm', 'engine', 'backend', 'frontend', 'runtime', 'config', 'env', 'stack trace',
  'race condition', 'exception', 'segfault', 'vulnerability', 'exploit', 'cve',
]
const TECHNICAL_WORD = new RegExp(`\\b(${TECHNICAL_WORDS.map((w) => w.replace(/ /g, '\\s+')).join('|')})\\b`, 'i')

/** Shapes that only appear in engineering text, each with the reason it fails. */
const TECHNICAL_SHAPES = [
  [/`/, 'contains code formatting'],
  [/https?:\/\/|www\./i, 'contains a link'],
  [/\b[\w-]+\.(ts|tsx|js|mjs|go|json|md|yml|yaml|sh|swift|py)\b/i, 'names a file'],
  [/\w\/\w+\/\w/, 'contains a path'],
  [/\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,40}\b/i, 'contains a commit id'],
  [/^\w+(\([^)]*\))?!?:/, 'reads like a commit message'],
  [/#\d+/, 'names an issue'],
  [/\S+@\S+/, 'contains an address or mention'],
  [/\b[a-z]+[A-Z][A-Za-z]*\b/, 'contains a code identifier'],
  [/\b\w+_\w+\b/, 'contains a code identifier'],
  [/[{}<>\[\]=;|]/, 'contains code symbols'],
  [/!/, 'is exclaimed'],
]

/**
 * Why one bullet must not reach a reader, or null when it may. A mechanical
 * backstop under the prompts: it catches engineering text, never judges tone.
 */
export function lintHighlight(item) {
  if (item.length < MIN_BULLET_LENGTH) return `is shorter than ${MIN_BULLET_LENGTH} characters`
  if (item.length > MAX_BULLET_LENGTH) return `is longer than ${MAX_BULLET_LENGTH} characters`
  if (!/^[A-Z]/.test(item)) return 'does not start with a capital letter'
  if (!/\.$/.test(item)) return 'does not end with a period'
  const word = TECHNICAL_WORD.exec(item)
  if (word) return `uses the technical word "${word[0]}"`
  for (const [shape, reason] of TECHNICAL_SHAPES) if (shape.test(item)) return reason
  return null
}

/**
 * The reviewer's verdict on `count` notes: `{ kept, dropped }` (1-based note
 * numbers, drop reasons by number), or `{ invalid }` when the answer is not
 * exactly one `<n>: KEEP` or `<n>: DROP <reason>` line per note. An invalid
 * answer keeps nothing.
 */
export function parseReview(answer, count) {
  const verdicts = new Map()
  for (const line of answer.split('\n').map((l) => l.trim()).filter((l) => l !== '')) {
    const match = /^(\d+)\s*[:.)]\s*(KEEP|DROP)\b\s*(.*)$/.exec(line)
    if (!match) return { invalid: `unexpected line: ${line.slice(0, 120)}` }
    const n = Number(match[1])
    if (n < 1 || n > count || verdicts.has(n)) return { invalid: `bad note number in: ${line.slice(0, 120)}` }
    verdicts.set(n, { keep: match[2] === 'KEEP', reason: match[3].trim() || 'no reason given' })
  }
  if (verdicts.size !== count) return { invalid: `judged ${verdicts.size} of ${count} notes` }
  const kept = []
  const dropped = new Map()
  for (let n = 1; n <= count; n++) {
    const verdict = verdicts.get(n)
    if (verdict.keep) kept.push(n)
    else dropped.set(n, verdict.reason)
  }
  return { kept, dropped }
}

/**
 * The agent's answer as notes: `{ kind: 'bullets', items }`, `{ kind: 'none' }`,
 * or `{ kind: 'invalid', reason }`.
 */
export function parseHighlights(answer) {
  const text = answer.trim()
  if (/^none\.?$/i.test(text)) return { kind: 'none' }
  const items = text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => /^[-*•]\s+/.test(line))
    .map((line) => line.replace(/^[-*•]\s+/, '').replace(/\s*[—–]\s*/g, ', ').trim())
    .filter((line) => line !== '')
  if (items.length === 0) return { kind: 'invalid', reason: 'the answer has no bullets' }
  if (items.length > MAX_BULLETS) return { kind: 'invalid', reason: `the answer has ${items.length} bullets; at most ${MAX_BULLETS}` }
  return { kind: 'bullets', items }
}

/** The notes file with `version`'s entry set, newest first. */
export function withEntry(notes, version, items) {
  const rest = Object.fromEntries(Object.entries(notes).filter(([key]) => key !== version))
  return { [version]: items, ...rest }
}

function readNotes(file) {
  const parsed = JSON.parse(readFileSync(file, 'utf8'))
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error(`${file} is not a JSON object`)
  return parsed
}

function gitBody(sha) {
  try {
    return execFileSync('git', ['show', '-s', '--format=%b', sha], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
  } catch {
    // silent-ok: a commit git cannot show is described by its subject alone
    return ''
  }
}

function warn(message) {
  console.log(`::warning title=What's new notes::${message}`)
}

export function main(argv, env) {
  const runner = argv
  if (runner.length === 0) {
    warn('no prompt runner given; no notes written')
    return
  }
  const notesFile = env.WHATS_NEW_FILE || 'desktop/whats-new.json'
  const promptFile = env.WHATS_NEW_PROMPT || '.github/ion/whats-new-prompt.md'
  const reviewFile = env.WHATS_NEW_REVIEW || '.github/ion/whats-new-review-prompt.md'

  let report
  try {
    report = JSON.parse(env.RELEASE_REPORT ?? '')
  } catch (err) {
    warn(`RELEASE_REPORT is not JSON (${err.message}); no notes written`)
    return
  }
  const release = desktopRelease(report)
  if (!release) {
    console.log('whats-new: this push released no desktop version; nothing to write')
    return
  }
  const version = release.new_version
  const commits = shippedCommits(report)
  if (commits.length === 0) {
    console.log(`whats-new: desktop ${version} lists no commits; nothing to write`)
    return
  }

  let notes
  try {
    notes = readNotes(notesFile)
  } catch (err) {
    warn(`cannot read ${notesFile} (${err.message}); no notes written for ${version}`)
    return
  }

  const work = mkdtempSync(join(tmpdir(), 'whats-new-'))
  /** One agent run: the prompt in, its answer out, or null when the run failed. */
  const ask = (step, promptText) => {
    const prompt = join(work, `${step}-prompt.md`)
    const answer = join(work, `${step}-answer.md`)
    writeFileSync(prompt, promptText)
    const run = spawnSync(runner[0], [...runner.slice(1), prompt, answer], { stdio: 'inherit' })
    if (run.error || run.status !== 0) {
      warn(`the ${step} run failed (${run.error?.message ?? `exit ${run.status}`}); no notes written for ${version}`)
      return null
    }
    return readFileSync(answer, 'utf8')
  }

  console.log(`whats-new: asking for desktop ${version} notes from ${commits.length} commits`)
  const draft = ask('writer', composePrompt(readFileSync(promptFile, 'utf8'), version, commits, gitBody))
  if (draft === null) return

  const result = parseHighlights(draft)
  if (result.kind === 'invalid') {
    warn(`${result.reason}; no notes written for ${version}`)
    return
  }
  if (result.kind === 'none') {
    console.log(`whats-new: nothing in desktop ${version} for people to notice; no notes written`)
    return
  }

  const checked = []
  for (const item of result.items) {
    const problem = lintHighlight(item)
    if (problem) console.log(`whats-new: dropped a note that ${problem}: ${item}`)
    else checked.push(item)
  }
  if (checked.length === 0) {
    warn(`every drafted note failed the checks; no notes written for ${version}`)
    return
  }

  console.log(`whats-new: asking the reviewer to judge ${checked.length} notes`)
  const answer = ask('review', composeReviewPrompt(readFileSync(reviewFile, 'utf8'), version, commits, gitBody, checked))
  if (answer === null) return
  const review = parseReview(answer, checked.length)
  if ('invalid' in review) {
    warn(`the review answer is unclear (${review.invalid}); no notes written for ${version}`)
    return
  }
  for (const [n, reason] of review.dropped) console.log(`whats-new: the reviewer dropped a note (${reason}): ${checked[n - 1]}`)
  const items = review.kept.map((n) => checked[n - 1])
  if (items.length === 0) {
    console.log(`whats-new: the reviewer kept no notes; no notes written for ${version}`)
    return
  }

  writeFileSync(notesFile, `${JSON.stringify(withEntry(notes, version, items), null, 2)}\n`)
  console.log(`whats-new: wrote ${items.length} reviewed notes for desktop ${version} to ${notesFile}`)
  for (const item of items) console.log(`  - ${item}`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main(process.argv.slice(2), process.env)
  } catch (err) {
    warn(`unexpected failure (${err.message}); no notes written`)
  }
}
