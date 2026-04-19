import React from 'react'
import {
  FileText, PencilSimple, FileArrowUp, Terminal, MagnifyingGlass, Globe,
  Robot, Question, Wrench, FolderOpen,
} from '@phosphor-icons/react'
import { useColors } from '../../theme'

export function ToolIcon({ name, size = 12, status }: { name: string; size?: number; status?: string }) {
  const colors = useColors()
  const ICONS: Record<string, React.ReactNode> = {
    Read: <FileText size={size} />,
    Edit: <PencilSimple size={size} />,
    Write: <FileArrowUp size={size} />,
    Bash: <Terminal size={size} />,
    Glob: <FolderOpen size={size} />,
    Grep: <MagnifyingGlass size={size} />,
    WebSearch: <Globe size={size} />,
    WebFetch: <Globe size={size} />,
    Agent: <Robot size={size} />,
    AskUserQuestion: <Question size={size} />,
  }

  const iconColor = status === 'error' ? colors.statusError
    : status === 'completed' ? colors.statusComplete
    : colors.textTertiary

  return (
    <span className="flex items-center" style={{ color: iconColor }}>
      {ICONS[name] || <Wrench size={size} />}
    </span>
  )
}
