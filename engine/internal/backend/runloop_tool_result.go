package backend

// Tool-result emission — the last step of a tool's per-goroutine lifecycle.
//
// Split from runloop_tools.go at the file-size cap, on the seam where the tool's
// OUTCOME stops being computed and starts being published. Everything upstream
// in that file decides what the result IS (permission, containment, sandbox,
// hooks, execution, plan-mode gates); this is the one place that turns a
// finished result into the events consumers render.
//
// ── Images are saved, never inlined ─────────────────────────────────────────
// A tool that returns vision images has its bytes written to the conversation's
// images/ directory, and both the ToolResultEvent and the per-image
// ImageContentEvent carry the FILE PATH. Base64 on the wire would balloon every
// consumer's event log and force each one to re-derive a file it cannot cache.
// The engine is a pass-through here: it saves and forwards, and never generates.

import "github.com/dsswift/ion/engine/internal/types"

// emitToolResult publishes one finished tool result: the ToolResultEvent, plus
// an ImageContentEvent per saved image.
//
// Takes the already-committed result rather than recomputing anything, so the
// events cannot disagree with what the caller recorded in `results[i]`.
func (b *ApiBackend) emitToolResult(
	run *activeRun,
	toolID string,
	result *toolResultPayload,
) {
	var resultImages []types.ToolResultImage
	if len(result.Images) > 0 {
		resultImages = b.saveToolResultImages(run, toolID, result.Images)
	}
	b.emit(run, types.NormalizedEvent{Data: &types.ToolResultEvent{
		ToolID:  toolID,
		Content: result.Content,
		IsError: result.IsError,
		Images:  resultImages,
	}})
	for _, img := range resultImages {
		b.emit(run, types.NormalizedEvent{Data: &types.ImageContentEvent{
			Path:      img.Path,
			MediaType: img.MediaType,
			Source:    "tool",
			ToolID:    toolID,
		}})
	}
}

// toolResultPayload is the subset of a recorded tool result this emission needs.
// Structural rather than the full conversation entry: emission has no business
// reading the tool-use id or any persistence field, and narrowing the input is
// what keeps the two from drifting into a second source of truth.
type toolResultPayload struct {
	Content string
	IsError bool
	Images  []*types.ImageSource
}
