package config

import (
	"encoding/json"
	"os"
	"path/filepath"

	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

// DefaultConfig returns the baseline engine configuration.
//
// Limits are intentionally unset (nil pointers), and DefaultModel is
// intentionally empty: the engine ships without opinions on turn caps,
// budgets, idle timeouts, or which model/provider exists. A baked-in model
// literal here would silently outlive whatever the operator actually
// configured — a deployment with exactly one provider (no Anthropic access at
// all, by design) would still resolve to an Anthropic model id no key was
// ever meant to back, and fail with a confusing 401 instead of the clear
// "no model configured" runloop_provider_resolve.go already raises. Harness
// engineers and operators set the real default via project/global/enterprise
// config (engine.json's own `defaultModel`) or per-call options; an
// unconfigured engine correctly has none.
func DefaultConfig() *types.EngineRuntimeConfig {
	return &types.EngineRuntimeConfig{
		Backend:      "api",
		DefaultModel: "",
		Providers:    make(map[string]types.ProviderConfig),
		Limits:       types.LimitsConfig{},
		McpServers:   make(map[string]types.McpServerConfig),
		Profiles:     nil,
	}
}

// LoadConfig loads the full engine configuration with layered precedence.
//
// Layers (highest to lowest priority):
//  1. Enterprise (MDM/system) -- sealed, immutable from below
//  2. Project config (.ion/engine.json in projectDir)
//  3. User global config (~/.ion/engine.json)
//  4. Defaults
//
// When enterprise policy declares a managed engine file (managed_projection.go)
// that file replaces layers 2 and 3 in full.
func LoadConfig(projectDir string) *types.EngineRuntimeConfig {
	// Resolve the fully-merged, enterprise-enforced config via the pure
	// helper, then layer on the process-global side effects LoadConfig owns.
	merged := mergeConfigLayers(projectDir)

	// Normalize the legacy backend alias. "cli" is the historical name for
	// the Claude Code backend; "claude-code" is canonical. "cli" remains a
	// permanently accepted input alias so existing engine.json files keep
	// working. Normalizing here means every downstream consumer (serve
	// switch, provider auth-source labeling) sees the canonical value.
	if merged.Backend == "cli" {
		utils.LogWithFields(utils.LevelInfo, "config", "normalized legacy backend alias", map[string]any{"from": "cli", "to": "claude-code"})
		merged.Backend = "claude-code"
	}

	// Validate per-provider backend preferences (providers.<id>.backend),
	// resetting any invalid value to the default rule with an ERROR log.
	validateProviderBackends(merged)

	// Apply log level from config
	if merged.LogLevel != "" {
		utils.SetLevelFromString(merged.LogLevel)
	}

	// Wire structured-logging config (format, output destination, size cap,
	// rotation toggle). Nil block leaves the compiled defaults in place.
	if merged.Logging != nil {
		utils.ConfigureLogging(merged.Logging)
	}

	return merged
}

// mergeConfigLayers performs the pure layered merge (defaults < global <
// project, or defaults < managed engine file) and enterprise enforcement, with NO process-global side effects
// (no log-level mutation, no ConfigureLogging, no backend-alias log line, no
// provider-backend validation). It is the shared core of both LoadConfig
// (which layers its side effects on top) and the fresh dispatch-time resolvers
// in config_resolve.go, which must be safe to call on every prompt without
// perturbing global logging state.
//
// resolveEnvProviders IS applied here: it mutates only the in-memory global
// config map (injecting provider keys from the environment), which is part of
// producing a correct merged config, not a process-global side effect.
func mergeConfigLayers(projectDir string) *types.EngineRuntimeConfig {
	return mergeConfigLayersWith(projectDir, LoadEnterpriseConfig())
}

// mergeConfigLayersFor is mergeConfigLayers for one session: enterprise
// enforcement uses the policy resolved for principal, so a fresh
// dispatch-time read honors the account policies that apply to it.
func mergeConfigLayersFor(projectDir string, principal []*types.SessionPrincipal) *types.EngineRuntimeConfig {
	return mergeConfigLayersWith(projectDir, LoadEnterpriseConfigFor(firstPrincipal(principal)))
}

func mergeConfigLayersWith(projectDir string, enterprise *types.EnterpriseConfig) *types.EngineRuntimeConfig {
	defaults := DefaultConfig()
	defaults.Profiles = loadProfiles()

	// enterprise is the caller's resolved policy (a session's carries its
	// account policies). The managed files it declares are read here.
	enterprise, projection := resolveManagedProjection(enterprise)

	var merged *types.EngineRuntimeConfig
	if projection.engineOwned {
		// The managed file is the whole engine configuration, bar the user's
		// own MCP servers. The global and project files are not read, and a
		// managed file that did not apply (nil content) leaves only the
		// defaults.
		utils.LogWithFields(utils.LevelDebug, "config", "engine config projected from managed source; global and project layers skipped", map[string]any{"project_dir": projectDir, "applied": projection.engine != nil})
		var userMcp *types.EngineRuntimeConfig
		if userMcpServersEnabled(enterprise, projection) {
			// The user's own MCP servers sit below the managed file, so a
			// managed server wins a name collision.
			userMcp = loadUserMcpLayer()
		}
		merged = MergeConfigs(nil, defaults, userMcp, fromMap(projection.engine))
	} else {
		// Load global ~/.ion/engine.json
		globalConfig := loadJSONConfig(globalConfigPath())

		// Resolve provider API keys from env
		resolveEnvProviders(globalConfig)

		// Load project-level .ion/engine.json
		var projectConfig map[string]any
		if projectDir != "" {
			projectConfig = loadJSONConfig(filepath.Join(projectDir, ".ion", "engine.json"))
		}

		projectLayer := fromMap(projectConfig)
		dropProjectProtectedOperations(projectLayer, projectDir)

		// Merge: defaults < global < project
		merged = MergeConfigs(nil, defaults, fromMap(globalConfig), projectLayer)
	}

	// Enforce enterprise config
	if enterprise != nil {
		merged = EnforceEnterprise(merged, enterprise)
	}

	return merged
}

// FindProfile searches loaded profiles by name or ID.
func FindProfile(name string, config *types.EngineRuntimeConfig) *types.EngineProfileConfig {
	if config == nil {
		return nil
	}
	for i := range config.Profiles {
		if config.Profiles[i].Name == name || config.Profiles[i].ID == name {
			return &config.Profiles[i]
		}
	}
	return nil
}

// ExpandTilde replaces a leading ~ with the user's home directory. It delegates
// to utils.ExpandHomePath, the single engine-wide home-path expansion helper, so
// every config field that accepts a filesystem path expands identically.
func ExpandTilde(path string) string {
	return utils.ExpandHomePath(path)
}

func globalConfigPath() string {
	return filepath.Join(utils.IonDir(), "engine.json")
}

func settingsPath() string {
	return filepath.Join(utils.IonDir(), "settings.json")
}

func loadProfiles() []types.EngineProfileConfig {
	data, err := os.ReadFile(settingsPath())
	if err != nil {
		return nil
	}
	var raw struct {
		EngineProfiles  []types.EngineProfileConfig `json:"engineProfiles"`
		HarnessProfiles []types.EngineProfileConfig `json:"harnessProfiles"`
	}
	if err := json.Unmarshal(data, &raw); err != nil {
		return nil
	}
	if len(raw.EngineProfiles) > 0 {
		return raw.EngineProfiles
	}
	return raw.HarnessProfiles
}

func loadJSONConfig(path string) map[string]any {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil
	}
	var m map[string]any
	if err := json.Unmarshal(data, &m); err != nil {
		utils.LogWithFields(utils.LevelInfo, "config", "failed to parse config file", map[string]any{"path": path, "error": err.Error()})
		return nil
	}
	return m
}

