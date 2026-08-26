package config

import (
	"fmt"
	"path/filepath"

	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

// ResolvedNewConversationDefaults is the portable new-conversation policy
// resolved for one directory. ProfileName is stable across machines; ProfileID
// and Extensions are local materialization details for a start_session caller.
type ResolvedNewConversationDefaults struct {
	Path          string   `json:"path"`
	BaseDirectory string   `json:"baseDirectory,omitempty"`
	ProfileName   string   `json:"profileName,omitempty"`
	ProfileID     string   `json:"profileId,omitempty"`
	Extensions    []string `json:"extensions,omitempty"`
	ProfileLocked bool     `json:"profileLocked,omitempty"`
}

// ResolveNewConversationDefaults resolves the layered default policy for path.
// It is safe to call per request: unlike LoadConfig it has no process-global
// logging side effects. An empty path deliberately resolves global defaults.
func ResolveNewConversationDefaults(path string) ResolvedNewConversationDefaults {
	cfg := mergeConfigLayers(path)
	result := resolveNewConversationDefaults(path, cfg)
	utils.LogWithFields(utils.LevelDebug, "config", "resolved new conversation defaults", map[string]any{
		"path": path, "profile_name": result.ProfileName, "profile_id": result.ProfileID,
		"profile_locked": result.ProfileLocked,
	})
	return result
}

func resolveNewConversationDefaults(path string, cfg *types.EngineRuntimeConfig) ResolvedNewConversationDefaults {
	result := ResolvedNewConversationDefaults{Path: path}
	if cfg == nil || cfg.NewConversationDefaults == nil {
		return result
	}
	policy := *cfg.NewConversationDefaults
	for _, project := range ManagedProjects() {
		if path != project.Directory {
			continue
		}
		if project.ProfileName != "" {
			policy.ProfileName = project.ProfileName
			policy.EngineProfileId = ""
		}
		if project.ProfileLocked {
			policy.ProfileLocked = true
		}
		break
	}
	result.BaseDirectory = policy.BaseDirectory
	result.ProfileLocked = policy.ProfileLocked || policy.Locked
	result.ProfileName = policy.ProfileName

	profileRef := policy.ProfileName
	if profileRef == "" {
		profileRef = policy.EngineProfileId
	}
	if profileRef == "" {
		return result
	}
	profile := FindProfile(profileRef, cfg)
	if profile == nil {
		// Keep the portable reference in the reply. A client can show a precise
		// policy error instead of silently selecting an unrelated local profile.
		if policy.ProfileName == "" {
			result.ProfileName = policy.EngineProfileId
		}
		return result
	}
	result.ProfileName = profile.Name
	result.ProfileID = profile.ID
	result.Extensions = profileExtensions(*profile)
	return result
}

// ManagedProjects returns validated runtime records for enterprise-owned Projects.
// A malformed duplicate or multiple defaults is ignored as a whole so an MDM
// mistake cannot make a client choose an arbitrary project.
func ManagedProjects() []types.ManagedProjectPolicy {
	enterprise := LoadEnterpriseConfig()
	if enterprise == nil || enterprise.NewConversationDefaults == nil {
		return nil
	}
	projects := enterprise.NewConversationDefaults.Projects
	seen := make(map[string]struct{}, len(projects))
	defaults := 0
	out := make([]types.ManagedProjectPolicy, 0, len(projects))
	for _, project := range projects {
		project.Directory = ExpandTilde(project.Directory)
		project.Directory = filepath.Clean(project.Directory)
		if project.Directory == "." || !filepath.IsAbs(project.Directory) {
			utils.LogWithFields(utils.LevelWarn, "config", "ignored invalid managed project", map[string]any{"directory": project.Directory})
			return nil
		}
		if _, exists := seen[project.Directory]; exists {
			utils.LogWithFields(utils.LevelWarn, "config", "ignored duplicate managed project", map[string]any{"directory": project.Directory})
			return nil
		}
		seen[project.Directory] = struct{}{}
		if project.Default {
			defaults++
		}
		out = append(out, project)
	}
	if defaults > 1 {
		utils.LogWithFields(utils.LevelWarn, "config", "ignored managed projects with multiple defaults", map[string]any{"count": defaults})
		return nil
	}
	return out
}

// boundary. This is the authority boundary: clients may use the resolver for a
// picker, but they cannot bypass a lock by sending different profile paths.
func ApplyNewConversationDefaults(sessionConfig types.EngineConfig) (types.EngineConfig, error) {
	projectDirectory := sessionConfig.ProjectDirectory
	if projectDirectory == "" {
		projectDirectory = sessionConfig.WorkingDirectory
	}
	resolved := ResolveNewConversationDefaults(projectDirectory)
	if !resolved.ProfileLocked {
		return sessionConfig, nil
	}
	if resolved.ProfileName != "" && resolved.ProfileID == "" {
		return sessionConfig, fmt.Errorf("locked profile %q is not configured on this host", resolved.ProfileName)
	}
	// Empty profile is the explicit plain-conversation lock. Do not retain
	// caller-provided extensions in either locked branch.
	sessionConfig.ProfileID = resolved.ProfileID
	sessionConfig.Extensions = append([]string(nil), resolved.Extensions...)
	utils.LogWithFields(utils.LevelInfo, "config", "applied locked new conversation profile", map[string]any{
		"working_directory": sessionConfig.WorkingDirectory, "profile_name": resolved.ProfileName,
		"profile_id": resolved.ProfileID, "extension_count": len(sessionConfig.Extensions),
	})
	return sessionConfig, nil
}

func profileExtensions(profile types.EngineProfileConfig) []string {
	if len(profile.Extensions) > 0 {
		return append([]string(nil), profile.Extensions...)
	}
	if profile.ExtensionDir != "" {
		return []string{profile.ExtensionDir}
	}
	return nil
}
