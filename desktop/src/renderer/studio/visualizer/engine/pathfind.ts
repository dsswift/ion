/**
 * BFS pathfinding on the office walkability grid. Paths are 4-directional
 * tile sequences (start excluded, target included). Small grids (≤64x64) and
 * infrequent path requests make BFS with a per-layout cache the right tool —
 * no heuristics to tune, always shortest.
 */
import type { OfficeLayout, Point } from '../generation/types'

export class Pathfinder {
  private cache = new Map<string, Point[] | null>()

  constructor(
    private layout: OfficeLayout,
    private walkable: readonly boolean[],
  ) {}

  isWalkable(x: number, y: number): boolean {
    if (x < 0 || y < 0 || x >= this.layout.width || y >= this.layout.height) return false
    return this.walkable[y * this.layout.width + x]
  }

  /** Shortest path from start to target, or null when unreachable. */
  find(start: Point, target: Point): Point[] | null {
    const key = `${start.x},${start.y}>${target.x},${target.y}`
    const cached = this.cache.get(key)
    if (cached !== undefined) return cached ? cached.map((p) => ({ ...p })) : null
    const path = this.bfs(start, target)
    this.cache.set(key, path)
    return path ? path.map((p) => ({ ...p })) : null
  }

  private bfs(start: Point, target: Point): Point[] | null {
    const w = this.layout.width
    const h = this.layout.height
    if (!this.isWalkable(target.x, target.y) || !this.isWalkable(start.x, start.y)) return null
    if (start.x === target.x && start.y === target.y) return []
    const prev = new Int32Array(w * h).fill(-1)
    const visited = new Uint8Array(w * h)
    const queue: number[] = [start.y * w + start.x]
    visited[start.y * w + start.x] = 1
    const targetIdx = target.y * w + target.x
    while (queue.length > 0) {
      const idx = queue.shift()!
      if (idx === targetIdx) break
      const x = idx % w
      const y = (idx - x) / w
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
        const nx = x + dx
        const ny = y + dy
        if (!this.isWalkable(nx, ny)) continue
        const ni = ny * w + nx
        if (visited[ni]) continue
        visited[ni] = 1
        prev[ni] = idx
        queue.push(ni)
      }
    }
    if (!visited[targetIdx]) return null
    const path: Point[] = []
    let cur = targetIdx
    while (cur !== start.y * w + start.x) {
      path.unshift({ x: cur % w, y: Math.floor(cur / w) })
      cur = prev[cur]
      if (cur < 0) return null
    }
    return path
  }
}
