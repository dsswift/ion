package extcontext

import (
	"strings"
	"testing"

	"github.com/dsswift/ion/engine/internal/extension"
)

func TestFormatDispatchUsageSuffix(t *testing.T) {
	t.Run("nil result", func(t *testing.T) {
		if got := FormatDispatchUsageSuffix(nil); got != "" {
			t.Errorf("nil result should format to empty string, got %q", got)
		}
	})

	t.Run("zero-value result still carries core counts", func(t *testing.T) {
		got := FormatDispatchUsageSuffix(&extension.DispatchAgentResult{})
		want := "\n\n<usage>input_tokens=0 output_tokens=0</usage>"
		if got != want {
			t.Errorf("got %q want %q", got, want)
		}
	})

	t.Run("populated fields", func(t *testing.T) {
		got := FormatDispatchUsageSuffix(&extension.DispatchAgentResult{
			InputTokens:              1200,
			OutputTokens:             340,
			CacheReadInputTokens:     900,
			CacheCreationInputTokens: 50,
			ThinkingTokens:           80,
			Cost:                     0.0123,
			Elapsed:                  12.34,
			DispatchID:               "dsp-abc123",
		})
		for _, want := range []string{
			"<usage>",
			"input_tokens=1200",
			"output_tokens=340",
			"cache_read_input_tokens=900",
			"cache_creation_input_tokens=50",
			"thinking_tokens=80",
			"cost_usd=0.0123",
			"elapsed_s=12.3",
			"dispatch_id=dsp-abc123",
			"</usage>",
		} {
			if !strings.Contains(got, want) {
				t.Errorf("suffix missing %q: %q", want, got)
			}
		}
		if !strings.HasPrefix(got, "\n\n<usage>") {
			t.Errorf("suffix must start with blank-line separator: %q", got)
		}
	})

	t.Run("optional fields omitted when zero", func(t *testing.T) {
		got := FormatDispatchUsageSuffix(&extension.DispatchAgentResult{InputTokens: 10, OutputTokens: 5})
		for _, absent := range []string{"cache_read", "cache_creation", "thinking_tokens", "cost_usd", "elapsed_s", "dispatch_id"} {
			if strings.Contains(got, absent) {
				t.Errorf("zero-valued optional field %q must be omitted: %q", absent, got)
			}
		}
	})
}
