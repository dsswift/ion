package config

// managed_projection.go — managed full-file projection.
//
// Enterprise policy can name a managed engine file and a managed models file
// (EnterpriseConfig.ManagedConfig). A declared surface is owned in full: the
// managed file is that surface's whole configuration, and the user and
// project files contribute nothing to it. A key the managed file leaves out
// resolves to the built-in default, never to a user value.
//
// A declared surface stays owned when its file cannot be applied (unsupported
// schema version, missing, unreadable, malformed). It then resolves to
// built-in defaults and its status carries the error, so a broken managed
// source never hands the surface back to the user.
//
// Typed sealing is unchanged and still runs on top of a projected engine
// surface. With no ManagedConfig nothing here changes any behavior.

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"runtime"
	"sync"

	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

// ManagedConfigSchemaVersion is the managed-file schema this engine reads.
const ManagedConfigSchemaVersion = 1

// Managed surface names, as they appear in errors, logs, and audit events.
const (
	ManagedSurfaceEngine = "engine"
	ManagedSurfaceModels = "models"
)

// managedProjection is the content read for each declared surface. A nil map
// on a declared surface means its file did not apply.
type managedProjection struct {
	engineOwned bool
	engine      map[string]any
	modelsOwned bool
	models      map[string]any
}

// resolveManagedProjection reads the files cfg declares and returns cfg with
// ManagedConfigStatus stamped, plus the content read. A status a policy
// source carried is always dropped, so only this function can produce one.
func resolveManagedProjection(cfg *types.EnterpriseConfig) (*types.EnterpriseConfig, managedProjection) {
	var projection managedProjection
	if cfg == nil {
		reportManagedConfig(nil)
		return nil, projection
	}
	source := cfg.ManagedConfig
	if source == nil || (source.EnginePath == "" && source.ModelsPath == "") {
		reportManagedConfig(nil)
		if cfg.ManagedConfigStatus == nil {
			return cfg, projection
		}
		clone := *cfg
		clone.ManagedConfigStatus = nil
		return &clone, projection
	}

	status := &types.ManagedConfigStatus{
		SchemaVersion:          source.SchemaVersion,
		SupportedSchemaVersion: ManagedConfigSchemaVersion,
	}
	if source.EnginePath != "" {
		projection.engineOwned = true
		projection.engine, status.Engine = readManagedSurface(ManagedSurfaceEngine, source.EnginePath, source.SchemaVersion)
	}
	if source.ModelsPath != "" {
		projection.modelsOwned = true
		projection.models, status.Models = readManagedSurface(ManagedSurfaceModels, source.ModelsPath, source.SchemaVersion)
	}
	clone := *cfg
	clone.ManagedConfigStatus = status
	reportManagedConfig(status)
	return &clone, projection
}

// readManagedSurface reads one declared managed file. The status never
// carries file content; the detail of a read or parse failure goes to the log.
func readManagedSurface(surface, path string, schemaVersion int) (map[string]any, *types.ManagedSurfaceStatus) {
	fail := func(reason string, err error) (map[string]any, *types.ManagedSurfaceStatus) {
		fields := map[string]any{"surface": surface, "path": path, "reason": reason}
		if err != nil {
			fields["error"] = err.Error()
		}
		utils.LogWithFields(utils.LevelDebug, "config.managed", "managed file not applied", fields)
		return nil, &types.ManagedSurfaceStatus{Error: reason}
	}

	if schemaVersion != ManagedConfigSchemaVersion {
		return fail(fmt.Sprintf("unsupported managed config schema version %d; this engine supports version %d", schemaVersion, ManagedConfigSchemaVersion), nil)
	}
	if !filepath.IsAbs(path) {
		return fail("managed file path is not absolute", nil)
	}
	data, err := os.ReadFile(path)
	if errors.Is(err, fs.ErrNotExist) {
		return fail("managed file is missing", err)
	}
	if err != nil {
		return fail("managed file is unreadable", err)
	}
	sum := sha256.Sum256(data)
	checksum := "sha256:" + hex.EncodeToString(sum[:])

	var content map[string]any
	if err := json.Unmarshal(data, &content); err != nil || content == nil {
		_, status := fail("managed file is not a JSON object", err)
		status.Checksum = checksum
		return nil, status
	}
	if surface == ManagedSurfaceEngine && fromMap(content) == nil {
		_, status := fail("managed file does not decode as engine configuration", nil)
		status.Checksum = checksum
		return nil, status
	}
	return content, &types.ManagedSurfaceStatus{Projected: true, Checksum: checksum}
}

