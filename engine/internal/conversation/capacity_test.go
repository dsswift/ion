package conversation

import (
	"testing"

	"github.com/dsswift/ion/engine/internal/types"
)

func TestResolveModelContextCapacity(t *testing.T) {
	model := &types.ModelInfo{MaxOutputTokens: 32_000}
	cases := []struct {
		name      string
		maxTokens int
		model     *types.ModelInfo
		want      int
	}{
		{"explicit output reserve wins", 16_000, model, 171_000},
		{"model output reserve is next", 0, model, 155_000},
		{"default output reserve is last", 0, nil, 167_000},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := ResolveModelContextCapacity(200_000, tc.maxTokens, tc.model)
			if got.EffectiveLimit != tc.want {
				t.Fatalf("EffectiveLimit = %d, want %d", got.EffectiveLimit, tc.want)
			}
		})
	}
}

func TestContextCapacityWarningLimit(t *testing.T) {
	capacity := ResolveContextCapacity(100_000, 0, 0, DefaultCompactSummaryReserve)
	if got, want := capacity.WarningLimit(), capacity.EffectiveLimit*80/100; got != want {
		t.Fatalf("WarningLimit = %d, want %d", got, want)
	}
}
