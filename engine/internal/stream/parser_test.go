package stream

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestParserNext(t *testing.T) {
	tests := []struct {
		name     string
		input    string
		wantMsgs []string // expected raw JSON strings
	}{
		{
			name:     "single object",
			input:    `{"type":"message"}` + "\n",
			wantMsgs: []string{`{"type":"message"}`},
		},
		{
			name:     "multiple objects",
			input:    `{"a":1}` + "\n" + `{"b":2}` + "\n",
			wantMsgs: []string{`{"a":1}`, `{"b":2}`},
		},
		{
			name:     "skip empty lines",
			input:    "\n" + `{"a":1}` + "\n\n" + `{"b":2}` + "\n",
			wantMsgs: []string{`{"a":1}`, `{"b":2}`},
		},
		{
			name:     "skip invalid json",
			input:    "not json\n" + `{"valid":true}` + "\n" + "also bad\n",
			wantMsgs: []string{`{"valid":true}`},
		},
		{
			name:     "whitespace-only lines skipped",
			input:    "   \n\t\n" + `{"x":1}` + "\n",
			wantMsgs: []string{`{"x":1}`},
		},
		{
			name:     "trailing whitespace trimmed",
			input:    `{"x":1}` + "  \n",
			wantMsgs: []string{`{"x":1}`},
		},
		{
			name:     "empty input",
			input:    "",
			wantMsgs: nil,
		},
		{
			name:     "no trailing newline",
			input:    `{"last":true}`,
			wantMsgs: []string{`{"last":true}`},
		},
		{
			name:     "array line",
			input:    `[1,2,3]` + "\n",
			wantMsgs: []string{`[1,2,3]`},
		},
		{
			name:     "string value line",
			input:    `"hello"` + "\n",
			wantMsgs: []string{`"hello"`},
		},
		{
			name:     "nested objects",
			input:    `{"event":{"type":"text","data":"hi"}}` + "\n",
			wantMsgs: []string{`{"event":{"type":"text","data":"hi"}}`},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			p := NewParser(strings.NewReader(tt.input))
			var got []string
			for {
				msg, ok := p.Next()
				if !ok {
					break
				}
				got = append(got, string(msg))
			}
			if err := p.Err(); err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if len(got) != len(tt.wantMsgs) {
				t.Fatalf("got %d messages, want %d\ngot: %v", len(got), len(tt.wantMsgs), got)
			}
			for i := range got {
				if got[i] != tt.wantMsgs[i] {
					t.Errorf("message[%d] = %q, want %q", i, got[i], tt.wantMsgs[i])
				}
			}
		})
	}
}

func TestParserOutputIsValidJSON(t *testing.T) {
	input := `{"type":"start","id":1}` + "\n" + `{"type":"end","id":2}` + "\n"
	p := NewParser(strings.NewReader(input))

	for {
		msg, ok := p.Next()
		if !ok {
			break
		}
		var obj map[string]any
		if err := json.Unmarshal(msg, &obj); err != nil {
			t.Errorf("output is not valid JSON: %q, err: %v", string(msg), err)
		}
	}
}

func TestParserOwnsReturnedBytes(t *testing.T) {
	// Verify the returned RawMessage is a copy, not a reference to scanner internals.
	input := `{"first":1}` + "\n" + `{"second":2}` + "\n"
	p := NewParser(strings.NewReader(input))

	first, ok := p.Next()
	if !ok {
		t.Fatal("expected first message")
	}
	firstStr := string(first)

	_, ok = p.Next()
	if !ok {
		t.Fatal("expected second message")
	}

	// first should still be unchanged
	if string(first) != firstStr {
		t.Errorf("first message was mutated: got %q, want %q", string(first), firstStr)
	}
}
