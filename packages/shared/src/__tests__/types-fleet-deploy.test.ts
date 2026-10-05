/** The Fleet Deploy Record: read from an untrusted sender, kept newest first, and judged lost when its process goes quiet. */
import { describe, expect, it } from 'vitest'
import {
  FLEET_DEPLOYS_KEPT, FLEET_DEPLOY_LOST_MS, fleetDeployCounts, fleetDeployLost, fleetDeployTargetStanding, mergeFleetDeploy, parseFleetDeployRecord,
  type FleetDeploy,
} from '../types-fleet-deploy'
import { parseFleetDeployEvent } from '../types-fleet-run'

const record = { id: 'd1', source: 'build of ion', startedAt: 10, updatedAt: 20, state: 'running', targets: [{ host: 'mac-1', label: 'Mac one', environmentId: 'env-1', component: 'server', platform: 'darwin/arm64', stage: 'building', detail: 'packaging', updatedAt: 20 }] }
const held = (over: Partial<FleetDeploy>): FleetDeploy => ({ ...(record as unknown as FleetDeploy), receivedAt: 100, ...over })

describe('parseFleetDeployRecord', () => {
  it('reads the record the fleet sends', () => {
    expect(parseFleetDeployRecord(record)).toEqual(record)
    expect(parseFleetDeployRecord({ ...record, state: 'failed', endedAt: 30, targets: [{ host: 'mac-1', stage: 'failed', error: 'no builder' }] })).toEqual({
      id: 'd1', source: 'build of ion', startedAt: 10, updatedAt: 20, endedAt: 30, state: 'failed', targets: [{ host: 'mac-1', label: 'mac-1', stage: 'failed', updatedAt: 20, error: 'no builder' }],
    })
  })

  it('refuses what is not a record, and carries nothing the type does not name', () => {
    for (const bad of [null, 'x', {}, { ...record, id: '' }, { ...record, state: 'paused' }, { ...record, startedAt: 'now' }, { ...record, targets: 'none' }, { ...record, targets: [{ stage: 'queued' }] }]) {
      expect(parseFleetDeployRecord(bad)).toBeNull()
    }
    const parsed = parseFleetDeployRecord({ ...record, extra: 'x', targets: [{ ...record.targets[0], ssh: 'user@host', detail: 'y'.repeat(5_000) }] })
    expect(JSON.stringify(parsed)).not.toContain('user@host')
    expect(parsed).not.toHaveProperty('extra')
    expect(parsed?.targets[0].detail).toHaveLength(2_000)
  })
})

describe('a deploy as it is held', () => {
  it('is lost when a running one has not been heard of for a while, and never once it ended', () => {
    expect(fleetDeployLost(held({ receivedAt: 0 }), FLEET_DEPLOY_LOST_MS)).toBe(false)
    expect(fleetDeployLost(held({ receivedAt: 0 }), FLEET_DEPLOY_LOST_MS + 1)).toBe(true)
    expect(fleetDeployLost(held({ receivedAt: 0, state: 'done' }), FLEET_DEPLOY_LOST_MS * 10)).toBe(false)
  })

  it('counts its servers by where they stand', () => {
    expect(['queued', 'waiting for the terminal', 'building', 'deploying', 'verifying', 'done', 'failed'].map((stage) => fleetDeployTargetStanding({ stage }))).toEqual(['waiting', 'waiting', 'working', 'working', 'working', 'done', 'failed'])
    expect(fleetDeployCounts({ targets: [{ stage: 'done' }, { stage: 'failed' }, { stage: 'building' }] as FleetDeploy['targets'] })).toEqual({ done: 1, failed: 1, total: 3 })
  })

  it('replaces a deploy by id, drops an older record, and keeps the newest few', () => {
    const first = mergeFleetDeploy([], held({}))
    expect(mergeFleetDeploy(first, held({ updatedAt: 30, state: 'done' }))).toMatchObject([{ id: 'd1', state: 'done' }])
    expect(mergeFleetDeploy(mergeFleetDeploy(first, held({ updatedAt: 30, state: 'done' })), held({ updatedAt: 25 }))).toMatchObject([{ state: 'done' }])
    let many: FleetDeploy[] = []
    for (let i = 0; i < FLEET_DEPLOYS_KEPT + 2; i++) many = mergeFleetDeploy(many, held({ id: `d${i}`, startedAt: i }))
    expect(many).toHaveLength(FLEET_DEPLOYS_KEPT)
    expect(many[0].id).toBe(`d${FLEET_DEPLOYS_KEPT + 1}`)
  })
})

describe('parseFleetDeployEvent', () => {
  it('reads each kind of event the fleet prints, and nothing else', () => {
    expect(parseFleetDeployEvent('{"event":"log","hosts":["a"],"line":"npm ci"}')).toEqual({ event: 'log', hosts: ['a'], line: 'npm ci' })
    expect(parseFleetDeployEvent('{"event":"plan","lines":[],"blocked":false,"targets":[],"builds":[]}')).toMatchObject({ event: 'plan', targets: [] })
    expect(parseFleetDeployEvent('{"event":"surprise"}')).toBeNull()
    expect(parseFleetDeployEvent('{not json')).toBeNull()
    expect(parseFleetDeployEvent('plain text')).toBeNull()
  })
})
