package extension

import (
	"encoding/base64"
	"encoding/json"
	"os"

	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

// extToolResponse is the structured shape an extension tool may return to
// attach vision images alongside its text content. A tool that returns a bare
// value (string, number, object without an "images" array) falls through the
// text-only path in the caller — this shape is detected only when the response
// is a JSON object carrying an "images" array.
//
// SDK tool return shape supported:
//
//	{ content: "...", images: [{ path: "/abs/path.png", mediaType: "image/png" }] }
type extToolResponse struct {
	Content string             `json:"content"`
	Images  []extToolImageSpec `json:"images"`
}

// extToolImageSpec is one entry in an extension tool response's images array.
// Path is an absolute filesystem path the engine reads; MediaType is the MIME
// type the LLM-input layer needs (e.g. "image/png").
type extToolImageSpec struct {
	Path      string `json:"path"`
	MediaType string `json:"mediaType"`
}

// parseToolResultWithImages inspects a raw extension tool response for the
// structured { content, images:[...] } shape. When the response is a JSON
// object carrying a non-empty "images" array, it reads each image file, base64-
// encodes the bytes, and populates ToolResult.Images (as *types.ImageSource
// with Type="base64"). It returns (result, true) in that case.
//
// When the response is not an object, has no "images" array, or the array is
// empty, it returns (nil, false) so the caller preserves the existing
// text-formatting behavior exactly. A per-image read failure is logged at Error
// and that image is skipped without failing the whole tool result.
//
// tag identifies the extension for log correlation.
func parseToolResultWithImages(raw []byte, tag string) (*types.ToolResult, bool) {
	// Only an object with an "images" array is a candidate. Peek without
	// committing to the typed decode so non-object responses (bare strings,
	// arrays, numbers) fall through untouched.
	var probe struct {
		Images json.RawMessage `json:"images"`
	}
	if err := json.Unmarshal(raw, &probe); err != nil || len(probe.Images) == 0 {
		utils.LogWithFields(utils.LevelDebug, "extension", "tool result has no images array; using text path", map[string]any{
			"tag": tag,
		})
		return nil, false
	}

	var resp extToolResponse
	if err := json.Unmarshal(raw, &resp); err != nil {
		utils.LogWithFields(utils.LevelDebug, "extension", "tool result images-shape decode failed; using text path", map[string]any{
			"tag":   tag,
			"error": utils.ErrStr(err),
		})
		return nil, false
	}
	if len(resp.Images) == 0 {
		utils.LogWithFields(utils.LevelDebug, "extension", "tool result images array empty; using text path", map[string]any{
			"tag": tag,
		})
		return nil, false
	}

	result := &types.ToolResult{Content: resp.Content}
	for _, spec := range resp.Images {
		if spec.Path == "" {
			utils.LogWithFields(utils.LevelError, "extension", "tool result image entry missing path; skipping", map[string]any{
				"tag":       tag,
				"mediaType": spec.MediaType,
			})
			continue
		}
		data, err := os.ReadFile(spec.Path)
		if err != nil {
			utils.LogWithFields(utils.LevelError, "extension", "tool result image read failed; skipping image", map[string]any{
				"tag":       tag,
				"path":      spec.Path,
				"mediaType": spec.MediaType,
				"error":     utils.ErrStr(err),
			})
			continue
		}
		encoded := base64.StdEncoding.EncodeToString(data)
		result.Images = append(result.Images, &types.ImageSource{
			Type:      "base64",
			MediaType: spec.MediaType,
			Data:      encoded,
		})
		utils.LogWithFields(utils.LevelInfo, "extension", "tool result image attached", map[string]any{
			"tag":       tag,
			"path":      spec.Path,
			"mediaType": spec.MediaType,
			"bytes":     len(data),
		})
	}
	return result, true
}
