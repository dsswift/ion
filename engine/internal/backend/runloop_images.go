package backend

import (
	"github.com/dsswift/ion/engine/internal/conversation"
	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

// This file holds the image-persistence helpers shared by the tool-result and
// provider-output paths. Both convert base64 image bytes into a durable on-disk
// path under the conversation's images/ directory so events carry a FILE PATH
// rather than base64 on the wire. Extracted from runloop_tools.go to keep that
// file under the 800-line cap; they are a cohesive cluster (image saving), so
// they live together here.

// saveToolResultImages persists each tool-returned vision image's base64 bytes
// to the conversation's images/ directory and returns the per-image
// ToolResultImage references (Source="tool") carrying the on-disk FILE PATH.
// The engine never puts base64 on the wire — this converts the LLM-input
// ImageSource (base64) into a durable path reference for events.
//
// convID is resolved from the run's loaded conversation. A save failure for one
// image is logged at Error and that image is skipped (not fatal to the tool
// result). An empty convID (no conversation on the run) skips saving entirely
// and logs, since there is no images/ directory to write into.
func (b *ApiBackend) saveToolResultImages(run *activeRun, toolID string, images []*types.ImageSource) []types.ToolResultImage {
	convID := ""
	if run != nil && run.conv != nil {
		convID = run.conv.ID
	}
	if convID == "" {
		utils.LogWithFields(utils.LevelError, "backend.runloop", "tool returned images but run has no conversation id; skipping image save", map[string]any{
			"run_id":  run.requestID,
			"tool_id": toolID,
			"count":   len(images),
		})
		return nil
	}
	var out []types.ToolResultImage
	for _, img := range images {
		if img == nil {
			continue
		}
		path, err := conversation.SaveImageToConversation("", convID, img.MediaType, img.Data)
		if err != nil {
			utils.LogWithFields(utils.LevelError, "backend.runloop", "tool result image save failed; skipping image", map[string]any{
				"run_id":    run.requestID,
				"tool_id":   toolID,
				"mediaType": img.MediaType,
				"error":     utils.ErrStr(err),
			})
			continue
		}
		utils.LogWithFields(utils.LevelInfo, "backend.runloop", "tool result image saved", map[string]any{
			"run_id":    run.requestID,
			"tool_id":   toolID,
			"mediaType": img.MediaType,
			"path":      path,
		})
		out = append(out, types.ToolResultImage{
			Path:      path,
			MediaType: img.MediaType,
			Source:    "tool",
		})
	}
	return out
}

// saveProviderImage persists a single provider-generated image's base64 bytes
// to the conversation's images/ directory and returns the on-disk FILE PATH.
// It is the provider-output counterpart to saveToolResultImages: same shared
// saver, same never-base64-on-the-wire contract, but Source="provider" and no
// owning tool call.
//
// convID is resolved from the run's loaded conversation. An empty convID (no
// conversation on the run) or a save failure is logged at Error and returns ""
// so the caller emits no event rather than a dangling path.
func (b *ApiBackend) saveProviderImage(run *activeRun, mediaType, base64Data string) string {
	if base64Data == "" {
		return ""
	}
	convID := ""
	if run != nil && run.conv != nil {
		convID = run.conv.ID
	}
	if convID == "" {
		utils.LogWithFields(utils.LevelError, "backend.runloop", "provider returned image but run has no conversation id; skipping image save", map[string]any{
			"run_id":    run.requestID,
			"mediaType": mediaType,
		})
		return ""
	}
	path, err := conversation.SaveImageToConversation("", convID, mediaType, base64Data)
	if err != nil {
		utils.LogWithFields(utils.LevelError, "backend.runloop", "provider image save failed; skipping image", map[string]any{
			"run_id":    run.requestID,
			"mediaType": mediaType,
			"error":     utils.ErrStr(err),
		})
		return ""
	}
	utils.LogWithFields(utils.LevelInfo, "backend.runloop", "provider image saved", map[string]any{
		"run_id":    run.requestID,
		"mediaType": mediaType,
		"path":      path,
	})
	return path
}
