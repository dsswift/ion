package conversation

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/dsswift/ion/engine/internal/utils"
)

// DefaultMaxToolResultChars is the system-wide cap for tool result content.
// Results exceeding this are persisted to disk and replaced with a preview.
// Matches Claude Code's DEFAULT_MAX_RESULT_SIZE_CHARS.
const DefaultMaxToolResultChars = 50000

// previewChars is the number of characters from the beginning of the result
// to include in the preview sent to the LLM.
const previewChars = 2000

// PersistAndPreview checks whether a tool result exceeds the given character
// limit. If it does, the full content is written to disk and the returned
// string contains a preview + file path the model can Read. If it doesn't
// exceed the limit, the original content is returned unchanged.
//
// Parameters:
//   - content: the tool result text
//   - toolUseID: unique identifier for this tool invocation (used as filename)
//   - convDir: the conversations directory (~/.ion/conversations)
//   - convID: the conversation ID (subdirectory for tool results)
//   - maxChars: the character limit; <= 0 means use DefaultMaxToolResultChars
//
// Returns the (possibly replaced) content string and whether the result was persisted.
func PersistAndPreview(content, toolUseID, convDir, convID string, maxChars int) (string, bool) {
	if maxChars <= 0 {
		maxChars = DefaultMaxToolResultChars
	}

	if len(content) <= maxChars {
		return content, false
	}

	// Build the storage directory: {convDir}/tool-results/{convID}/
	storageDir := filepath.Join(convDir, "tool-results", convID)
	if err := os.MkdirAll(storageDir, 0o755); err != nil {
		utils.LogWithFields(utils.LevelWarn, "conversation.tool_result_storage", "failed to create tool results dir returning full content", map[string]any{"path": storageDir, "error": err.Error()})
		return content, false
	}

	// Each oversized result gets an engine-generated filename. Provider-issued
	// tool IDs are correlation data, not filesystem identities: collision or a
	// hostile separator must never let one invocation overwrite another.
	file, err := os.CreateTemp(storageDir, "result-*.txt")
	if err != nil {
		utils.LogWithFields(utils.LevelWarn, "conversation.tool_result_storage", "failed to create tool result file returning full content", map[string]any{"path": storageDir, "error": err.Error()})
		return content, false
	}
	filePath := file.Name()
	if err := file.Chmod(0o600); err != nil {
		file.Close()        //nolint:errcheck // best-effort before removal
		os.Remove(filePath) //nolint:errcheck // unpublished result cleanup
		utils.LogWithFields(utils.LevelWarn, "conversation.tool_result_storage", "failed to secure tool result file returning full content", map[string]any{"path": filePath, "error": err.Error()})
		return content, false
	}
	if _, err := file.WriteString(content); err != nil {
		file.Close()        //nolint:errcheck // best-effort before removal
		os.Remove(filePath) //nolint:errcheck // unpublished result cleanup
		utils.LogWithFields(utils.LevelWarn, "conversation.tool_result_storage", "failed to write tool result returning full content", map[string]any{"path": filePath, "error": err.Error()})
		return content, false
	}
	if err := file.Sync(); err != nil {
		file.Close()        //nolint:errcheck // best-effort before removal
		os.Remove(filePath) //nolint:errcheck // unpublished result cleanup
		utils.LogWithFields(utils.LevelWarn, "conversation.tool_result_storage", "failed to sync tool result returning full content", map[string]any{"path": filePath, "error": err.Error()})
		return content, false
	}
	if err := file.Close(); err != nil {
		os.Remove(filePath) //nolint:errcheck // unpublished result cleanup
		utils.LogWithFields(utils.LevelWarn, "conversation.tool_result_storage", "failed to close tool result returning full content", map[string]any{"path": filePath, "error": err.Error()})
		return content, false
	}

	// Build preview: first N chars + metadata
	preview := content
	if len(preview) > previewChars {
		preview = preview[:previewChars]
	}

	var sb strings.Builder
	sb.WriteString(preview)
	sb.WriteString("\n\n")
	fmt.Fprintf(&sb,
		"[Tool result truncated: %d total characters, showing first %d. Full output saved to: %s — use the Read tool to access the complete content if needed.]",
		len(content), len(preview), filePath)

	utils.LogWithFields(utils.LevelInfo, "conversation.tool_result_storage", "persisted oversized tool result", map[string]any{
		"run_id": toolUseID, "count": len(content), "max": maxChars, "path": filePath,
	})

	return sb.String(), true
}
