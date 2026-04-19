package agentdiscovery

import (
	"os"

	"github.com/dsswift/ion/engine/internal/utils"
)

// Discover walks directories, parses agent files, and builds the graph.
func Discover(opts WalkOptions) (*AgentGraph, error) {
	paths, err := WalkAgentFiles(opts)
	if err != nil {
		return nil, err
	}

	var agents []*AgentDef
	for _, p := range paths {
		def, err := LoadAgent(p)
		if err != nil {
			utils.Log("AgentDiscovery", "skip "+p+": "+err.Error())
			continue
		}
		agents = append(agents, def)
	}

	return BuildGraph(agents)
}

// LoadAgent parses a single agent definition file.
func LoadAgent(path string) (*AgentDef, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	return parseFrontmatter(path, string(data))
}