// ManagedConfigError returns why a declared managed surface did not apply,
// or "" when every declared surface applied (or none is declared). Callers
// refuse work while it is non-empty.
func ManagedConfigError(enterprise *types.EnterpriseConfig) string {
	if enterprise == nil || enterprise.ManagedConfigStatus == nil {
		return ""
	}
	status := enterprise.ManagedConfigStatus
	if status.Engine != nil && status.Engine.Error != "" {
		return ManagedSurfaceEngine + ": " + status.Engine.Error
	}
	if status.Models != nil && status.Models.Error != "" {
		return ManagedSurfaceModels + ": " + status.Models.Error
	}
	return ""
}

// ManagedModelsConfig returns the managed model configuration. owned is false
// when policy declares no models file, and the caller reads its own file. When
// owned, a non-nil error means the managed file did not apply and the surface
// has no configuration.
func ManagedModelsConfig() (config map[string]any, owned bool, err error) {
	enterprise, projection := loadEnterpriseAndProjection(runtime.GOOS)
	if !projection.modelsOwned {
		return nil, false, nil
	}
	if projection.models == nil {
		return nil, true, errors.New("managed model configuration: " + enterprise.ManagedConfigStatus.Models.Error)
	}
	return projection.models, true, nil
}

// ManagedConfigWriteRefusedCode is the result code of a write refused because
// its surface is owned by the managed source.
const ManagedConfigWriteRefusedCode = "managed_config_write_refused"

// ManagedConfigWriteError is returned for a write to a surface the managed
// source owns. Nothing reached disk.
type ManagedConfigWriteError struct {
	Surface   string
	Operation string
}

func (e *ManagedConfigWriteError) Error() string {
	return fmt.Sprintf("%s configuration is owned by the managed source (enterprise policy managedConfig); %s was refused", e.Surface, e.Operation)
}

// ResultCode is the machine-readable code a command result carries.
func (e *ManagedConfigWriteError) ResultCode() string { return ManagedConfigWriteRefusedCode }

// RefuseManagedConfigWrite returns a ManagedConfigWriteError when the managed
// source owns surface, and nil otherwise. Every writer of the engine or model
// configuration calls it before touching disk, except the MCP server writers,
// which have a file of their own on a managed engine surface
// (mcp_user_store.go).
func RefuseManagedConfigWrite(surface, operation string) error {
	_, projection := loadEnterpriseAndProjection(runtime.GOOS)
	owned := projection.engineOwned
	if surface == ManagedSurfaceModels {
		owned = projection.modelsOwned
	}
	if !owned {
		utils.LogWithFields(utils.LevelDebug, "config.managed", "configuration write permitted: surface is not managed", map[string]any{"surface": surface, "operation": operation})
		return nil
	}
	return refuseManagedConfigWrite(surface, operation)
}

// refuseManagedConfigWrite logs and records one refused write to a surface
// the caller already knows is managed.
func refuseManagedConfigWrite(surface, operation string) error {
	utils.LogWithFields(utils.LevelWarn, "config.managed", "configuration write refused: surface is managed", map[string]any{"surface": surface, "operation": operation})
	recordEnforcement(EnforcementManagedConfigWriteRefused, operation, surface, nil)
	return &ManagedConfigWriteError{Surface: surface, Operation: operation}
}

var (
	managedConfigReportMu   sync.Mutex
	managedConfigReportLast string
	managedConfigReportSeen bool
)

// reportManagedConfig logs the projection outcome and records an enforcement
// action for a surface that did not apply. Enterprise config is re-read on
// every config resolution, so this reports once per distinct outcome.
func reportManagedConfig(status *types.ManagedConfigStatus) {
	state := "none"
	if status != nil {
		encoded, err := json.Marshal(status)
		if err != nil {
			encoded = []byte(err.Error())
		}
		state = string(encoded)
	}
	managedConfigReportMu.Lock()
	unchanged := managedConfigReportSeen && managedConfigReportLast == state
	managedConfigReportSeen, managedConfigReportLast = true, state
	managedConfigReportMu.Unlock()
	if unchanged {
		return
	}

	if status == nil {
		utils.LogWithFields(utils.LevelDebug, "config.managed", "no managed config projection declared", nil)
		return
	}
	for surface, s := range map[string]*types.ManagedSurfaceStatus{ManagedSurfaceEngine: status.Engine, ManagedSurfaceModels: status.Models} {
		if s == nil {
			utils.LogWithFields(utils.LevelDebug, "config.managed", "managed surface not declared", map[string]any{"surface": surface})
			continue
		}
		fields := map[string]any{"surface": surface, "schema_version": status.SchemaVersion, "checksum": s.Checksum}
		if s.Projected {
			utils.LogWithFields(utils.LevelInfo, "config.managed", "managed config projected", fields)
			continue
		}
		fields["error"] = s.Error
		utils.LogWithFields(utils.LevelError, "config.managed", "managed config not applied; surface resolves to defaults", fields)
		recordEnforcement(EnforcementManagedConfigInvalid, surface, "managedConfig", map[string]any{"reason": s.Error, "schema_version": status.SchemaVersion})
	}
}
