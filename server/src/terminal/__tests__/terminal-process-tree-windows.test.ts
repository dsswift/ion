import { describe, it, expect } from 'vitest'
import { parseCimProcessTree } from '../terminal-process-tree-windows'
import { terminalProcessTree } from '../terminal-process-tree'

describe('parseCimProcessTree', () => {
  it('parses a JSON array (the multi-process case)', () => {
    const json = '[{"ProcessId":100,"ParentProcessId":1,"Name":"pwsh.exe"},{"ProcessId":200,"ParentProcessId":100,"Name":"node.exe"}]'
    const snapshot = parseCimProcessTree(json)
    const tree = terminalProcessTree(snapshot, 100)
    expect(tree.active).toBe(true)
    expect(tree.processIds).toEqual(expect.arrayContaining([100, 200]))
    expect(tree.processLabel).toBe('node.exe')
  })

  it('parses a bare JSON object (ConvertTo-Json emits this for exactly one process)', () => {
    const json = '{"ProcessId":100,"ParentProcessId":1,"Name":"pwsh.exe"}'
    const snapshot = parseCimProcessTree(json)
    expect(snapshot.commandByPid.get(100)).toBe('pwsh.exe')
    expect(snapshot.childrenByParent.get(1)).toEqual([100])
  })

  it('a terminal with no children reports inactive', () => {
    const json = '[{"ProcessId":100,"ParentProcessId":1,"Name":"pwsh.exe"}]'
    const snapshot = parseCimProcessTree(json)
    const tree = terminalProcessTree(snapshot, 100)
    expect(tree.active).toBe(false)
    expect(tree.processIds).toEqual([])
  })

  it('malformed JSON parses to an empty snapshot rather than throwing', () => {
    const snapshot = parseCimProcessTree('not json')
    expect(snapshot.commandByPid.size).toBe(0)
    expect(snapshot.childrenByParent.size).toBe(0)
  })
})
