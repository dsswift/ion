package normalizer

import (
	"encoding/json"
	"testing"
)

// The delegated CLI's stream-json lines in the mix a run produces: many text
// deltas, an assistant message with a tool call, and the final result.
var benchLines = []json.RawMessage{
	json.RawMessage(`{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hello world, here is some streamed text"}}}`),
	json.RawMessage(`{"type":"assistant","message":{"id":"msg_1","role":"assistant","model":"m","content":[{"type":"text","text":"Reading the file."},{"type":"tool_use","id":"toolu_1","name":"Read","input":{"file_path":"/repo/main.go"}}],"usage":{"input_tokens":1200,"output_tokens":40}}}`),
	json.RawMessage(`{"type":"result","subtype":"success","result":"done","duration_ms":1200,"num_turns":2,"total_cost_usd":0.012,"usage":{"input_tokens":1200,"output_tokens":80}}`),
}

func BenchmarkNormalize(b *testing.B) {
	for _, line := range benchLines {
		if len(Normalize(line)) == 0 {
			b.Fatalf("fixture produced no events: %s", line)
		}
	}
	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		for _, line := range benchLines {
			Normalize(line)
		}
	}
}
