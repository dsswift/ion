package extcontext

import (
	"os"
	"path/filepath"
	"strings"

	"github.com/dsswift/ion/engine/internal/agentdiscovery"
	"github.com/dsswift/ion/engine/internal/extension"
)

// BuildDiscoverAgentsFunc returns the DiscoverAgents closure that walks
// conventional directories for .md agent definitions with configurable
// layer precedence.
func BuildDiscoverAgentsFunc(sa SessionAccessor) func(extension.DiscoverAgentsOpts) (*extension.DiscoverAgentsResult, error) {
	return func(opts extension.DiscoverAgentsOpts) (*extension.DiscoverAgentsResult, error) {
		sources := opts.Sources
		if len(sources) == 0 {
			sources = []string{"extension", "user", "project"}
		}

		// Build ordered directory list. Later dirs override earlier (reverse of
		// WalkOptions where first-seen wins). We reverse the source order before
		// passing to WalkAgentFiles so that later sources in the harness
		// engineer's list take precedence.
		var dirs []string
		sourceMap := make(map[string]string) // dir -> source label

		home, _ := os.UserHomeDir() //nolint:errcheck // empty home handled by caller

		// Collect extension directories from all hosts in the group.
		// Each host knows its own ExtensionDir from Load(); the session-wide
		// ExtConfig() omits it because a session can have multiple extensions.
		var extDirs []string
		if eg := sa.ExtGroup(); eg != nil {
			for _, host := range eg.Hosts() {
				if d := host.ExtensionDir(); d != "" {
					extDirs = append(extDirs, d)
				}
			}
		}

		cwd := sa.WorkingDirectory()

		for _, src := range sources {
			var dir string
			switch src {
			case "extension":
				for _, ed := range extDirs {
					d := filepath.Join(ed, "agents")
					if opts.BundleName != "" {
						d = filepath.Join(d, opts.BundleName)
					}
					dirs = append(dirs, d)
					sourceMap[d] = src
				}
				continue
			case "user":
				if home != "" {
					dir = filepath.Join(home, ".ion", "agents")
				}
			case "project":
				if cwd != "" {
					dir = filepath.Join(cwd, ".ion", "agents")
				}
			default:
				continue
			}
			if dir != "" {
				if opts.BundleName != "" {
					dir = filepath.Join(dir, opts.BundleName)
				}
				dirs = append(dirs, dir)
				sourceMap[dir] = src
			}
		}

		// Add extra dirs.
		for _, d := range opts.ExtraDirs {
			dirs = append(dirs, d)
			sourceMap[d] = "extra"
		}

		// Reverse dirs so last source wins dedup (WalkAgentFiles uses first-seen-wins).
		for i, j := 0, len(dirs)-1; i < j; i, j = i+1, j-1 {
			dirs[i], dirs[j] = dirs[j], dirs[i]
		}

		recursive := true
		if opts.Recursive != nil {
			recursive = *opts.Recursive
		}

		walkOpts := agentdiscovery.WalkOptions{
			ExtraDirs: dirs,
			Recursive: recursive,
		}

		graph, err := agentdiscovery.Discover(walkOpts)
		if err != nil {
			return nil, err
		}

		var result []extension.DiscoveredAgent
		for _, def := range graph.Agents {
			// Determine source from path.
			source := "unknown"
			for dir, label := range sourceMap {
				if strings.HasPrefix(def.Path, dir) {
					source = label
					break
				}
			}
			result = append(result, extension.DiscoveredAgent{
				Name:         def.Name,
				Path:         def.Path,
				Source:       source,
				Parent:       def.Parent,
				Description:  def.Description,
				Model:        def.Model,
				Tools:        def.Tools,
				SystemPrompt: def.SystemPrompt,
				Meta:         def.Meta,
			})
		}
		return &extension.DiscoverAgentsResult{Agents: result}, nil
	}
}
