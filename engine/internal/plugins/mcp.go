package plugins

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

// McpServers returns the MCP servers every installed plugin ships, keyed by
// server name, ready to connect. A plugin whose servers cannot be read is
// logged and skipped; when two plugins name the same server, the first in
// name order keeps it.
func McpServers() map[string]types.McpServerConfig {
	installed, err := ListInstalled()
	if err != nil {
		utils.LogWithFields(utils.LevelWarn, "plugins", "failed to list installed plugins for mcp servers", map[string]any{"error": err.Error()})
		return nil
	}
	sort.Slice(installed, func(i, j int) bool { return installed[i].Name < installed[j].Name })
	out := map[string]types.McpServerConfig{}
	for _, p := range installed {
		servers, err := p.McpServers()
		if err != nil {
			utils.LogWithFields(utils.LevelWarn, "plugins", "skipping plugin mcp servers", map[string]any{"plugin": p.Name, "error": err.Error()})
			continue
		}
		for name, cfg := range servers {
			if _, taken := out[name]; taken {
				utils.LogWithFields(utils.LevelWarn, "plugins", "plugin mcp server name already taken", map[string]any{"plugin": p.Name, "serverName": name})
				continue
			}
			out[name] = cfg
		}
	}
	return out
}

// McpServers reads the plugin's MCP servers the way Claude Code does: the
// .mcp.json at the plugin root, then the manifest's mcpServers field.
// ${CLAUDE_PLUGIN_ROOT} becomes the plugin dir in every value, a server's
// process also gets it as CLAUDE_PLUGIN_ROOT and ION_PLUGIN_ROOT, and a
// server that names no transport is stdio when it has a command and http
// when it has a url.
func (p InstalledPlugin) McpServers() (map[string]types.McpServerConfig, error) {
	servers := map[string]types.McpServerConfig{}
	if data, err := os.ReadFile(filepath.Join(p.InstallPath, ".mcp.json")); err == nil {
		if err := decodeServers(data, servers); err != nil {
			return nil, fmt.Errorf(".mcp.json: %w", err)
		}
	} else if !os.IsNotExist(err) {
		return nil, err
	}

	manifest, err := LoadManifest(p.InstallPath)
	if err != nil {
		return nil, err
	}
	if manifest != nil && len(manifest.McpServers) > 0 {
		var rel string
		if json.Unmarshal(manifest.McpServers, &rel) == nil {
			data, err := os.ReadFile(filepath.Join(p.InstallPath, filepath.FromSlash(rel)))
			if err != nil {
				return nil, err
			}
			if err := decodeServers(data, servers); err != nil {
				return nil, fmt.Errorf("%s: %w", rel, err)
			}
		} else if err := decodeServers(manifest.McpServers, servers); err != nil {
			return nil, fmt.Errorf("plugin.json mcpServers: %w", err)
		}
	}

	for name, cfg := range servers {
		servers[name] = p.expand(cfg)
	}
	return servers, nil
}

// decodeServers reads a map of server configs, bare or under "mcpServers".
func decodeServers(data []byte, into map[string]types.McpServerConfig) error {
	var wrapped struct {
		McpServers map[string]types.McpServerConfig `json:"mcpServers"`
	}
	if err := json.Unmarshal(data, &wrapped); err == nil && wrapped.McpServers != nil {
		for name, cfg := range wrapped.McpServers {
			into[name] = cfg
		}
		return nil
	}
	var bare map[string]types.McpServerConfig
	if err := json.Unmarshal(data, &bare); err != nil {
		return err
	}
	for name, cfg := range bare {
		into[name] = cfg
	}
	return nil
}

func (p InstalledPlugin) expand(cfg types.McpServerConfig) types.McpServerConfig {
	root := func(s string) string { return strings.ReplaceAll(s, "${CLAUDE_PLUGIN_ROOT}", p.InstallPath) }
	cfg.Command = root(cfg.Command)
	cfg.URL = root(cfg.URL)
	args := make([]string, len(cfg.Args))
	for i, a := range cfg.Args {
		args[i] = root(a)
	}
	cfg.Args = args
	env := map[string]string{}
	for k, v := range cfg.Env {
		env[k] = root(v)
	}
	headers := map[string]string{}
	for k, v := range cfg.Headers {
		headers[k] = root(v)
	}
	if len(headers) > 0 {
		cfg.Headers = headers
	}
	if cfg.Type == "" {
		cfg.Type = "stdio"
		if cfg.Command == "" && cfg.URL != "" {
			cfg.Type = "http"
		}
	}
	if cfg.Type == "stdio" {
		env["CLAUDE_PLUGIN_ROOT"] = p.InstallPath
		env["ION_PLUGIN_ROOT"] = p.InstallPath
	}
	if len(env) > 0 {
		cfg.Env = env
	}
	return cfg
}
