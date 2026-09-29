import { basename } from 'path'

export interface ProcessTreeSnapshot {
  childrenByParent: ReadonlyMap<number, readonly number[]>
  commandByPid: ReadonlyMap<number, string>
}

export interface TerminalProcessTree {
  active: boolean
  processIds: number[]
  processLabel: string | null
}

/** Parse `ps -eo pid=,ppid=,comm=` output into a complete process tree. */
export function parseProcessTree(stdout: string): ProcessTreeSnapshot {
  const childrenByParent = new Map<number, number[]>()
  const commandByPid = new Map<number, string>()
  for (const line of stdout.split(/\r?\n/)) {
    const match = /^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(line)
    if (!match) continue
    const pid = Number(match[1])
    const parentPid = Number(match[2])
    if (!Number.isInteger(pid) || !Number.isInteger(parentPid) || pid <= 0) continue
    commandByPid.set(pid, match[3])
    const children = childrenByParent.get(parentPid) ?? []
    children.push(pid)
    childrenByParent.set(parentPid, children)
  }
  return { childrenByParent, commandByPid }
}

export function terminalProcessTree(snapshot: ProcessTreeSnapshot, terminalPid: number): TerminalProcessTree {
  const directChildren = snapshot.childrenByParent.get(terminalPid) ?? []
  if (directChildren.length === 0) return { active: false, processIds: [], processLabel: null }
  const processIds = new Set<number>([terminalPid])
  const pending = [...directChildren]
  while (pending.length > 0) {
    const pid = pending.pop()
    if (pid === undefined || processIds.has(pid)) continue
    processIds.add(pid)
    for (const childPid of snapshot.childrenByParent.get(pid) ?? []) pending.push(childPid)
  }
  const command = snapshot.commandByPid.get(directChildren[0]) ?? ''
  return {
    active: true,
    processIds: [...processIds],
    processLabel: commandLabel(command),
  }
}

function commandLabel(command: string): string | null {
  const name = basename(command.trim())
  if (!name) return null
  return name.slice(0, 48)
}
