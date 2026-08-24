/**
 * QuestionsCoordinator tests — pins the main-owned workflow state machine
 * under the PARK/RESUME architecture: parked-denial intake (idempotent per
 * toolUseId), revisioned patch/action CAS, ATOMIC inline-draft submission
 * (the "Review answers" fix), submit → resume-prompt dispatch, requestMore
 * continuation by exact workflowId, persistence across restart, and the
 * retirement rules (supersession, idle-denials reconcile, explicit cancel —
 * and NEVER on stop/navigation).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

vi.mock('../logger', () => ({
  log: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn(),
}))

// Redirect ~/.ion/questions into a temp dir per test run.
const tempHome = mkdtempSync(join(tmpdir(), 'ion-questions-test-'))
vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>()
  return { ...actual, homedir: () => tempHome }
})

import { QuestionsCoordinator } from './questions-coordinator'
import type { QuestionsStateSnapshot, QuestionsWorkflowState } from '../../shared/questions-state'

function validInput(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    title: 'Scope',
    questions: [
      {
        id: 'q1',
        prompt: 'Storage backend?',
        mode: 'single',
        options: [
          { id: 'a', label: 'SQLite' },
          { id: 'b', label: 'Postgres' },
        ],
      },
    ],
    ...extra,
  }
}

describe('QuestionsCoordinator (park/resume)', () => {
  let submissions: Array<{ workflow: QuestionsWorkflowState; requestMore: boolean }>
  let submitResult: boolean
  let fanouts: QuestionsStateSnapshot[]
  let notified: QuestionsWorkflowState[]
  let coordinator: QuestionsCoordinator

  beforeEach(() => {
    submissions = []
    submitResult = true
    fanouts = []
    notified = []
    coordinator = new QuestionsCoordinator(
      (workflow, requestMore) => {
        submissions.push({ workflow, requestMore })
        return submitResult
      },
      (snapshot) => fanouts.push(snapshot),
      (wf) => notified.push(wf),
    )
  })

  afterEach(() => {
    rmSync(join(tempHome, '.ion', 'questions'), { recursive: true, force: true })
  })

  const openWorkflow = (): QuestionsWorkflowState => {
    coordinator.handleParkedQuestion('tab-1', 'tu-1', validInput())
    const wf = coordinator.snapshot().workflows[0]
    expect(wf).toBeDefined()
    return wf
  }

  // ── Intake ────────────────────────────────────────────────────────────────

  it('opens a collecting workflow from a parked denial and notifies once', () => {
    const wf = openWorkflow()
    expect(wf.phase).toBe('collecting')
    expect(wf.sessionKey).toBe('tab-1')
    expect(wf.requestId).toBe('tu-1')
    expect(wf.request.title).toBe('Scope')
    expect(wf.draft).toEqual([{ questionId: 'q1', selectedOptionIds: [] }])
    expect(notified).toHaveLength(1)
  })

  it('is idempotent per toolUseId: heartbeat re-publishes do not reset the draft or re-ring', () => {
    const wf = openWorkflow()
    // Type an answer, then replay the same parked denial (heartbeat).
    const accepted = coordinator.applyPatch({
      workflowId: wf.workflowId, requestId: 'tu-1', expectedRevision: wf.revision,
      actionId: 'a1', answers: [{ questionId: 'q1', selectedOptionIds: ['a'] }],
    })
    expect(accepted.accepted).toBe(true)
    coordinator.handleParkedQuestion('tab-1', 'tu-1', validInput())
    const after = coordinator.snapshot().workflows[0]
    expect(after.workflowId).toBe(wf.workflowId)
    expect(after.draft[0].selectedOptionIds).toEqual(['a'])
    expect(notified).toHaveLength(1)
  })

  it('rejects malformed input without opening a workflow', () => {
    coordinator.handleParkedQuestion('tab-1', 'tu-bad', { title: 'x' }) // no questions
    expect(coordinator.snapshot().workflows).toHaveLength(0)
  })

  // ── Revisioned mutations ──────────────────────────────────────────────────

  it('applies a valid patch and bumps the revision', () => {
    const wf = openWorkflow()
    const revisionBefore = wf.revision
    const result = coordinator.applyPatch({
      workflowId: wf.workflowId, requestId: 'tu-1', expectedRevision: revisionBefore,
      actionId: 'a1', answers: [{ questionId: 'q1', selectedOptionIds: ['b'] }], comment: 'ctx',
    })
    expect(result.accepted).toBe(true)
    const after = coordinator.snapshot().workflows[0]
    expect(after.revision).toBe(revisionBefore + 1)
    expect(after.comment).toBe('ctx')
  })

  it('rejects a stale revision (CAS) and fans out the authoritative state', () => {
    const wf = openWorkflow()
    const fanoutsBefore = fanouts.length
    const result = coordinator.applyPatch({
      workflowId: wf.workflowId, requestId: 'tu-1', expectedRevision: wf.revision + 5,
      actionId: 'a1', answers: [{ questionId: 'q1', selectedOptionIds: ['a'] }],
    })
    expect(result.accepted).toBe(false)
    expect(result.error).toContain('stale revision')
    expect(fanouts.length).toBeGreaterThan(fanoutsBefore)
  })

  it('rejects invalid option ids and multi-select on single mode', () => {
    const wf = openWorkflow()
    expect(
      coordinator.applyPatch({
        workflowId: wf.workflowId, requestId: 'tu-1', expectedRevision: wf.revision,
        actionId: 'a1', answers: [{ questionId: 'q1', selectedOptionIds: ['nope'] }],
      }).accepted,
    ).toBe(false)
    expect(
      coordinator.applyPatch({
        workflowId: wf.workflowId, requestId: 'tu-1', expectedRevision: wf.revision,
        actionId: 'a2', answers: [{ questionId: 'q1', selectedOptionIds: ['a', 'b'] }],
      }).accepted,
    ).toBe(false)
  })

  it('accepts attachments on a draft answer and carries them into the page result', () => {
    const wf = openWorkflow()
    const result = coordinator.applyAction({
      workflowId: wf.workflowId, requestId: 'tu-1', expectedRevision: wf.revision,
      actionId: 'a1', kind: 'final_confirm',
      answers: [{
        questionId: 'q1', selectedOptionIds: ['a'],
        attachments: [{ path: '/tmp/shot.png', name: 'shot.png' }],
      }],
    })
    expect(result.accepted).toBe(true)
    expect(submissions).toHaveLength(1)
    const page = submissions[0].workflow.history[0]
    expect(page.answers[0].attachments).toEqual([{ path: '/tmp/shot.png', name: 'shot.png' }])
  })

  // ── Atomic submission (the "Review answers" fix) ──────────────────────────

  it('final_confirm with inline draft applies answers and submits in ONE revision step', () => {
    const wf = openWorkflow()
    // No prior patch: the action itself carries the final draft against the
    // CURRENT revision. This is exactly the case the old patch-then-action
    // chain lost to the CAS race.
    const result = coordinator.applyAction({
      workflowId: wf.workflowId, requestId: 'tu-1', expectedRevision: wf.revision,
      actionId: 'a1', kind: 'final_confirm',
      answers: [{ questionId: 'q1', selectedOptionIds: ['b'] }], comment: 'done',
    })
    expect(result.accepted).toBe(true)
    expect(submissions).toHaveLength(1)
    expect(submissions[0].requestMore).toBe(false)
    const page = submissions[0].workflow.history[0]
    expect(page.answers[0].selectedLabels).toEqual(['Postgres'])
    expect(page.comment).toBe('done')
    expect(coordinator.snapshot().workflows[0].phase).toBe('submitting')
  })

  it('enter_review with inline draft transitions atomically', () => {
    const wf = openWorkflow()
    const result = coordinator.applyAction({
      workflowId: wf.workflowId, requestId: 'tu-1', expectedRevision: wf.revision,
      actionId: 'a1', kind: 'enter_review',
      answers: [{ questionId: 'q1', selectedOptionIds: ['a'] }],
    })
    expect(result.accepted).toBe(true)
    const after = coordinator.snapshot().workflows[0]
    expect(after.phase).toBe('review')
    expect(after.draft[0].selectedOptionIds).toEqual(['a'])
  })

  it('restores the ACTING phase when the resume-prompt dispatch fails', () => {
    const wf = openWorkflow()
    submitResult = false
    // request_more from the COLLECTING page. A failed dispatch must leave the
    // user on collecting — the old rollback hardcoded 'review', so a failure
    // silently moved them to the review screen and read as "Ask me more
    // questions goes to Review".
    const result = coordinator.applyAction({
      workflowId: wf.workflowId, requestId: 'tu-1', expectedRevision: wf.revision,
      actionId: 'a1', kind: 'request_more',
      answers: [{ questionId: 'q1', selectedOptionIds: ['a'] }],
    })
    expect(result.accepted).toBe(false)
    const after = coordinator.snapshot().workflows[0]
    expect(after.phase).toBe('collecting')
    expect(after.history).toHaveLength(0)
    // The typed answer survives the failed attempt.
    expect(after.draft[0].selectedOptionIds).toEqual(['a'])
  })

  it('restores review when the failing action came from the review page', () => {
    const wf = openWorkflow()
    coordinator.applyAction({
      workflowId: wf.workflowId, requestId: 'tu-1', expectedRevision: wf.revision,
      actionId: 'a1', kind: 'enter_review',
      answers: [{ questionId: 'q1', selectedOptionIds: ['a'] }],
    })
    submitResult = false
    const inReview = coordinator.snapshot().workflows[0]
    const result = coordinator.applyAction({
      workflowId: inReview.workflowId, requestId: 'tu-1', expectedRevision: inReview.revision,
      actionId: 'a2', kind: 'final_confirm',
    })
    expect(result.accepted).toBe(false)
    expect(coordinator.snapshot().workflows[0].phase).toBe('review')
  })

  it('unanswered questions submit as explicit skips', () => {
    const wf = openWorkflow()
    coordinator.applyAction({
      workflowId: wf.workflowId, requestId: 'tu-1', expectedRevision: wf.revision,
      actionId: 'a1', kind: 'final_confirm',
    })
    const page = submissions[0].workflow.history[0]
    expect(page.answers[0].skipped).toBe(true)
  })

  // ── Lifecycle: prompt dispatch resolves submitting/supersedes parked ──────

  it('our resume prompt completes the submitting workflow (terminal confirmed)', () => {
    const wf = openWorkflow()
    coordinator.applyAction({
      workflowId: wf.workflowId, requestId: 'tu-1', expectedRevision: wf.revision,
      actionId: 'a1', kind: 'final_confirm',
      answers: [{ questionId: 'q1', selectedOptionIds: ['a'] }],
    })
    coordinator.handlePromptDispatched('tab-1', true)
    // Terminal states broadcast once then drop.
    expect(coordinator.snapshot().workflows).toHaveLength(0)
    const lastWithWorkflows = [...fanouts].reverse().find((f) => f.workflows.length > 0)
    expect(lastWithWorkflows?.workflows[0].terminalReason).toBe('confirmed')
  })

  it('a missing continuation page RESTORES the round instead of destroying it', () => {
    // The model finished its turn without calling AskUserQuestions again, so
    // the deeper page the operator asked for never arrived. Retiring here
    // deleted their submitted answers and their explicit "ask me more" — a
    // model forgetting a tool call must never cost the operator work.
    const wf = openWorkflow()
    coordinator.applyAction({
      workflowId: wf.workflowId, requestId: 'tu-1', expectedRevision: wf.revision,
      actionId: 'a1', kind: 'request_more',
      answers: [{ questionId: 'q1', selectedOptionIds: ['a'] }],
    })
    coordinator.handlePromptDispatched('tab-1', true)
    expect(coordinator.snapshot().workflows[0].phase).toBe('awaiting_next')

    coordinator.handleRunIdle('tab-1')

    const after = coordinator.snapshot().workflows[0]
    expect(after).toBeDefined()
    expect(after.phase).toBe('review')
    // The submitted page survives, so the operator can Confirm & send or ask
    // again without re-entering anything.
    expect(after.history).toHaveLength(1)
    expect(after.history[0].answers[0].selectedLabels).toEqual(['SQLite'])
    expect(after.pendingRequestMore).toBeUndefined()
  })

  it('run idle never disturbs a collecting workflow', () => {
    // Only the awaiting-continuation case is affected; an ordinary parked
    // question outlives any number of unrelated run completions.
    openWorkflow()
    coordinator.handleRunIdle('tab-1')
    expect(coordinator.snapshot().workflows[0].phase).toBe('collecting')
  })

  it('requestMore advances to awaiting_next and attaches the continuation page', () => {
    const wf = openWorkflow()
    coordinator.applyAction({
      workflowId: wf.workflowId, requestId: 'tu-1', expectedRevision: wf.revision,
      actionId: 'a1', kind: 'request_more',
      answers: [{ questionId: 'q1', selectedOptionIds: ['a'] }],
    })
    expect(submissions[0].requestMore).toBe(true)
    coordinator.handlePromptDispatched('tab-1', true)
    expect(coordinator.snapshot().workflows[0].phase).toBe('awaiting_next')

    // The model calls again with the exact workflowId → new page attaches,
    // same identity, fresh draft, prior history retained.
    coordinator.handleParkedQuestion('tab-1', 'tu-2', validInput({ workflowId: wf.workflowId, title: 'Deeper' }))
    const cont = coordinator.snapshot().workflows[0]
    expect(cont.workflowId).toBe(wf.workflowId)
    expect(cont.requestId).toBe('tu-2')
    expect(cont.phase).toBe('collecting')
    expect(cont.request.title).toBe('Deeper')
    expect(cont.history).toHaveLength(1)
  })

  it('a foreign prompt supersedes parked workflows', () => {
    openWorkflow()
    coordinator.handlePromptDispatched('tab-1', false)
    expect(coordinator.snapshot().workflows).toHaveLength(0)
    const lastWithWorkflows = [...fanouts].reverse().find((f) => f.workflows.length > 0)
    expect(lastWithWorkflows?.workflows[0].terminalReason).toBe('superseded')
  })

  it('matches extension-hosted session keys by tab prefix on prompt dispatch', () => {
    coordinator.handleParkedQuestion('tab-1:main', 'tu-1', validInput())
    coordinator.handlePromptDispatched('tab-1', false)
    expect(coordinator.snapshot().workflows).toHaveLength(0)
  })

  it('a prompt on a DIFFERENT tab leaves the workflow alone', () => {
    openWorkflow()
    coordinator.handlePromptDispatched('tab-2', false)
    expect(coordinator.snapshot().workflows).toHaveLength(1)
  })

  // ── Lifecycle: idle-denials reconcile ─────────────────────────────────────

  it('idle snapshot retaining the denial keeps the workflow', () => {
    openWorkflow()
    coordinator.handleIdleDenialsSnapshot('tab-1', new Set(['tu-1']), true)
    expect(coordinator.snapshot().workflows).toHaveLength(1)
  })

  it('idle snapshot carrying OTHER denials but not ours retires the workflow', () => {
    // Positive evidence: the engine re-published its retained state and our
    // question is not in it, so it was genuinely superseded elsewhere.
    openWorkflow()
    coordinator.handleIdleDenialsSnapshot('tab-1', new Set(['tu-other']), true)
    expect(coordinator.snapshot().workflows).toHaveLength(0)
  })

  it('an EMPTY idle snapshot never retires (reconnect has not re-published yet)', () => {
    // The restart-destroys-questions defect: the desktop re-registers every
    // session on reconnect, and the first idle status carries no denials.
    // Treating that as authoritative deleted live workflows AND their
    // persisted records, so the panel was gone after a reinstall.
    openWorkflow()
    coordinator.handleIdleDenialsSnapshot('tab-1', new Set(), false)
    expect(coordinator.snapshot().workflows).toHaveLength(1)
  })

  it('idle reconcile never touches a submitting workflow', () => {
    const wf = openWorkflow()
    coordinator.applyAction({
      workflowId: wf.workflowId, requestId: 'tu-1', expectedRevision: wf.revision,
      actionId: 'a1', kind: 'final_confirm',
      answers: [{ questionId: 'q1', selectedOptionIds: ['a'] }],
    })
    coordinator.handleIdleDenialsSnapshot('tab-1', new Set(['tu-other']), true)
    expect(coordinator.snapshot().workflows[0].phase).toBe('submitting')
  })

  // ── Lifecycle: explicit cancel ────────────────────────────────────────────

  it('cancel retires the workflow', () => {
    const wf = openWorkflow()
    const result = coordinator.applyAction({
      workflowId: wf.workflowId, requestId: 'tu-1', expectedRevision: wf.revision,
      actionId: 'a1', kind: 'cancel',
    })
    expect(result.accepted).toBe(true)
    expect(coordinator.snapshot().workflows).toHaveLength(0)
  })

  // ── Transcript rehydration (survives a wiped cache) ───────────────────────

  describe('rehydrateFromRows', () => {
    const questionRow = {
      role: 'assistant',
      toolName: 'AskUserQuestions',
      toolId: 'call_transcript_1',
      toolInput: JSON.stringify(validInput({ title: 'From transcript' })),
    }

    it('opens a workflow from the transcript when the cache is empty', () => {
      // The reinstall case: ~/.ion/questions holds nothing, but the question
      // is sitting in the conversation file, unanswered.
      const opened = coordinator.rehydrateFromRows('tab-1', [questionRow])

      expect(opened).toBe(true)
      const wf = coordinator.snapshot().workflows[0]
      expect(wf.phase).toBe('collecting')
      expect(wf.requestId).toBe('call_transcript_1')
      expect(wf.request.title).toBe('From transcript')
    })

    it('never clobbers a live workflow (it may hold a typed draft)', () => {
      const wf = openWorkflow()
      coordinator.applyPatch({
        workflowId: wf.workflowId, requestId: 'tu-1', expectedRevision: wf.revision,
        actionId: 'a1', answers: [{ questionId: 'q1', selectedOptionIds: ['b'] }],
      })

      const opened = coordinator.rehydrateFromRows('tab-1', [questionRow])

      expect(opened).toBe(false)
      const after = coordinator.snapshot().workflows
      expect(after).toHaveLength(1)
      expect(after[0].draft[0].selectedOptionIds).toEqual(['b'])
    })

    it('opens nothing when the transcript shows the question was answered', () => {
      const opened = coordinator.rehydrateFromRows('tab-1', [
        questionRow,
        { role: 'user', content: 'my answers' },
      ])

      expect(opened).toBe(false)
      expect(coordinator.snapshot().workflows).toHaveLength(0)
    })

    it('a rehydrated workflow is immediately answerable', () => {
      coordinator.rehydrateFromRows('tab-1', [questionRow])
      const wf = coordinator.snapshot().workflows[0]

      const result = coordinator.applyAction({
        workflowId: wf.workflowId, requestId: wf.requestId, expectedRevision: wf.revision,
        actionId: 'a1', kind: 'final_confirm',
        answers: [{ questionId: 'q1', selectedOptionIds: ['a'] }],
      })

      expect(result.accepted).toBe(true)
      expect(submissions).toHaveLength(1)
    })

    it('does not re-ring the notifier for a rehydrated question', () => {
      // Restoring a conversation is not new information; the operator is
      // already looking at it.
      coordinator.rehydrateFromRows('tab-1', [questionRow])
      expect(notified).toHaveLength(0)
    })
  })

  // ── Persistence across restart ────────────────────────────────────────────

  it('a collecting workflow with a typed draft survives restart, immediately answerable', () => {
    const wf = openWorkflow()
    coordinator.applyPatch({
      workflowId: wf.workflowId, requestId: 'tu-1', expectedRevision: wf.revision,
      actionId: 'a1', answers: [{ questionId: 'q1', selectedOptionIds: ['b'] }], comment: 'draft note',
    })

    const restarted = new QuestionsCoordinator(() => true, () => {}, () => {})
    restarted.restore()
    const restored = restarted.snapshot().workflows[0]
    expect(restored).toBeDefined()
    expect(restored.workflowId).toBe(wf.workflowId)
    expect(restored.phase).toBe('collecting')
    expect(restored.draft[0].selectedOptionIds).toEqual(['b'])
    expect(restored.comment).toBe('draft note')

    // And it is immediately submittable — no engine confirmation gate.
    const submitted: boolean[] = []
    const restarted2 = new QuestionsCoordinator(() => { submitted.push(true); return true }, () => {}, () => {})
    restarted2.restore()
    const w2 = restarted2.snapshot().workflows[0]
    const result = restarted2.applyAction({
      workflowId: w2.workflowId, requestId: w2.requestId, expectedRevision: w2.revision,
      actionId: 'a2', kind: 'final_confirm',
      answers: [{ questionId: 'q1', selectedOptionIds: ['a'] }],
    })
    expect(result.accepted).toBe(true)
    expect(submitted).toHaveLength(1)
  })

  it('submitting/awaiting_next records are dropped on restore (transition died with the process)', () => {
    const wf = openWorkflow()
    coordinator.applyAction({
      workflowId: wf.workflowId, requestId: 'tu-1', expectedRevision: wf.revision,
      actionId: 'a1', kind: 'final_confirm',
      answers: [{ questionId: 'q1', selectedOptionIds: ['a'] }],
    })
    // Persisted phase is now 'submitting'.
    const restarted = new QuestionsCoordinator(() => true, () => {}, () => {})
    restarted.restore()
    expect(restarted.snapshot().workflows).toHaveLength(0)
  })

  it('restored workflows do not re-ring the notifier on the next heartbeat re-publish', () => {
    openWorkflow()
    expect(notified).toHaveLength(1)
    const rings: QuestionsWorkflowState[] = []
    const restarted = new QuestionsCoordinator(() => true, () => {}, (wf) => rings.push(wf))
    restarted.restore()
    restarted.handleParkedQuestion('tab-1', 'tu-1', validInput())
    expect(rings).toHaveLength(0)
  })
})
