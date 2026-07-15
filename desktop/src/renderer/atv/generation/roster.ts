/**
 * Roster derivation: live agent state → the org structure the generator
 * builds an office for.
 *
 * Leads are agents whose dispatches have durable children in agentStates
 * (childAgentsOf attribution); leads-with-children become departments. The
 * orchestrator itself never appears in agentStates — the office always gets a
 * synthetic manager, so no roster entry exists for it here.
 *
 * Everything is sorted by agent name so the derived roster (and therefore the
 * generated office) is independent of agent-state arrival order.
 */
import type { AgentStateUpdate } from '../../../shared/types'
import {
  childAgentsOf,
  getAgentColor,
  getDispatches,
  isRootLevelAgent,
  meta,
} from '../../lib/agent-helpers'
import type { Roster, RosterAgent } from './types'

function toRosterAgent(agent: AgentStateUpdate, role: RosterAgent['role']): RosterAgent {
  return {
    name: agent.name,
    displayName: meta<string>(agent, 'displayName', agent.name),
    role,
    // `atv-color` frontmatter overrides the derived agent color.
    color: meta<string>(agent, 'atv-color', '') || getAgentColor(agent),
    characterId: meta<string>(agent, 'atv-character', '') || null,
    // Named wing: explicit atv-wing wins; the executive seat implies the
    // 'executive' wing so existing frontmatter keeps working.
    wing: meta<string>(agent, 'atv-wing', '') || (meta<string>(agent, 'atv-seat', '') === 'executive' ? 'executive' : undefined),
  }
}

/** `atv-office` grouping id (frontmatter); empty = group by parentAgent. */
function atvOffice(agent: AgentStateUpdate): string {
  return meta<string>(agent, 'atv-office', '')
}

function byName(a: RosterAgent, b: RosterAgent): number {
  return a.name.localeCompare(b.name)
}

/**
 * Derive the office roster from an agent-state snapshot.
 *
 * Duplicate names collapse to one entry (one character per agent name — a
 * re-dispatched agent is the same person returning to their desk).
 *
 * Department grouping prefers DURABLE org metadata: roster rows that carry
 * `parentAgent` (the parent agent's name) group under that parent without
 * any dispatch having happened — so a full staff roster gets its full office
 * (a dedicated desk per known agent) at session start. Dispatch attribution
 * (dispatchParentId walking) remains the fallback for rosters without org
 * metadata.
 */
