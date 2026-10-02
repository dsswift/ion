package types

import "testing"

// TestLlmUsageMergeInputDelta pins the message_delta merge rule: a non-zero
// input-side counter replaces the held one, a zero counter leaves it alone,
// and output tokens are never touched.
func TestLlmUsageMergeInputDelta(t *testing.T) {
	cases := []struct {
		name  string
		start LlmUsage
		delta *LlmUsage
		want  LlmUsage
	}{
		{
			name:  "usage reported only at the end of the stream",
			start: LlmUsage{},
			delta: &LlmUsage{InputTokens: 40, CacheReadInputTokens: 60, CacheCreationInputTokens: 5, OutputTokens: 9},
			want:  LlmUsage{InputTokens: 40, CacheReadInputTokens: 60, CacheCreationInputTokens: 5},
		},
		{
			name:  "output-only delta keeps the message_start input counts",
			start: LlmUsage{InputTokens: 100, CacheReadInputTokens: 20, OutputTokens: 1},
			delta: &LlmUsage{OutputTokens: 9},
			want:  LlmUsage{InputTokens: 100, CacheReadInputTokens: 20, OutputTokens: 1},
		},
		{
			name:  "fully cached prompt keeps a zero uncached count",
			start: LlmUsage{},
			delta: &LlmUsage{CacheReadInputTokens: 500},
			want:  LlmUsage{CacheReadInputTokens: 500},
		},
		{
			name:  "nil delta is a no-op",
			start: LlmUsage{InputTokens: 7},
			delta: nil,
			want:  LlmUsage{InputTokens: 7},
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := tc.start
			got.MergeInputDelta(tc.delta)
			if got != tc.want {
				t.Errorf("got %+v, want %+v", got, tc.want)
			}
		})
	}
}
