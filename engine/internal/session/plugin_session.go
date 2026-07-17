package session

import (
	"github.com/dsswift/ion/engine/internal/plugins"
	"github.com/dsswift/ion/engine/internal/skills"
	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

// pluginUserPromptCmd pairs a UserPromptSubmit hook entry with the plugin root
// path needed by RunHookCommand. Stored on engineSession so the OnInitialMessages
// closure in prompt_runconfig.go can fire the commands without re-reading the
// registry on every prompt.
type pluginUserPromptCmd struct {
	Entry      plugins.PluginHookEntry
	PluginRoot string
}

// wrapInSystemReminder wraps content in a <system-reminder> block, matching
// Claude Code's wrapInSystemReminder format (messages.ts:3098). This gives
// plugin hook output full conversational attention weight when it appears as
// a user message in the conversation history.
func wrapInSystemReminder(content string) string {
	return "<system-reminder>\n" + content + "\n</system-reminder>"
}

// loadAndWirePlugins loads all installed plugins at session start:
//   - Runs each plugin's SessionStart hooks and stores their output as
//     pluginSessionMessages on the session (prepended to provider messages each turn).
//   - Stores each plugin's UserPromptSubmit hook commands for per-turn firing.
//   - Loads any skills/ directory the plugin ships into the skill registry.
//
// Called from StartSession after the Ion skill directories are loaded, before
// MCP connection. Non-fatal: hook failures are logged and skipped.
func (m *Manager) loadAndWirePlugins(s *engineSession, key string) {
	installed, err := plugins.ListInstalled()
	if err != nil {
		utils.LogWithFields(utils.LevelInfo, "plugins", "failed to list installed plugins", map[string]any{
			"key": key, "error": err.Error(),
		})
		return
	}
	if len(installed) == 0 {
		return
	}

	utils.LogWithFields(utils.LevelInfo, "plugins", "loading plugins for session", map[string]any{
		"key": key, "count": len(installed),
	})

	for _, p := range installed {
		manifest, err := plugins.LoadManifest(p.InstallPath)
		if err != nil || manifest == nil {
			errStr := "no manifest"
			if err != nil {
				errStr = err.Error()
			}
			utils.LogWithFields(utils.LevelInfo, "plugins", "skipping plugin with missing/invalid manifest", map[string]any{
				"key": key, "name": p.Name, "error": errStr,
			})
			continue
		}

		// Run SessionStart hooks and collect output as system-reminder messages.
		// Using LlmMessage (not AppendSystemPrompt) so the content appears in the
		// conversation history at full attention weight, matching Claude Code's
		// hook_additional_context injection via processUserInput → createAttachmentMessage.
		for _, entry := range manifest.SessionStartCommands() {
			if entry.Type != "command" {
				continue
			}
			out, hookErr := plugins.RunHookCommand(entry, p.InstallPath, nil)
			if hookErr != nil {
				utils.LogWithFields(utils.LevelInfo, "plugins", "SessionStart hook error", map[string]any{
					"key": key, "plugin": p.Name, "error": hookErr.Error(),
				})
				continue
			}
			ctx := plugins.ParseHookOutput(out)
			if ctx != "" {
				msg := types.LlmMessage{
					Role:    "user",
					Content: wrapInSystemReminder("SessionStart hook additional context: " + ctx),
				}
				s.pluginSessionMessages = append(s.pluginSessionMessages, msg)
				utils.LogWithFields(utils.LevelInfo, "plugins", "SessionStart hook produced system-reminder message", map[string]any{
					"key": key, "plugin": p.Name, "len": len(ctx),
				})
			}
		}

		// Store UserPromptSubmit hooks for per-turn firing via OnInitialMessages.
		for _, entry := range manifest.UserPromptSubmitCommands() {
			if entry.Type != "command" {
				continue
			}
			s.pluginUserPromptHooks = append(s.pluginUserPromptHooks, pluginUserPromptCmd{
				Entry:      entry,
				PluginRoot: p.InstallPath,
			})
		}

		// Load plugin's skills/ directory if present.
		skillsDir := p.InstallPath + "/skills"
		loaded, loadErr := skills.LoadSkillDirectory(skillsDir, nil)
		if loadErr == nil && len(loaded) > 0 {
			for _, sk := range loaded {
				skills.RegisterSkill(sk)
			}
			utils.LogWithFields(utils.LevelInfo, "plugins", "loaded plugin skills", map[string]any{
				"key": key, "plugin": p.Name, "count": len(loaded),
			})
		}

		utils.LogWithFields(utils.LevelInfo, "plugins", "wired plugin", map[string]any{
			"key": key, "plugin": p.Name, "source": p.Source,
		})
	}
}
