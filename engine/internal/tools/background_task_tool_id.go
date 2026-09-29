package tools

import "context"

type backgroundToolIDKey struct{}

// WithBackgroundToolID stamps the originating model tool-use ID on a Bash
// execution context. Background task lifecycle events retain this stable link
// so clients can render the active task under its exact transcript tool row.
func WithBackgroundToolID(ctx context.Context, toolID string) context.Context {
	return context.WithValue(ctx, backgroundToolIDKey{}, toolID)
}

// BackgroundToolIDFromContext returns the tool-use ID stamped by
// WithBackgroundToolID, or "" for a call no model tool-use started.
func BackgroundToolIDFromContext(ctx context.Context) string {
	toolID, _ := ctx.Value(backgroundToolIDKey{}).(string) //nolint:errcheck // absent means non-model invocation
	return toolID
}
