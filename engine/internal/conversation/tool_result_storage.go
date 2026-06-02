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
		utils.Warn("ToolResultStorage", fmt.Sprintf(
			"failed to create tool-results dir %s: %v, returning full content", storageDir, err))
		return content, false
	}

	// Write full content to disk
	filePath := filepath.Join(storageDir, toolUseID+".txt")
	if err := os.WriteFile(filePath, []byte(content), 0o644); err != nil {
		utils.Warn("ToolResultStorage", fmt.Sprintf(
			"failed to write tool result to %s: %v, returning full content", filePath, err))
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

	utils.Log("ToolResultStorage", fmt.Sprintf(
		"persisted oversized tool result: toolUseID=%s chars=%d maxChars=%d path=%s",
		toolUseID, len(content), maxChars, filePath))

	return sb.String(), true
}
