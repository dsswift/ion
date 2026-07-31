package config

// mcp_servers.go — resolution and CRUD for the mcpServers config map.
//
// Two distinct jobs live here:
//
//   - ResolveMcpServers reads the merged, enterprise-enforced server map fresh
//     at call time. Session start uses it so a server added mid-daemon-life
//     applies to the next session without a daemon restart.
//   - AddMcpServer / RemoveMcpServer edit ~/.ion/engine.json in place. They
//     operate on the raw decoded map rather than a typed struct so that every
//     key the engine does not know about — a newer field, an operator comment
//     convention, anything a future version adds — survives the write.
//     Round-tripping through EngineRuntimeConfig would silently drop them.

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

// ResolveMcpServers reads the MCP server map FRESH from engine.json at call
// time, running the full layered merge (defaults < global < project) and
// enterprise enforcement, but with NO process-global side effects (no
// log-level change, no ConfigureLogging, no provider-backend validation). It is
// safe to call on every session start.
//
// Resolving fresh here (rather than reading the boot-cached config) is what
// makes `ion mcp add` take effect without restarting the daemon: the engine is
// a long-lived launchd process, and a boot-time snapshot would mean every
// server addition required a restart that kills live conversations.
//
// The returned map is already enterprise-enforced — denylisted and
// non-allowlisted servers are pruned by EnforceEnterprise during the merge — so
// callers connect exactly what policy permits.
//
// projectDir is the session's working directory; passing "" resolves
// global-only (the headless default when no project is in scope).
func ResolveMcpServers(projectDir string) map[string]types.McpServerConfig {
	merged := mergeConfigLayers(projectDir)
	servers := merged.McpServers
	names := make([]string, 0, len(servers))
	for name := range servers {
		names = append(names, name)
	}
	utils.LogWithFields(utils.LevelDebug, "config", "resolved mcp servers fresh", map[string]any{
		"project_dir": projectDir,
		"count":       len(servers),
		"servers":     names,
	})
	return servers
}

// McpServerNameError distinguishes a rejected server name from an I/O failure
// so callers can surface the operator's mistake differently from a disk error.
type McpServerNameError struct {
	Name   string
	Reason string
}

func (e *McpServerNameError) Error() string {
	return fmt.Sprintf("invalid MCP server name %q: %s", e.Name, e.Reason)
}

// validateMcpServerName rejects names that would corrupt the config or collide
// with the tool-name prefixing scheme.
//
// MCP tool names reach the LLM as "<server>__<tool>" (see the tool-registration
// path), so a name containing the separator or whitespace produces tool names a
// model cannot reliably call back. An empty name would write a `""` key that no
// CLI or UI can address.
func validateMcpServerName(name string) error {
	switch {
	case strings.TrimSpace(name) == "":
		return &McpServerNameError{Name: name, Reason: "name is empty"}
	case name != strings.TrimSpace(name):
		return &McpServerNameError{Name: name, Reason: "name has leading or trailing whitespace"}
	case strings.ContainsAny(name, " \t\n"):
		return &McpServerNameError{Name: name, Reason: "name contains whitespace"}
	case strings.Contains(name, "__"):
		return &McpServerNameError{Name: name, Reason: `name contains "__", which is the MCP tool-name separator`}
	}
	return nil
}

// CheckMcpServerAllowed reports whether enterprise policy permits a server
// under the given name and config.
//
// This runs BEFORE the write, mirroring the denylist/allowlist logic
// EnforceEnterprise applies during the merge (including the URL-host glob that
// closes the rename bypass). Without this pre-check, an add would succeed, be
// written to disk, and then be silently pruned at the next session start —
// leaving the operator with a config entry that never connects and no
// explanation. Refusing up front is the honest answer.
func CheckMcpServerAllowed(name string, cfg types.McpServerConfig) error {
	enterprise := LoadEnterpriseConfig()
	if enterprise == nil {
		return nil
	}

	if contains(enterprise.McpDenylist, name) {
		utils.LogWithFields(utils.LevelWarn, "config", "mcp server add refused by enterprise denylist", map[string]any{
			"server": name,
		})
		return fmt.Errorf("MCP server %q is blocked by enterprise policy (mcpDenylist)", name)
	}

	if len(enterprise.McpAllowlist) > 0 {
		if contains(enterprise.McpAllowlist, name) {
			return nil
		}
		if host := mcpServerURLHost(cfg); host != "" && matchesAny(enterprise.McpAllowlist, host) {
			utils.LogWithFields(utils.LevelInfo, "config", "mcp server add allowed by enterprise URL host pattern", map[string]any{
				"server": name, "host": host,
			})
			return nil
		}
		utils.LogWithFields(utils.LevelWarn, "config", "mcp server add refused by enterprise allowlist", map[string]any{
			"server": name, "host": mcpServerURLHost(cfg), "allowlist": enterprise.McpAllowlist,
		})
		return fmt.Errorf("MCP server %q is not permitted by enterprise policy (mcpAllowlist)", name)
	}

	return nil
}

