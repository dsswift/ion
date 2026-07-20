package conversation

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strings"

	"github.com/dsswift/ion/engine/internal/types"
)

// DefaultConversationsDir returns the root directory for conversation storage.
// When ION_DATA_DIR is set in the environment, it is used as the base so that
// multiple engine instances on the same machine can maintain independent
// conversation stores without collision (#191). When unset, the conventional
// ~/.ion/conversations path is returned.
//
// Functions in this package that accept an empty dir string call this helper
// to resolve the default, so callers that pass dir="" automatically benefit
// from ION_DATA_DIR without any changes to their call sites.
func DefaultConversationsDir() string {
	if v := os.Getenv("ION_DATA_DIR"); v != "" {
		return filepath.Join(v, "conversations")
	}
	home, err := os.UserHomeDir()
	if err != nil || home == "" {
		return ""
	}
	return filepath.Join(home, ".ion", "conversations")
}

// DiscoverContextFiles walks parent directories looking for context files.
// Deprecated: use WalkContextFiles from the context package instead, which
// applies the ClaudeCompat gate (Ion-native files always; Claude files only
// when enabled). This helper takes an explicit name list and does NOT gate;
// the zero-arg default is Ion-first to match the engine's default behavior.
func DiscoverContextFiles(cwd string, names []string) []ContextFile {
	if len(names) == 0 {
		names = []string{"AGENTS.md", "ION.md", ".ion/ION.md", ".ion/AGENTS.md"}
	}

	var results []ContextFile
	seen := make(map[string]bool)

	dir, err := filepath.Abs(cwd)
	if err != nil {
		return nil
	}

	for {
		for _, name := range names {
			fp := filepath.Join(dir, name)
			if seen[fp] {
				continue
			}
			seen[fp] = true

			data, err := os.ReadFile(fp)
			if err != nil {
				continue
			}
			results = append(results, ContextFile{Path: fp, Content: string(data)})
		}

		parent := filepath.Dir(dir)
		if parent == dir {
			break
		}
		dir = parent
	}

	return results
}

// supportedImageMime maps file extensions to MIME types for images the engine
// supports as inline content blocks. Used both as a format-gate (reject unknown
// extensions early) and as an allowlist for the content-sniff result.
var supportedImageMime = map[string]string{
	".jpg":  "image/jpeg",
	".jpeg": "image/jpeg",
	".png":  "image/png",
	".webp": "image/webp",
	".gif":  "image/gif",
}

// EncodeImage reads an image file and returns it as a base64 content block.
//
// The media_type is determined by sniffing the actual file bytes first (via
// net/http.DetectContentType), falling back to the file extension only when
// sniffing cannot identify the format. This prevents mismatches when a file's
// extension disagrees with its true content type (e.g. a JPEG saved as .png),
// which Anthropic's API detects and rejects with an invalid_request_error.
func EncodeImage(filePath string) (*types.LlmContentBlock, error) {
	ext := strings.ToLower(filepath.Ext(filePath))
	extMime, ok := supportedImageMime[ext]
	if !ok {
		supported := make([]string, 0, len(supportedImageMime))
		for k := range supportedImageMime {
			supported = append(supported, k)
		}
		return nil, fmt.Errorf("unsupported image format: %s. Supported: %s", ext, strings.Join(supported, ", "))
	}

	data, err := os.ReadFile(filePath)
	if err != nil {
		return nil, err
	}

	const maxSize = 20 * 1024 * 1024
	if len(data) > maxSize {
		return nil, fmt.Errorf("image too large: %.1fMB (max 20MB)", float64(len(data))/(1024*1024))
	}

	// Sniff the actual content type from the first 512 bytes. This is the
	// authoritative detection: Anthropic's API independently inspects the bytes
	// and rejects a mismatched media_type declaration. Using the extension alone
	// fails whenever a file is misnamed (JPEG saved as .png, WebP saved as
	// .jpg, etc.). DetectContentType always returns a valid MIME type string —
	// "application/octet-stream" when it cannot identify the format.
	sniffLen := 512
	if len(data) < sniffLen {
		sniffLen = len(data)
	}
	sniffed := http.DetectContentType(data[:sniffLen])

	// Use the sniffed type only if it is a format we actually support. An
	// "application/octet-stream" result means the bytes were unrecognizable —
	// fall back to the extension-derived type so tiny/truncated test fixtures
	// (which DetectContentType cannot identify) still work.
	mimeType := extMime
	if _, supported := supportedImageMime[mimeTypeToExt(sniffed)]; supported {
		mimeType = sniffed
	}

	block := types.LlmContentBlock{
		Type: "image",
		Source: &types.ImageSource{
			Type:      "base64",
			MediaType: mimeType,
			Data:      base64.StdEncoding.EncodeToString(data),
		},
	}
	return &block, nil
}

