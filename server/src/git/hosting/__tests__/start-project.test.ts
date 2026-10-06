/**
 * gitHosting.startProject — one request runs create, clone, open, model,
 * and prompt as one `create` job; a retry resumes at the failed step; the
 * scope and destination checks refuse before anything is made.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { Connection } from '../../../protocol/connection'
import type { EnvironmentJob } from '@ion/shared/types-environment-admin'

const h = vi.hoisted(() => ({
  broadcast: vi.fn(),
  createRepositoryAs: vi.fn(),
  chooseCloneUrl: vi.fn(async () => 'git@github.com:alice/idea.git'),
  startClone: vi.fn(),
  createTabForClient: vi.fn(async () => 'tab-1'),
  notifyTabCreated: vi.fn(async () => true),
  submitClientPrompt: vi.fn(async (): Promise<{ accepted: boolean; reason?: string; clientMsgId: string }> => ({ accepted: true, clientMsgId: 'm1' })),
  setTabModel: vi.fn(),
}))
vi.mock('../../../broadcast', () => ({ broadcast: h.broadcast }))
vi.mock('../create', async (orig) => ({ ...(await orig<typeof import('../create')>()), createRepositoryAs: h.createRepositoryAs }))
vi.mock('../../../environment/clone-url', () => ({ chooseCloneUrl: h.chooseCloneUrl }))
vi.mock('../../../environment/clone', () => ({ startClone: h.startClone }))
vi.mock('../../../remote/handlers/tabs-create-echo', () => ({ createTabForClient: h.createTabForClient, notifyTabCreated: h.notifyTabCreated }))
vi.mock('../../../remote/handlers/tabs-prompt', () => ({ submitClientPrompt: h.submitClientPrompt }))
vi.mock('../../../store/sessionStore', () => ({ useSessionStore: { getState: () => ({ setTabModel: h.setTabModel }) } }))

import { GIT_HOSTING_ACTIONS } from '../actions'
import { _resetStartProjectForTest } from '../start-project'
import { awaitJobSettled, finishJob, failJob, startJob, _resetJobsForTest } from '../../../environment/jobs'
import { registeredActionSpec } from '../../../protocol/actions'

const REPOSITORY = { host: 'github.com', provider: 'github', owner: 'alice', name: 'idea', sshUrl: 'git@github.com:alice/idea.git', httpsUrl: 'https://github.com/alice/idea.git', webUrl: 'https://github.com/alice/idea', defaultBranch: 'main' }

let parent: string
const conn = (scopes: string[] = ['git:write', 'conversations:operate']) => ({ id: 'c1', pairedClientId: 'phone-1', scopes, principal: { subject: 'oidc:alice' } } as unknown as Connection)
const request = (over: Record<string, unknown> = {}) => ({ host: 'github.com', owner: 'alice', name: 'idea', visibility: 'private', requestId: 'r1', parentDir: parent, prompt: 'Build a todo app', model: 'claude-fable-5-1', providerId: 'anthropic', ...over })
const run = (args: Record<string, unknown>, c = conn()) => GIT_HOSTING_ACTIONS['gitHosting.startProject'].handler(c, [args])

/** A clone job that settles the way `outcome` says, as the real clone does. */
function cloneSettling(outcome: 'done' | 'failed'): void {
  h.startClone.mockImplementationOnce(async ({ name }: { name: string }) => {
    const dir = join(parent, name)
    const job = startJob({ kind: 'clone', dir, stage: 'starting' }, null)
    setTimeout(() => {
      if (outcome === 'done') { mkdirSync(dir); finishJob(job.id) } else failJob(job.id, 'git clone exited 128')
    }, 0)
    return { jobId: job.id, dir }
  })
}

async function settle(value: unknown): Promise<EnvironmentJob | undefined> {
  return awaitJobSettled((value as { jobId: string }).jobId)
}

beforeEach(() => {
  parent = mkdtempSync(join(tmpdir(), 'ion-start-project-'))
  h.createRepositoryAs.mockResolvedValue(REPOSITORY)
})
afterEach(() => {
  rmSync(parent, { recursive: true, force: true })
  _resetJobsForTest()
  _resetStartProjectForTest()
  vi.clearAllMocks()
})

