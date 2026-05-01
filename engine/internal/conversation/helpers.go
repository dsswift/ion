package conversation

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/dsswift/ion/engine/internal/types"
)

// DiscoverContextFiles walks parent directories looking for context files.
// Deprecated: use walkContextFiles from the context package instead.
func DiscoverContextFiles(cwd string, names []string) []ContextFile {
	if len(names) == 0 {
		names = []string{"CLAUDE.md", "ION.md", ".claude/CLAUDE.md", ".ion/ION.md"}
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

// EncodeImage reads an image file and returns it as a base64 content block.
func EncodeImage(filePath string) (*types.LlmContentBlock, error) {
	supportedMime := map[string]string{
		".jpg":  "image/jpeg",
		".jpeg": "image/jpeg",
		".png":  "image/png",
		".webp": "image/webp",
		".gif":  "image/gif",
	}

	ext := strings.ToLower(filepath.Ext(filePath))
	mimeType, ok := supportedMime[ext]
	if !ok {
		supported := make([]string, 0, len(supportedMime))
		for k := range supportedMime {
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
