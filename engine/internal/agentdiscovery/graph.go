package agentdiscovery

import (
	"fmt"
	"sort"
	"strings"
)

// BuildGraph constructs parent-children adjacency from agent defs.
// Detects cycles via DFS coloring. Returns error on cycle.
// Agents referencing unknown parents become roots with a warning in Meta.
func BuildGraph(agents []*AgentDef) (*AgentGraph, error) {
	g := &AgentGraph{
		Agents:   make(map[string]*AgentDef, len(agents)),
		Children: make(map[string][]string),
	}

	for _, a := range agents {
		g.Agents[a.Name] = a
	}

	// Build adjacency
	for _, a := range agents {
		if a.Parent == "" {
			continue
		}
		if _, exists := g.Agents[a.Parent]; !exists {
			// Parent not found -- treat as root, mark warning
			a.Meta["_warning"] = fmt.Sprintf("parent %q not found in discovery", a.Parent)
			a.Parent = ""
			continue
		}
		g.Children[a.Parent] = append(g.Children[a.Parent], a.Name)
	}

	// Sort children for deterministic output
	for k := range g.Children {
		sort.Strings(g.Children[k])
	}

	// Cycle detection via DFS coloring
	if err := detectCycles(g); err != nil {
		return nil, err
	}

	// Collect roots
	for _, a := range agents {
		if a.Parent == "" {
			g.Roots = append(g.Roots, a.Name)
		}
	}
	sort.Strings(g.Roots)

	return g, nil
}

const (
	white = 0 // unvisited
	gray  = 1 // in current path
	black = 2 // fully explored
)

func detectCycles(g *AgentGraph) error {
	color := make(map[string]int, len(g.Agents))
	var path []string

	var dfs func(name string) error
	dfs = func(name string) error {
		color[name] = gray
		path = append(path, name)
		for _, child := range g.Children[name] {
			switch color[child] {
			case gray:
				// Found cycle -- extract cycle path
				cycleStart := -1
				for i, n := range path {
					if n == child {
						cycleStart = i
						break
					}
				}
				cycle := append(path[cycleStart:], child)
				return fmt.Errorf("cycle detected: %s", strings.Join(cycle, " -> "))
			case white:
				if err := dfs(child); err != nil {
					return err
				}
			}
		}
		path = path[:len(path)-1]
		color[name] = black
		return nil
	}

	for name := range g.Agents {
		if color[name] == white {
			if err := dfs(name); err != nil {
				return err
			}
		}
	}
	return nil
}
