import type { GitCommit } from '../../shared/types'

export interface GitGraphNode {
  commit: GitCommit
  lane: number
  color: string
  connections: GitGraphConnection[]
  /** Whether this commit has an incoming connection from a previous row */
  hasIncoming: boolean
  /** Lanes that pass through this row without stopping (other active branches) */
  passThroughLanes: { lane: number; color: string }[]
}

export interface GitGraphConnection {
  fromLane: number
  toLane: number
  type: 'straight' | 'merge' | 'fork'
  color: string
}

const LANE_COLORS = [
  '#d97757', '#7aac8c', '#6b9bd2', '#c47060',
  '#b08fd8', '#d4a843', '#5bbfbf', '#d97ba3',
]

export function computeGraphLayout(commits: GitCommit[]): GitGraphNode[] {
  if (commits.length === 0) return []

  // activeLanes[i] = hash that lane i is tracking toward
  const activeLanes: (string | null)[] = []
  // Map hash -> assigned lane
  const hashToLane = new Map<string, number>()
  const result: GitGraphNode[] = []

  function findFreeLane(): number {
    for (let i = 0; i < activeLanes.length; i++) {
      if (activeLanes[i] === null) return i
    }
    activeLanes.push(null)
    return activeLanes.length - 1
  }

  function laneColor(lane: number): string {
    return LANE_COLORS[lane % LANE_COLORS.length]
  }

  for (const commit of commits) {
    const connections: GitGraphConnection[] = []

    // Determine which lane this commit occupies
    // Use fullHash for lane tracking since parent hashes (%P) are full hashes
    let lane: number
    const hasIncoming = hashToLane.has(commit.fullHash)
    if (hasIncoming) {
      lane = hashToLane.get(commit.fullHash)!
      hashToLane.delete(commit.fullHash)
    } else {
      lane = findFreeLane()
    }

    activeLanes[lane] = null // commit consumed this lane
    const color = laneColor(lane)

    // Collect pass-through lanes BEFORE processing parents, so newly forked
    // lanes don't get a stray vertical line above the fork point
    const passThroughLanes: { lane: number; color: string }[] = []
    for (let i = 0; i < activeLanes.length; i++) {
      if (activeLanes[i] !== null && i !== lane) {
        passThroughLanes.push({ lane: i, color: laneColor(i) })
      }
    }

    // Process parents
    for (let i = 0; i < commit.parents.length; i++) {
      const parentHash = commit.parents[i]

      if (hashToLane.has(parentHash)) {
        // Parent already has a lane assigned (merge)
        const parentLane = hashToLane.get(parentHash)!
        connections.push({
          fromLane: lane,
          toLane: parentLane,
          type: 'merge',
          color: laneColor(parentLane),
        })
      } else if (i === 0) {
        // First parent: continues in the same lane
        activeLanes[lane] = parentHash
        hashToLane.set(parentHash, lane)
        connections.push({
          fromLane: lane,
          toLane: lane,
          type: 'straight',
          color,
        })
      } else {
        // Additional parents: fork to a new lane
        const newLane = findFreeLane()
        activeLanes[newLane] = parentHash
        hashToLane.set(parentHash, newLane)
        connections.push({
          fromLane: lane,
          toLane: newLane,
          type: 'fork',
          color: laneColor(newLane),
        })
      }
    }

    result.push({ commit, lane, color, connections, hasIncoming, passThroughLanes })
  }

  return result
}
