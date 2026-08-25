export interface TerminalWebApplication {
  id: string
  kind: 'web'
  url: string
  port: number
  pid: number | null
  processName: string | null
  source: 'native' | 'container'
}

export interface TerminalActivity {
  key: string
  tabId: string
  instanceId: string
  active: boolean
  processLabel: string | null
  processIds: number[]
  cwd?: string
  applications: TerminalWebApplication[]
}

export function splitTerminalActivityKey(key: string): { tabId: string; instanceId: string } {
  const separator = key.indexOf(':')
  return separator < 0
    ? { tabId: key, instanceId: '' }
    : { tabId: key.slice(0, separator), instanceId: key.slice(separator + 1) }
}
