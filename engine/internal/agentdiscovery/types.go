package agentdiscovery

// AgentDef represents a parsed agent definition file.
type AgentDef struct {
	Name         string            // filename stem
	Path         string            // absolute path to .md file
	Parent       string            // parent agent name (empty = root)
	Description  string            // one-line description
	Model        string            // model override
	Tools        []string          // allowed tools
	SystemPrompt string            // body after frontmatter
	Meta         map[string]string // extra frontmatter fields
}

// AgentGraph is the result of discovery: all agents plus their relationships.
type AgentGraph struct {
	Agents   map[string]*AgentDef // name -> def
	Children map[string][]string  // parent name -> child names
	Roots    []string             // agents with no parent (sorted)
}

// WalkOptions controls which directories are scanned for agent files.
type WalkOptions struct {
	IncludeUserDir    bool     // ~/.ion/agents/
	IncludeProjectDir bool     // .ion/agents/ relative to working dir
	ExtraDirs         []string // additional directories to scan
	Recursive         bool     // walk subdirectories (default true when zero value)
}
