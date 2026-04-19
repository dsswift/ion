package session

import "testing"

func TestPromptQueueing(t *testing.T) {
	// Test that pendingPrompt struct works
	p := pendingPrompt{text: "hello"}
	if p.text != "hello" {
		t.Errorf("expected 'hello', got %q", p.text)
	}
}