// AddMcpServer writes a server entry into ~/.ion/engine.json, replacing any
// entry already stored under the same name.
//
// Only the mcpServers key is touched. Every other top-level key, and every
// unrecognized key inside it, is preserved byte-for-byte through the raw-map
// round trip.
func AddMcpServer(name string, cfg types.McpServerConfig) error {
	if err := validateMcpServerName(name); err != nil {
		return err
	}
	if err := CheckMcpServerAllowed(name, cfg); err != nil {
		return err
	}

	path := globalConfigPath()
	raw, err := readRawConfig(path)
	if err != nil {
		return err
	}

	// Marshal through the typed struct so omitempty applies: an entry written
	// from a partially-filled struct must not carry a dozen empty keys the
	// operator did not ask for.
	encoded, err := json.Marshal(cfg)
	if err != nil {
		return fmt.Errorf("encode MCP server %q: %w", name, err)
	}
	var entry map[string]any
	if err := json.Unmarshal(encoded, &entry); err != nil {
		return fmt.Errorf("re-decode MCP server %q: %w", name, err)
	}

	servers, _ := raw["mcpServers"].(map[string]any) //nolint:errcheck // a non-map value is replaced below
	if servers == nil {
		if existing, present := raw["mcpServers"]; present {
			// A non-object mcpServers (an array, a string, null) cannot be
			// merged into. Replacing it silently would discard operator data,
			// so refuse and name the file to fix.
			return fmt.Errorf("mcpServers in %s is %T, not an object; fix it before adding a server", path, existing)
		}
		servers = make(map[string]any)
	}
	_, replaced := servers[name]
	servers[name] = entry
	raw["mcpServers"] = servers

	if err := writeRawConfig(path, raw); err != nil {
		return err
	}

	utils.LogWithFields(utils.LevelInfo, "config", "mcp server written to engine.json", map[string]any{
		"server": name, "path": path, "transport": cfg.Type, "url": cfg.URL,
		"command": cfg.Command, "replaced": replaced, "total": len(servers),
	})
	return nil
}

// RemoveMcpServer deletes a server entry from ~/.ion/engine.json. Removing a
// name that is not present is an error rather than a silent success: a
// consumer that mistyped a name must hear about it instead of being told the
// removal worked.
func RemoveMcpServer(name string) error {
	path := globalConfigPath()
	raw, err := readRawConfig(path)
	if err != nil {
		return err
	}

	servers, _ := raw["mcpServers"].(map[string]any) //nolint:errcheck // missing/!map handled as "not configured"
	if servers == nil {
		return fmt.Errorf("no MCP servers are configured in %s", path)
	}
	if _, ok := servers[name]; !ok {
		return fmt.Errorf("MCP server %q is not configured in %s", name, path)
	}
	delete(servers, name)
	raw["mcpServers"] = servers

	if err := writeRawConfig(path, raw); err != nil {
		return err
	}

	utils.LogWithFields(utils.LevelInfo, "config", "mcp server removed from engine.json", map[string]any{
		"server": name, "path": path, "remaining": len(servers),
	})
	return nil
}

// readRawConfig decodes engine.json into a raw map, preserving every key.
// A missing file yields an empty map so the first `ion mcp add` on a fresh
// install works. A malformed file is an error: overwriting it would destroy
// whatever the operator was mid-way through editing.
func readRawConfig(path string) (map[string]any, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			utils.LogWithFields(utils.LevelInfo, "config", "engine.json does not exist; creating it", map[string]any{"path": path})
			return make(map[string]any), nil
		}
		return nil, fmt.Errorf("read %s: %w", path, err)
	}
	if len(strings.TrimSpace(string(data))) == 0 {
		return make(map[string]any), nil
	}
	var raw map[string]any
	if err := json.Unmarshal(data, &raw); err != nil {
		return nil, fmt.Errorf("%s is not valid JSON (%w); fix it by hand before editing MCP servers", path, err)
	}
	if raw == nil {
		return make(map[string]any), nil
	}
	return raw, nil
}

// writeRawConfig serializes the raw config map and writes it atomically.
//
// Atomicity matters: engine.json holds provider credentials and enterprise
// state, and a partial write from an interrupted process would leave the
// daemon unable to start. Temp + fsync + rename + parent-dir fsync is the same
// sequence conversation persistence uses for the same reason.
func writeRawConfig(path string, raw map[string]any) error {
	data, err := json.MarshalIndent(raw, "", "  ")
	if err != nil {
		return fmt.Errorf("encode %s: %w", path, err)
	}
	data = append(data, '\n')

	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return fmt.Errorf("create %s: %w", dir, err)
	}

	tmp := path + ".tmp"
	f, err := os.OpenFile(tmp, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0o600)
	if err != nil {
		return fmt.Errorf("open %s: %w", tmp, err)
	}
	if _, err := f.Write(data); err != nil {
		f.Close()      //nolint:errcheck // close after write error; the write error is returned
		os.Remove(tmp) //nolint:errcheck // temp cleanup
		return fmt.Errorf("write %s: %w", tmp, err)
	}
	if err := f.Sync(); err != nil {
		f.Close()      //nolint:errcheck // close after sync error; the sync error is returned
		os.Remove(tmp) //nolint:errcheck // temp cleanup
		return fmt.Errorf("sync %s: %w", tmp, err)
	}
	if err := f.Close(); err != nil {
		os.Remove(tmp) //nolint:errcheck // temp cleanup
		return fmt.Errorf("close %s: %w", tmp, err)
	}
	if err := os.Rename(tmp, path); err != nil {
		os.Remove(tmp) //nolint:errcheck // temp cleanup
		return fmt.Errorf("rename %s to %s: %w", tmp, path, err)
	}
	if dirHandle, err := os.Open(dir); err == nil {
		dirHandle.Sync()  //nolint:errcheck // best-effort directory fsync
		dirHandle.Close() //nolint:errcheck // directory handle close
	} else {
		utils.LogWithFields(utils.LevelInfo, "config", "parent directory fsync skipped", map[string]any{"dir": dir, "error": err.Error()})
	}
	return nil
}
