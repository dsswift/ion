package mcp

import (
	"context"
	"log/slog"

	"github.com/dsswift/ion/engine/internal/utils"
)

// newSDKLogger bridges third-party protocol diagnostics into Ion's canonical
// JSONL logger. SDK handlers cannot know Ion's session identity, so serverName
// remains the stable correlation field.
func newSDKLogger(serverName string) *slog.Logger {
	return slog.New(sdkLogHandler{serverName: serverName})
}

type sdkLogHandler struct {
	serverName string
	attrs      []slog.Attr
}

func (h sdkLogHandler) Enabled(_ context.Context, _ slog.Level) bool { return true }

func (h sdkLogHandler) Handle(_ context.Context, record slog.Record) error {
	fields := map[string]any{"serverName": h.serverName}
	for _, attr := range h.attrs {
		fields[attr.Key] = attr.Value.Any()
	}
	record.Attrs(func(attr slog.Attr) bool {
		fields[attr.Key] = attr.Value.Any()
		return true
	})
	utils.LogWithFields(sdkLogLevel(record.Level), "mcp.sdk", record.Message, fields)
	return nil
}

func (h sdkLogHandler) WithAttrs(attrs []slog.Attr) slog.Handler {
	next := h
	next.attrs = append(append([]slog.Attr(nil), h.attrs...), attrs...)
	return next
}

func (h sdkLogHandler) WithGroup(_ string) slog.Handler { return h }

func sdkLogLevel(level slog.Level) utils.LogLevel {
	switch {
	case level >= slog.LevelError:
		return utils.LevelError
	case level >= slog.LevelWarn:
		return utils.LevelWarn
	case level <= slog.LevelDebug:
		return utils.LevelDebug
	default:
		return utils.LevelInfo
	}
}