func resolveEnvProviders(cfg map[string]any) {
	if cfg == nil {
		return
	}
	providers, _ := cfg["providers"].(map[string]any) //nolint:errcheck // nil map handled below
	if providers == nil {
		providers = make(map[string]any)
		cfg["providers"] = providers
	}

	if anthropic, _ := providers["anthropic"].(map[string]any); anthropic == nil || anthropic["apiKey"] == nil { //nolint:errcheck // nil map handled inline
		if key := os.Getenv("ANTHROPIC_API_KEY"); key != "" {
			if anthropic == nil {
				anthropic = make(map[string]any)
			}
			anthropic["apiKey"] = key
			providers["anthropic"] = anthropic
		}
	}

	if openai, _ := providers["openai"].(map[string]any); openai == nil || openai["apiKey"] == nil { //nolint:errcheck // nil map handled inline
		if key := os.Getenv("OPENAI_API_KEY"); key != "" {
			if openai == nil {
				openai = make(map[string]any)
			}
			openai["apiKey"] = key
			providers["openai"] = openai
		}
	}
}

// fromMap converts a generic JSON map to an EngineRuntimeConfig via re-marshaling.
// Returns nil if the input is nil or conversion fails.
func fromMap(m map[string]any) *types.EngineRuntimeConfig {
	if m == nil {
		return nil
	}
	data, err := json.Marshal(m)
	if err != nil {
		return nil
	}
	var cfg types.EngineRuntimeConfig
	if err := json.Unmarshal(data, &cfg); err != nil {
		return nil
	}
	return &cfg
}