// mimeTypeToExt returns an extension (with leading dot) for a MIME type, used
// to check whether a sniffed content type is in our supported set. Returns an
// empty string for unknown types so the caller's map lookup fails gracefully.
func mimeTypeToExt(mime string) string {
	switch mime {
	case "image/jpeg":
		return ".jpg"
	case "image/png":
		return ".png"
	case "image/webp":
		return ".webp"
	case "image/gif":
		return ".gif"
	default:
		return ""
	}
}

func asMessageData(data any) *MessageData {
	switch d := data.(type) {
	case MessageData:
		return &d
	case *MessageData:
		return d
	case map[string]any:
		b, _ := json.Marshal(d)
		var md MessageData
		if json.Unmarshal(b, &md) == nil {
			return &md
		}
	}
	return nil
}

func asCompactionData(data any) *CompactionData {
	switch d := data.(type) {
	case CompactionData:
		return &d
	case *CompactionData:
		return d
	case map[string]any:
		b, _ := json.Marshal(d)
		var cd CompactionData
		if json.Unmarshal(b, &cd) == nil {
			return &cd
		}
	}
	return nil
}

func asPlanMarkerData(data any) *PlanMarkerData {
	switch d := data.(type) {
	case PlanMarkerData:
		return &d
	case *PlanMarkerData:
		return d
	case map[string]any:
		b, _ := json.Marshal(d)
		var pd PlanMarkerData
		if json.Unmarshal(b, &pd) == nil {
			return &pd
		}
	}
	return nil
}

func asSteerMarkerData(data any) *SteerMarkerData {
	switch d := data.(type) {
	case SteerMarkerData:
		return &d
	case *SteerMarkerData:
		return d
	case map[string]any:
		b, _ := json.Marshal(d)
		var sd SteerMarkerData
		if json.Unmarshal(b, &sd) == nil {
			return &sd
		}
	}
	return nil
}

func asAgentDispatchData(data any) *AgentDispatchData {
	switch d := data.(type) {
	case AgentDispatchData:
		return &d
	case *AgentDispatchData:
		return d
	case map[string]any:
		b, _ := json.Marshal(d)
		var ad AgentDispatchData
		if json.Unmarshal(b, &ad) == nil {
			return &ad
		}
	}
	return nil
}

// AgentDispatchEntries returns all agent_dispatch entries from the conversation.
// Used by the session package to rehydrate agent state on session reload.
func AgentDispatchEntries(conv *Conversation) []AgentDispatchData {
	var dispatches []AgentDispatchData
	for _, e := range conv.Entries {
		if e.Type != EntryAgentDispatch {
			continue
		}
		if ad := asAgentDispatchData(e.Data); ad != nil {
			dispatches = append(dispatches, *ad)
		}
	}
	return dispatches
}

func extractText(msg types.LlmMessage) string {
	switch c := msg.Content.(type) {
	case string:
		return c
	case []types.LlmContentBlock:
		var parts []string
		for _, b := range c {
			if b.Type == "text" && b.Text != "" {
				parts = append(parts, b.Text)
			}
		}
		return strings.Join(parts, "\n")
	case []any:
		var parts []string
		for _, item := range c {
			if b, ok := item.(map[string]any); ok {
				if t, _ := b["type"].(string); t == "text" {
					if text, ok := b["text"].(string); ok {
						parts = append(parts, text)
					}
				}
			}
		}
		return strings.Join(parts, "\n")
	}
	return ""
}

func jsonString(m map[string]any, key string) string {
	if v, ok := m[key].(string); ok {
		return v
	}
	return ""
}

func jsonFloat(m map[string]any, key string, def float64) float64 {
	if v, ok := m[key].(float64); ok {
		return v
	}
	return def
}

func strPtr(s string) *string {
	return &s
}