export function deriveRoster(agents: AgentStateUpdate[]): Roster {
  // Dedupe by name; the LAST entry wins (latest dispatch attribution).
  const byNameMap = new Map<string, AgentStateUpdate>()
  for (const agent of agents) byNameMap.set(agent.name, agent)
  // `atv-visible: never` removes an agent from the office entirely — the
  // operator's override on top of whatever the harness publishes. ('always'
  // is a harness contract: publish the agent even while idle.)
  for (const [name, a] of byNameMap) {
    if (meta<string>(a, 'atv-visible', '') === 'never') byNameMap.delete(name)
  }
  const unique = [...byNameMap.values()]

  // ── Org-metadata grouping (primary) ──
  // Grouping key cascade per agent: explicit `atv-office` id, then
  // `parentAgent`. Agents sharing an atv-office id share a department room
  // (the lead = the office's parent agent, or the first member by name).
  const childrenByParent = new Map<string, AgentStateUpdate[]>()
  const officeGroups = new Map<string, AgentStateUpdate[]>()
  for (const agent of unique) {
    const office = atvOffice(agent)
    if (office) {
      const list = officeGroups.get(office) ?? []
      list.push(agent)
      officeGroups.set(office, list)
      continue
    }
    const parent = meta<string>(agent, 'parentAgent', '')
    if (!parent || !byNameMap.has(parent)) continue
    const list = childrenByParent.get(parent) ?? []
    list.push(agent)
    childrenByParent.set(parent, list)
  }
  if (childrenByParent.size > 0 || officeGroups.size > 0) {
    const departments: Roster['departments'] = []
    const executives: RosterAgent[] = []
    const claimed = new Set<string>()

    // Explicit atv-office rooms first: lead = the member that is a parent
    // (org metadata), else the first by name.
    for (const officeId of [...officeGroups.keys()].sort()) {
      const members = officeGroups.get(officeId)!.sort((a, b) => a.name.localeCompare(b.name))
      const lead =
        members.find((m) => members.some((o) => meta<string>(o, 'parentAgent', '') === m.name)) ?? members[0]
      claimed.add(lead.name)
      const specialists = members.filter((m) => m.name !== lead.name)
      for (const s of specialists) claimed.add(s.name)
      departments.push({
        lead: toRosterAgent(lead, 'lead'),
        specialists: specialists.map((m) => toRosterAgent(m, 'specialist')).sort(byName),
      })
    }

    for (const parentName of [...childrenByParent.keys()].sort()) {
      if (claimed.has(parentName)) continue
      const lead = byNameMap.get(parentName)!
      const directs = childrenByParent.get(parentName) ?? []
      // Executive membership: `atv-seat: executive` frontmatter is the
      // explicit source of truth — top-level rank alone does not qualify.
      // Structural detection (every direct report is itself a parent, i.e. a
      // chief over leads) remains the fallback for rosters without the
      // frontmatter. An agent explicitly seated OUTSIDE the wing
      // (`atv-seat: private-office`) never lands there, even as a chief.
      const seat = meta<string>(lead, 'atv-seat', '')
      const allDirectsAreParents =
        directs.length > 0 && directs.every((d) => childrenByParent.has(d.name) || atvOffice(d) !== '')
      const isExecutive = seat === 'executive' || (seat !== 'private-office' && allDirectsAreParents)
      claimed.add(parentName)
      // Department members: direct IC reports; reports that are themselves
      // parents head their OWN department rooms.
      const members: AgentStateUpdate[] = []
      for (const member of directs) {
        if (claimed.has(member.name) || childrenByParent.has(member.name)) continue
        claimed.add(member.name)
        members.push(member)
      }
      if (isExecutive) {
        // The executive seat OVERRIDES the corner office: the lead's desk is
        // its wing office. Its IC team (when it has one) still gets a
        // department room — just without the corner pocket.
        executives.push(toRosterAgent(lead, 'lead'))
        if (members.length > 0) {
          departments.push({
            lead: toRosterAgent(lead, 'lead'),
            specialists: members.map((m) => toRosterAgent(m, 'specialist')).sort(byName),
            leadInWing: true,
          })
        }
        continue
      }
      departments.push({
        lead: toRosterAgent(lead, 'lead'),
        specialists: members.map((m) => toRosterAgent(m, 'specialist')).sort(byName),
      })
    }
    // Teamless top-level agents: explicit `atv-seat: executive` joins the
    // wing; everyone else gets a staff office on a normal hallway.
    const solo: RosterAgent[] = []
    for (const a of unique) {
      if (claimed.has(a.name)) continue
      if (meta<string>(a, 'atv-seat', '') === 'executive') executives.push(toRosterAgent(a, 'lead'))
      else solo.push(toRosterAgent(a, 'specialist'))
    }
    solo.sort(byName)
    departments.sort((a, b) => a.lead.name.localeCompare(b.lead.name))
    executives.sort(byName)
    return { departments, executives, solo }
  }

  // ── Dispatch-attribution grouping (fallback) ──
  const roots = unique.filter(isRootLevelAgent)
  const departments: Roster['departments'] = []
  const solo: RosterAgent[] = []
  const claimed = new Set<string>()

  for (const root of [...roots].sort((a, b) => a.name.localeCompare(b.name))) {
    // Children across ALL of this root's dispatches, plus their descendants —
    // a lead's whole subtree works in the lead's department room.
    const children: AgentStateUpdate[] = []
    const queue = getDispatches(root).map((d) => d.id)
    const seenDispatch = new Set<string>()
    while (queue.length > 0) {
      const dispatchId = queue.shift()!
      if (!dispatchId || seenDispatch.has(dispatchId)) continue
      seenDispatch.add(dispatchId)
      for (const child of childAgentsOf(unique, dispatchId)) {
        if (child.name === root.name || claimed.has(child.name)) continue
        claimed.add(child.name)
        children.push(child)
        for (const d of getDispatches(child)) queue.push(d.id)
      }
    }
    if (children.length > 0) {
      departments.push({
        lead: toRosterAgent(root, 'lead'),
        specialists: children.map((c) => toRosterAgent(c, 'specialist')).sort(byName),
      })
    } else {
      solo.push(toRosterAgent(root, 'specialist'))
    }
  }

  // Non-root agents whose parent chain didn't resolve to any known root
  // (attribution missed, parent gone from the snapshot): seat them as solo
  // rather than dropping them from the office.
  for (const agent of unique) {
    if (isRootLevelAgent(agent) || claimed.has(agent.name)) continue
    solo.push(toRosterAgent(agent, 'specialist'))
    claimed.add(agent.name)
  }

  solo.sort(byName)
  departments.sort((a, b) => a.lead.name.localeCompare(b.lead.name))
  return { departments, executives: [], solo }
}

/** Every agent in the roster, sorted by name (seating/casting order). */
export function allRosterAgents(roster: Roster): RosterAgent[] {
  const out: RosterAgent[] = []
  for (const dept of roster.departments) out.push(dept.lead, ...dept.specialists)
  out.push(...roster.executives, ...roster.solo)
  return out.sort(byName)
}
