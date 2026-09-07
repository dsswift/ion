package seed

import (
	"testing"

	"github.com/dsswift/ion/samples/conversation-pipeline/internal/stream"
)

// TestScriptShape pins what the demo narrates: seven events with seq 1..7,
// exactly one segmented event whose parts reassemble to the original.
func TestScriptShape(t *testing.T) {
	s := New("c1", "user@example.com", 2*1024*1024)
	steps := s.Steps()
	if len(steps) != 7 {
		t.Fatalf("got %d steps, want 7", len(steps))
	}
	segmented := 0
	for i, envelopes := range steps {
		if envelopes[0].Seq() != int64(i+1) {
			t.Errorf("step %d seq = %d", i, envelopes[0].Seq())
		}
		if _, ok := envelopes[0].SegmentInfo(); ok {
			segmented++
			events, err := stream.Reassemble(envelopes)
			if err != nil || len(events) != 1 || !events[0].Verified {
				t.Fatalf("segmented step %d did not reassemble cleanly: %v", i, err)
			}
			if len(envelopes) < 3 {
				t.Errorf("a 2 MiB output should need more than %d parts", len(envelopes))
			}
		}
	}
	if segmented != 1 {
		t.Fatalf("segmented steps = %d, want 1", segmented)
	}
}

// TestMessagesExceedEvents pins that the script's segmented event turns
// seven events into more than seven hub messages, which is what makes the
// demo's "events became messages" line and its scrambled delivery mean
// something.
func TestMessagesExceedEvents(t *testing.T) {
	s := New("c1", "user@example.com", 2*1024*1024)
	total := 0
	for _, envelopes := range s.Steps() {
		total += len(envelopes)
	}
	if total <= 7 {
		t.Fatalf("expected the segmented event to raise the message count above 7, got %d", total)
	}
}
