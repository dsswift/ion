package providers

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"strings"
)

// MockProviderID is the provider id the scripted mock registers under. A
// "mock" entry in engine.json's providers map selects it; its scenarioFile
// field names the script.
const MockProviderID = "mock"

// MockDefaultModel is the one model the mock provider registers. It is
// provider-qualified so it can never shadow a real provider's bare model id.
const MockDefaultModel = "mock/default"

// MockScenario scripts the mock provider. The JSON shape is the `provider`
// block of a perf scenario file (scripts/perf/scenarios/*.json), written
// verbatim to the file engine.json's providers.mock.scenarioFile names.
type MockScenario struct {
	// Seed fixes everything the mock derives rather than reads from the
	// script: the words it streams and the tool-use ids it mints. The same
	// seed, turn, and request produce a byte-identical event stream.
	Seed int64 `json:"seed"`
	// Turns are scripted per conversation. A request's turn index is the
	// number of assistant messages already in its history, so the first
	// provider call of every conversation plays Turns[0] no matter how many
	// conversations stream at once.
	Turns []MockTurn `json:"turns"`
	// Repeat cycles Turns once the index runs past the end. False holds the
	// last turn for every later index.
	Repeat bool `json:"repeat"`
}

// MockTurn is one provider call's script.
type MockTurn struct {
	// TTFTMs is the delay before the first stream event (message_start).
	TTFTMs int `json:"ttft_ms"`
	// Tokens is the number of text tokens streamed, one content_block_delta
	// each. Zero streams no text block.
	Tokens int `json:"tokens"`
	// TokensPerSecond paces the text deltas. Zero streams them back to back.
	TokensPerSecond float64 `json:"tokens_per_s"`
	// ToolCalls are emitted as tool_use blocks after the text, in order. A
	// turn with any ends with stop_reason "tool_use", so the run loop
	// executes them and calls the provider again for the next turn.
	ToolCalls []MockToolCall `json:"tool_calls"`
}

// MockToolCall is one scripted tool_use block.
type MockToolCall struct {
	Name string `json:"name"`
	// Input is the tool input object. Absent means {}.
	Input map[string]any `json:"input,omitempty"`
}

// LoadMockScenario reads and validates a scenario file. Unknown fields are
// refused so a misspelled key fails at load instead of silently scripting a
// zero.
func LoadMockScenario(path string) (*MockScenario, error) {
	if strings.TrimSpace(path) == "" {
		return nil, fmt.Errorf("mock provider: scenarioFile is empty")
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("mock provider: read scenario %s: %w", path, err)
	}
	return ParseMockScenario(data)
}

// ParseMockScenario decodes and validates scenario JSON.
func ParseMockScenario(data []byte) (*MockScenario, error) {
	dec := json.NewDecoder(bytes.NewReader(data))
	dec.DisallowUnknownFields()
	var s MockScenario
	if err := dec.Decode(&s); err != nil {
		return nil, fmt.Errorf("mock provider: parse scenario: %w", err)
	}
	if err := s.validate(); err != nil {
		return nil, err
	}
	return &s, nil
}

func (s *MockScenario) validate() error {
	if len(s.Turns) == 0 {
		return fmt.Errorf("mock provider: scenario has no turns")
	}
	for i, t := range s.Turns {
		if t.TTFTMs < 0 {
			return fmt.Errorf("mock provider: turn %d: ttft_ms %d is negative", i, t.TTFTMs)
		}
		if t.Tokens < 0 {
			return fmt.Errorf("mock provider: turn %d: tokens %d is negative", i, t.Tokens)
		}
		if t.TokensPerSecond < 0 {
			return fmt.Errorf("mock provider: turn %d: tokens_per_s %g is negative", i, t.TokensPerSecond)
		}
		for j, c := range t.ToolCalls {
			if strings.TrimSpace(c.Name) == "" {
				return fmt.Errorf("mock provider: turn %d: tool_calls[%d] has no name", i, j)
			}
		}
	}
	return nil
}

// turnFor maps a turn index onto the script: cycling when Repeat is set,
// otherwise holding the last turn.
func (s *MockScenario) turnFor(index int) MockTurn {
	n := len(s.Turns)
	if index < n {
		return s.Turns[index]
	}
	if s.Repeat {
		return s.Turns[index%n]
	}
	return s.Turns[n-1]
}