describe('gitHosting.startProject', () => {
  it('is registered for the phone at git:write', () => {
    expect(registeredActionSpec('gitHosting.startProject')?.requiredScope).toBe('git:write')
  })

  it('creates, clones trusted, opens the conversation on the picked model, then sends the prompt', async () => {
    cloneSettling('done')
    const outcome = await run(request({ profileId: 'dev' }))
    expect(outcome).toMatchObject({ ok: true, value: { dir: join(parent, 'idea') } })
    const job = await settle((outcome as { value: unknown }).value)
    expect(job).toMatchObject({ kind: 'create', phase: 'done', tabId: 'tab-1', dir: join(parent, 'idea') })
    expect(h.createRepositoryAs).toHaveBeenCalledWith('oidc:alice', expect.objectContaining({ host: 'github.com', owner: 'alice', name: 'idea', visibility: 'private' }))
    expect(h.startClone).toHaveBeenCalledWith({ url: 'git@github.com:alice/idea.git', parentDir: parent, name: 'idea', trust: true })
    expect(h.createTabForClient).toHaveBeenCalledWith({ workingDirectory: join(parent, 'idea'), profileId: 'dev' })
    expect(h.setTabModel).toHaveBeenCalledWith('tab-1', 'claude-fable-5-1', 'anthropic')
    expect(h.setTabModel.mock.invocationCallOrder[0]).toBeLessThan(h.submitClientPrompt.mock.invocationCallOrder[0])
    expect(h.submitClientPrompt).toHaveBeenCalledWith({ tabId: 'tab-1', text: 'Build a todo app', instanceId: '' }, { kind: 'caller', clientId: 'phone-1', principalSubject: 'oidc:alice' })
  })

  it('opens the conversation without a prompt when none was given, on the default model when none was picked', async () => {
    cloneSettling('done')
    const job = await settle((await run(request({ prompt: '', model: '' })) as { value: unknown }).value)
    expect(job).toMatchObject({ phase: 'done', tabId: 'tab-1' })
    expect(h.setTabModel).not.toHaveBeenCalled()
    expect(h.submitClientPrompt).not.toHaveBeenCalled()
  })

  it('resumes a failed clone without creating the repository again', async () => {
    cloneSettling('failed')
    const first = await settle(((await run(request())) as { value: unknown }).value)
    expect(first).toMatchObject({ phase: 'failed', error: 'git clone exited 128' })
    cloneSettling('done')
    const second = await settle(((await run(request())) as { value: unknown }).value)
    expect(second).toMatchObject({ phase: 'done', tabId: 'tab-1' })
    expect(h.createRepositoryAs).toHaveBeenCalledTimes(1)
    expect(h.startClone).toHaveBeenCalledTimes(2)
  })

  it('a repeat of a finished request answers its job and does nothing again', async () => {
    cloneSettling('done')
    const first = (await run(request())) as { value: { jobId: string } }
    await settle(first.value)
    const again = (await run(request())) as { value: { jobId: string } }
    expect(again.value.jobId).toBe(first.value.jobId)
    expect(h.createRepositoryAs).toHaveBeenCalledTimes(1)
  })

  it('fails the job with the reason when the prompt is refused, and a retry only resends the prompt', async () => {
    cloneSettling('done')
    h.submitClientPrompt.mockResolvedValueOnce({ accepted: false, reason: 'engine offline', clientMsgId: 'm1' })
    const first = await settle(((await run(request())) as { value: unknown }).value)
    expect(first?.error).toContain('engine offline')
    expect(first?.tabId).toBe('tab-1')
    const second = await settle(((await run(request())) as { value: unknown }).value)
    expect(second).toMatchObject({ phase: 'done', tabId: 'tab-1' })
    expect(h.createTabForClient).toHaveBeenCalledTimes(1)
    expect(h.submitClientPrompt).toHaveBeenCalledTimes(2)
  })

  it('refuses without conversations:operate, an existing destination, or missing fields, before creating anything', async () => {
    expect(await run(request(), conn(['git:write']))).toMatchObject({ ok: false, refusal: { code: 'scope' } })
    mkdirSync(join(parent, 'idea'))
    expect(await run(request())).toMatchObject({ ok: false, refusal: { code: 'start_refused' } })
    expect(await run(request({ requestId: '' }))).toMatchObject({ ok: false, error: { code: 'invalid_args' } })
    expect(await run(request({ name: 'bad name' }))).toMatchObject({ ok: false, error: { code: 'invalid_args' } })
    expect(h.createRepositoryAs).not.toHaveBeenCalled()
  })
})
