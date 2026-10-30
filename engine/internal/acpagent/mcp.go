package acpagent

import (
	"sort"

	"github.com/dsswift/ion/engine/internal/types"
)

// mcpServerConfigs turns the servers a client named on session/new or
// session/load into the engine's per-session server map. A stdio server is
// one with a command; a network server names its transport and url. A spec
// with no name, or with neither a command nor a url, is dropped.
func mcpServerConfigs(specs []McpServerSpec) map[string]types.McpServerConfig {
	if len(specs) == 0 {
		return nil
	}
	servers := make(map[string]types.McpServerConfig, len(specs))
	for _, spec := range specs {
		if spec.Name == "" {
			continue
		}
		cfg := types.McpServerConfig{Type: spec.Type}
		switch {
		case spec.Command != "":
			cfg.Type = "stdio"
			cfg.Command = spec.Command
			cfg.Args = spec.Args
			cfg.Env = namedVars(spec.Env)
		case spec.URL != "":
			if cfg.Type == "" {
				cfg.Type = "http"
			}
			cfg.URL = spec.URL
			cfg.Headers = namedVars(spec.Headers)
		default:
			continue
		}
		servers[spec.Name] = cfg
	}
	if len(servers) == 0 {
		return nil
	}
	return servers
}

func namedVars(vars []NamedVar) map[string]string {
	if len(vars) == 0 {
		return nil
	}
	out := make(map[string]string, len(vars))
	for _, v := range vars {
		if v.Name != "" {
			out[v.Name] = v.Value
		}
	}
	return out
}

// mcpServerNames lists a server map's names, sorted, for log lines.
func mcpServerNames(servers map[string]types.McpServerConfig) []string {
	names := make([]string, 0, len(servers))
	for name := range servers {
		names = append(names, name)
	}
	sort.Strings(names)
	return names
}
