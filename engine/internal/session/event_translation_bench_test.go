package session

import (
	"testing"

	"github.com/dsswift/ion/engine/internal/types"
)

// BenchmarkEventTranslation translates the events of a typical turn (text
// chunks, a tool call and its result, usage) to their wire form.
func BenchmarkEventTranslation(b *testing.B) {
	in, out := 1200, 80
	events := []types.NormalizedEvent{
		{Data: &types.TextChunkEvent{Text: "streamed text chunk"}, TraceID: "4bf92f3577b34da6a3ce929d0e0e4736", SpanID: "00f067aa0ba902b7"},
		{Data: &types.ToolCallEvent{ToolName: "Read", ToolID: "toolu_1"}},
		{Data: &types.ToolResultEvent{ToolID: "toolu_1", Content: "file contents"}},
		{Data: &types.UsageEvent{Usage: types.UsageData{InputTokens: &in, OutputTokens: &out}}},
	}
	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		for _, ev := range events {
			translateToEngineEvent(ev, 200_000)
		}
	}
}
