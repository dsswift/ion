interface SearchEntry {
  categoryId: string
  label: string
  keywords: string
}

const SEARCH_INDEX: SearchEntry[] = [
  // General
  { categoryId: 'general', label: 'Default Directory', keywords: 'default directory workspace home folder path browse' },
  { categoryId: 'general', label: 'Default Permission Mode', keywords: 'permission mode plan auto approve' },
  { categoryId: 'general', label: 'Bash Command Entry', keywords: 'bash command entry shell terminal exclamation' },
  { categoryId: 'general', label: 'Allow Settings Edits', keywords: 'allow settings edits agent modify ion.md engine.json' },
  { categoryId: 'general', label: 'Claude Compatibility', keywords: 'claude compatibility compat .claude commands skills' },
  { categoryId: 'general', label: 'Notification Sound', keywords: 'notification sound alert audio task complete' },
  { categoryId: 'general', label: 'Show Task List', keywords: 'task list todo checklist show hide' },
  { categoryId: 'general', label: 'AI Tab Titles', keywords: 'ai tab titles generate automatic name' },
  { categoryId: 'general', label: 'Clear Context on Implement', keywords: 'clear context implement plan mode history' },

  // AI & Models
  { categoryId: 'ai', label: 'Default Conversation Model', keywords: 'model conversation default opus sonnet haiku' },
  { categoryId: 'ai', label: 'Default Engine Model', keywords: 'model engine default opus sonnet haiku' },
  { categoryId: 'ai', label: 'Plan & Implement Models', keywords: 'plan implement model split planning opus sonnet switch auto' },
  { categoryId: 'ai', label: 'Backend Mode', keywords: 'backend mode api cli anthropic claude switch restart' },
  { categoryId: 'ai', label: 'Engine Profiles', keywords: 'engine profiles extensions configuration' },

  // Appearance
  { categoryId: 'appearance', label: 'Full Width', keywords: 'full width expanded ui horizontal wide layout' },
  { categoryId: 'appearance', label: 'Ultra Wide', keywords: 'ultra wide monitor external display large' },
  { categoryId: 'appearance', label: 'Default Tall Conversations', keywords: 'tall mode conversation default height' },
  { categoryId: 'appearance', label: 'Default Tall Terminal', keywords: 'tall mode terminal default height' },
  { categoryId: 'appearance', label: 'Default Tall Engine', keywords: 'tall mode engine default height' },
  { categoryId: 'appearance', label: 'Dark Theme', keywords: 'dark theme light mode color appearance' },
  { categoryId: 'appearance', label: 'Tool Output', keywords: 'tool output expand auto results file write edit' },
  { categoryId: 'appearance', label: 'Close Explorer on File Open', keywords: 'close explorer file open automatic hide' },
  { categoryId: 'appearance', label: 'Close Explorer on External Launch', keywords: 'close explorer external finder native app reveal' },
  { categoryId: 'appearance', label: 'Open Markdown in Preview', keywords: 'markdown preview edit mode .md file' },
  { categoryId: 'appearance', label: 'Word Wrap', keywords: 'word wrap editor line long scroll horizontal' },
  { categoryId: 'appearance', label: 'Editor Font Size', keywords: 'editor font size pixels text preview code' },
  { categoryId: 'appearance', label: 'Conversation Font Size', keywords: 'conversation font size pixels text message chat readable larger' },
  { categoryId: 'appearance', label: 'Terminal Font', keywords: 'terminal font family nerd monospace typeface' },
  { categoryId: 'appearance', label: 'Terminal Font Size', keywords: 'terminal font size pixels text' },

  // Tabs & Panels
  { categoryId: 'tabs', label: 'Auto-expand on Switch', keywords: 'expand tab switch automatic conversation' },
  { categoryId: 'tabs', label: 'Tab Groups', keywords: 'tab groups off auto manual directory organize' },
  { categoryId: 'tabs', label: 'Auto-move Tabs by Mode', keywords: 'auto move tabs mode planning progress done group' },
  { categoryId: 'tabs', label: 'Keep Explorer Open', keywords: 'keep explorer open minimize collapse panel' },
  { categoryId: 'tabs', label: 'Keep Console Open', keywords: 'keep console terminal open minimize collapse panel' },
  { categoryId: 'tabs', label: 'Keep Git Panel Open', keywords: 'keep git panel open minimize collapse' },
  { categoryId: 'tabs', label: 'Auto-recover Stuck Tabs', keywords: 'recover stuck tabs idle timeout automatic' },
  { categoryId: 'tabs', label: 'Idle Threshold', keywords: 'idle threshold timeout seconds recovery' },

  // Git
  { categoryId: 'git', label: 'GitOps Mode', keywords: 'gitops mode manual worktree branch isolate' },
  { categoryId: 'git', label: 'Completion Strategy', keywords: 'completion strategy merge pull request pr worktree' },
  { categoryId: 'git', label: 'Skip PR Title Prompt', keywords: 'skip pr title prompt auto generate branch' },
  { categoryId: 'git', label: 'Branch Defaults', keywords: 'branch defaults source directory saved' },
  { categoryId: 'git', label: 'Tree View for Changes', keywords: 'tree view changes git panel directory group files' },
  { categoryId: 'git', label: 'Commit Command', keywords: 'commit command bash terminal custom' },

  // Quick Tools
  { categoryId: 'quicktools', label: 'Quick Tools', keywords: 'quick tools custom button shortcut action icon' },

  // Remote
  { categoryId: 'remote', label: 'Enable Remote Control', keywords: 'remote control enable ios companion app' },
  { categoryId: 'remote', label: 'Paired Devices', keywords: 'paired devices pairing code ios phone' },
  { categoryId: 'remote', label: 'Relay Server', keywords: 'relay server url api key discovery' },
  { categoryId: 'remote', label: 'Disable LAN Server', keywords: 'disable lan server local network relay debug' },

  // Advanced
  { categoryId: 'advanced', label: 'Presets', keywords: 'preset operator developer quick configure apply bundle' },
  { categoryId: 'advanced', label: 'Tab Migration', keywords: 'migration migrate tabs backend api cli convert' },
  { categoryId: 'advanced', label: 'Simulate Update', keywords: 'simulate update developer auto debug test' },
]

export function searchSettings(query: string): Set<string> {
  const q = query.toLowerCase().trim()
  if (!q) return new Set()
  const terms = q.split(/\s+/)
  const matched = new Set<string>()
  for (const entry of SEARCH_INDEX) {
    const haystack = `${entry.label} ${entry.keywords}`.toLowerCase()
    if (terms.every((t) => haystack.includes(t))) {
      matched.add(entry.categoryId)
    }
  }
  return matched
}
