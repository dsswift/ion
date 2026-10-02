package config

// mcp_user_store.go — the user's own MCP servers on a managed engine surface.
//
// A managed engine file (managed_projection.go) replaces engine.json, which is
// where MCP servers are otherwise added. So that a user can still add their
// own, a managed engine surface reads a second, user-owned file that holds
// only MCP servers. The managed file's servers win a name collision, and the
// enterprise MCP allowlist and denylist still prune the combined map.
//
// ManagedConfigSource.DisableUserMcpServers turns this off: the user file is
// not read and every MCP server write is refused.

import (
	"fmt"
	"os"
	"path/filepath"
	"runtime"

	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

// userMcpStorePath is the user-owned MCP server file read on a managed engine
// surface. It has the shape {"mcpServers": {...}}.
func userMcpStorePath() string {
	return filepath.Join(utils.IonDir(), "mcp", "servers.json")
}

// userMcpServersEnabled reports whether a managed engine surface reads the
// user's MCP server file: the managed file applied and policy did not turn
// user servers off.
func userMcpServersEnabled(enterprise *types.EnterpriseConfig, projection managedProjection) bool {
	if !projection.engineOwned || projection.engine == nil {
		return false
	}
	return enterprise.ManagedConfig == nil || !enterprise.ManagedConfig.DisableUserMcpServers
}

// loadUserMcpLayer returns the user's MCP servers as a config layer, or nil
// when the file holds none. Every key other than mcpServers is ignored, so
// the file cannot carry any other engine setting past a managed engine file.
func loadUserMcpLayer() *types.EngineRuntimeConfig {
	raw := loadJSONConfig(userMcpStorePath())
	servers, ok := raw["mcpServers"]
	if !ok {
		return nil
	}
	return fromMap(map[string]any{"mcpServers": servers})
}

// managedMcpServerNames returns the names the managed engine file defines.
func managedMcpServerNames(projection managedProjection) map[string]bool {
	names := make(map[string]bool)
	servers, _ := projection.engine["mcpServers"].(map[string]any) //nolint:errcheck // absent or non-map means no managed servers
	for name := range servers {
		names[name] = true
	}
	return names
}

// ManagedMcpServerNames returns the MCP servers the managed engine file
// defines, which no write can change. It is empty when the engine surface is
// not managed.
func ManagedMcpServerNames() map[string]bool {
	_, projection := loadEnterpriseAndProjection(runtime.GOOS)
	return managedMcpServerNames(projection)
}

// ManagedMcpServerError is returned for a write to an MCP server the managed
// engine file defines. Nothing reached disk.
type ManagedMcpServerError struct {
	Name      string
	Operation string
}

func (e *ManagedMcpServerError) Error() string {
	return fmt.Sprintf("MCP server %q is defined by the managed engine configuration; %s was refused", e.Name, e.Operation)
}

// ResultCode is the machine-readable code a command result carries.
func (e *ManagedMcpServerError) ResultCode() string { return ManagedConfigWriteRefusedCode }

// mcpWriteTarget is the file one MCP server write edits.
type mcpWriteTarget struct {
	path string
	// managedNames are the servers the write must not touch. Empty when the
	// target is engine.json.
	managedNames map[string]bool
}

// refuseManaged returns a ManagedMcpServerError when name is defined by the
// managed engine file.
func (t mcpWriteTarget) refuseManaged(name, operation string) error {
	if !t.managedNames[name] {
		return nil
	}
	utils.LogWithFields(utils.LevelWarn, "config.managed", "mcp server write refused: server is defined by the managed engine file", map[string]any{"server": name, "operation": operation})
	recordEnforcement(EnforcementManagedConfigWriteRefused, operation, ManagedSurfaceEngine, map[string]any{"server": name})
	return &ManagedMcpServerError{Name: name, Operation: operation}
}

// resolveMcpWriteTarget picks the file an MCP server write edits: engine.json
// on an unmanaged engine surface, the user's MCP server file on a managed
// one. It returns a ManagedConfigWriteError when the surface is managed and
// user servers are turned off or the managed file did not apply.
func resolveMcpWriteTarget(operation string) (mcpWriteTarget, error) {
	enterprise, projection := loadEnterpriseAndProjection(runtime.GOOS)
	if !projection.engineOwned {
		utils.LogWithFields(utils.LevelDebug, "config.managed", "mcp server write targets engine.json: surface is not managed", map[string]any{"operation": operation})
		return mcpWriteTarget{path: globalConfigPath()}, nil
	}
	if !userMcpServersEnabled(enterprise, projection) {
		return mcpWriteTarget{}, refuseManagedConfigWrite(ManagedSurfaceEngine, operation)
	}
	path := userMcpStorePath()
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return mcpWriteTarget{}, fmt.Errorf("create %s: %w", filepath.Dir(path), err)
	}
	utils.LogWithFields(utils.LevelDebug, "config.managed", "mcp server write targets the user mcp server file: engine surface is managed", map[string]any{"operation": operation, "path": path})
	return mcpWriteTarget{path: path, managedNames: managedMcpServerNames(projection)}, nil
}
