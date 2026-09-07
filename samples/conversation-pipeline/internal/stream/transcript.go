package stream

import (
	"fmt"
	"io"
	"strings"
	"time"
)

// transcript.go is the folded form of a conversation: the ordered, reassembled,
// verified events as one object. It is what the archive stores and what the
// transcript command renders from either store.

// Transcript is one conversation, folded.
type Transcript struct {
	ConversationID string `json:"conversation_id"`
	// Source names the store the events were read from: "cosmos" (hot) or
	// "capture" (the record of truth). The archive is always folded from
	// capture; the transcript command may fold from cosmos for display.
	Source   string `json:"source"`
	FoldedAt string `json:"folded_at"`
	User     string `json:"user,omitempty"`
	// Messages is how many delivered messages the events came from; Events
	// is how many logical events they folded to. They differ by the number
	// of extra parts segmented events were delivered as.
	Messages int `json:"messages"`
	Events   int `json:"events"`
	// Segmented counts events that arrived as parts; Problems lists any
	// event whose parts were incomplete or failed verification. A transcript
	// with Problems is still written — a visible gap beats a silent one —
	// and the fold refuses to clear the hot store while any remain.
	Segmented int      `json:"segmented"`
	Problems  []string `json:"problems,omitempty"`
	// Sanitization is where ADR-6002's Tier 2 step records itself. The sample
	// performs none; the field exists so the archive shape already carries
	// the metadata that step will fill in.
	Sanitization map[string]any `json:"sanitization,omitempty"`
	Timeline     []Event        `json:"timeline"`
}

// Fold reassembles envelopes into a Transcript from the named source.
func Fold(conversationID, source string, envelopes []Envelope) (Transcript, error) {
	events, err := Reassemble(envelopes)
	if err != nil {
		return Transcript{}, err
	}
	t := Transcript{
		ConversationID: conversationID, Source: source,
		FoldedAt: time.Now().UTC().Format(time.RFC3339Nano),
		Messages: len(envelopes), Events: len(events), Timeline: events,
		Sanitization: map[string]any{"status": "not-run", "note": "Tier 2 LLM sanitization plugs in here before the archive write (ADR-6002)"},
	}
	for _, ev := range events {
		if t.User == "" {
			t.User = ev.User
		}
		if ev.Parts > 1 {
			t.Segmented++
		}
		if ev.Problem != "" {
			t.Problems = append(t.Problems, fmt.Sprintf("%s (seq %d): %s", ev.EventID, ev.Seq(), ev.Problem))
		}
	}
	return t, nil
}

// Render writes the transcript as a human-readable listing.
func (t Transcript) Render(w io.Writer, width int) {
	fmt.Fprintf(w, "conversation %s\n", t.ConversationID)
	fmt.Fprintf(w, "  source %s  user %q  messages %d  events %d  segmented %d  problems %d\n",
		t.Source, t.User, t.Messages, t.Events, t.Segmented, len(t.Problems))
	if s, ok := t.Sanitization["status"]; ok {
		fmt.Fprintf(w, "  sanitization %v\n", s)
	}
	for _, p := range t.Problems {
		fmt.Fprintf(w, "  PROBLEM %s\n", p)
	}
	fmt.Fprintln(w)
	for i, ev := range t.Timeline {
		ts, _ := time.Parse(time.RFC3339Nano, ev.Ts)
		kind := strings.TrimPrefix(ev.Name, "conversation.")
		extra := ""
		if ev.Parts > 1 {
			mark := "verified"
			if !ev.Verified {
				mark = "UNVERIFIED"
			}
			extra = fmt.Sprintf(" [%d parts, %s]", ev.Parts, mark)
		}
		fmt.Fprintf(w, "[%03d] seq %-4d %s  %-18s %s%s\n", i+1, ev.Seq(), ts.Format("15:04:05.000000"), kind, ev.Summary(width), extra)
	}
}
