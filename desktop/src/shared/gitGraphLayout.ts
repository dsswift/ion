import type { GitCommit } from './types'

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

export const DEFAULT_LANE_COLORS = [
  '#d97757', '#7aac8c', '#6b9bd2', '#c47060',
  '#b08fd8', '#d4a843', '#5bbfbf', '#d97ba3',
]

/** Stable hash → palette index. Used so a branch name always picks the same color. */
function hashIndex(s: string, palette: string[]): number {
  let h = 0
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0
  return Math.abs(h) % palette.length
}

export function computeGraphLayout(
  commits: GitCommit[],
  options: { palette?: string[] } = {},
): GitGraphNode[] {
  if (commits.length === 0) return []
  const palette = options.palette ?? DEFAULT_LANE_COLORS

  const activeLanes: (string | null)[] = []
  const hashToLane = new Map<string, number>()
  /** Stable color per lane, decided on first commit that occupies it. */
  const laneColor = new Map<number, string>()
  /** Color decided per branch ref name, so the same branch keeps its color across refreshes. */
  const refColor = new Map<string, string>()
  const result: GitGraphNode[] = []

  function findFreeLane(): number {
    for (let i = 0; i < activeLanes.length; i++) {
      if (activeLanes[i] === null && !laneColor.has(i)) return i
    }
    for (let i = 0; i < activeLanes.length; i++) {
      if (activeLanes[i] === null) return i
    }
    activeLanes.push(null)
    return activeLanes.length - 1
  }

  function colorForLane(lane: number, commit: GitCommit | null): string {
    const existing = laneColor.get(lane)
    if (existing) return existing
    let color: string | undefined
    if (commit) {
      // Prefer a stable color from any local branch/HEAD ref the commit carries.
      const branchRef = commit.refs?.find((r) => r.type === 'head' && r.name !== 'HEAD' && r.name !== 'origin/HEAD')
      if (branchRef) {
        color = refColor.get(branchRef.name) ?? palette[hashIndex(branchRef.name, palette)]
        refColor.set(branchRef.name, color)
      }
    }
    if (!color) color = palette[lane % palette.length]
    laneColor.set(lane, color)
    return color
  }

  for (const commit of commits) {
    const connections: GitGraphConnection[] = []
    let lane: number
    const hasIncoming = hashToLane.has(commit.fullHash)
    if (hasIncoming) {
      lane = hashToLane.get(commit.fullHash)!
      hashToLane.delete(commit.fullHash)
    } else {
      lane = findFreeLane()
    }

    activeLanes[lane] = null
    const color = colorForLane(lane, commit)

    const passThroughLanes: { lane: number; color: string }[] = []
    for (let i = 0; i < activeLanes.length; i++) {
      if (activeLanes[i] !== null && i !== lane) {
        passThroughLanes.push({ lane: i, color: colorForLane(i, null) })
      }
    }

    for (let i = 0; i < commit.parents.length; i++) {
      const parentHash = commit.parents[i]
      if (hashToLane.has(parentHash)) {
        const parentLane = hashToLane.get(parentHash)!
        connections.push({ fromLane: lane, toLane: parentLane, type: 'merge', color: colorForLane(parentLane, null) })
      } else if (i === 0) {
        activeLanes[lane] = parentHash
        hashToLane.set(parentHash, lane)
        connections.push({ fromLane: lane, toLane: lane, type: 'straight', color })
      } else {
        const newLane = findFreeLane()
        activeLanes[newLane] = parentHash
        hashToLane.set(parentHash, newLane)
        connections.push({ fromLane: lane, toLane: newLane, type: 'fork', color: colorForLane(newLane, null) })
      }
    }

    result.push({ commit, lane, color, connections, hasIncoming, passThroughLanes })
  }

  return result
}
