package stream

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"strings"
	"testing"
	"unicode/utf8"
)

func part(id string, ts string, i, n int, chunk, total string) Envelope {
	sum := sha256.Sum256([]byte(total))
	return Envelope{
		Name: "conversation.tool_call", Ts: ts, EventID: id,
		Payload: map[string]any{
			"conversation_id": "c1", "tool_name": "Bash", "output": chunk,
			"segment": map[string]any{"part": float64(i), "parts": float64(n), "field": "/output", "total_bytes": float64(len(total)), "sha256": hex.EncodeToString(sum[:])},
		},
	}
}

func TestReassemble_OrdersDedupesAndVerifies(t *testing.T) {
	total := strings.Repeat("abc", 100)
	envelopes := []Envelope{
		{Name: "conversation.user_message", Ts: "2026-09-06T12:00:00.5Z", EventID: "u1", Payload: map[string]any{"conversation_id": "c1", "text": "hi"}},
		part("t1", "2026-09-06T12:00:00.53Z", 2, 3, total[100:200], total),
		part("t1", "2026-09-06T12:00:00.53Z", 1, 3, total[:100], total),
		part("t1", "2026-09-06T12:00:00.53Z", 3, 3, total[200:], total),
		part("t1", "2026-09-06T12:00:00.53Z", 3, 3, total[200:], total), // redelivered
		{Name: "conversation.user_message", Ts: "2026-09-06T12:00:00.5Z", EventID: "u1", Payload: map[string]any{"conversation_id": "c1", "text": "hi"}},
	}
	events, err := Reassemble(envelopes)
	if err != nil {
		t.Fatal(err)
	}
	if len(events) != 2 {
		t.Fatalf("got %d events, want 2 after dedup and reassembly", len(events))
	}
	// "…00.5Z" is EARLIER than "…00.53Z" as a timestamp although later as a string.
	if events[0].EventID != "u1" || events[1].EventID != "t1" {
		t.Fatalf("order = %s,%s; want u1 then t1 (timestamp order, not string order)", events[0].EventID, events[1].EventID)
	}
	tc := events[1]
	if tc.Parts != 3 || !tc.Verified || tc.Payload["output"] != total || tc.Payload["segment"] != nil {
		t.Fatalf("reassembled event = parts %d verified %v problem %q", tc.Parts, tc.Verified, tc.Problem)
	}
}

func TestReassemble_ReportsMissingPart(t *testing.T) {
	total := strings.Repeat("xyz", 50)
	events, err := Reassemble([]Envelope{
		part("t1", "2026-09-06T12:00:00Z", 1, 2, total[:75], total),
	})
	if err != nil || len(events) != 1 || events[0].Verified || !strings.Contains(events[0].Problem, "missing parts [2]") {
		t.Fatalf("events=%+v err=%v", events, err)
	}
}

func TestSortKeyIsZeroPaddedNanos(t *testing.T) {
	k, err := (Envelope{Ts: "2026-09-06T12:00:00.5Z"}).SortKey()
	if err != nil || len(k) != 19+1+12 {
		t.Fatalf("key %q err %v", k, err)
	}
	k2, _ := (Envelope{Ts: "2026-09-06T12:00:00.53Z"}).SortKey()
	if !(k < k2) {
		t.Fatalf("%s should sort before %s", k, k2)
	}
}

func TestDocumentID(t *testing.T) {
	if id := part("e", "2026-09-06T12:00:00Z", 2, 3, "", "").DocumentID(); id != "e:2" {
		t.Fatalf("segment DocumentID = %q", id)
	}
	if id := (Envelope{EventID: "e"}).DocumentID(); id != "e" {
		t.Fatalf("plain DocumentID = %q", id)
	}
	_ = fmt.Sprintf
}

// TestSplitFieldRoundTripsThroughReassemble pins the sample's splitter to the
// consumer's reassembly: what Segment produces, Reassemble folds back to
// the original, verified, on awkward multi-byte content.
func TestSplitFieldRoundTripsThroughReassemble(t *testing.T) {
	text := strings.Repeat("日本語 and emoji 🚀 with \"quotes\" and \\ backslashes\n", 400)
	e := Envelope{Name: "conversation.tool_call", Ts: "2026-09-06T12:00:00.5Z", EventID: "big",
		Payload: map[string]any{"conversation_id": "c1", "seq": float64(3), "tool_name": "Bash", "output": text}}
	parts, err := SplitField(e, "/output", 1000)
	if err != nil {
		t.Fatal(err)
	}
	if len(parts) < 20 {
		t.Fatalf("got %d parts, want many", len(parts))
	}
	for i, p := range parts {
		if out, _ := p.Payload["output"].(string); !utf8.ValidString(out) {
			t.Fatalf("part %d tore a rune", i)
		}
	}
	events, err := Reassemble(parts)
	if err != nil || len(events) != 1 || !events[0].Verified || events[0].Payload["output"] != text {
		t.Fatalf("round trip failed: err=%v events=%d", err, len(events))
	}
	if events[0].Seq() != 3 {
		t.Fatalf("seq lost in reassembly: %d", events[0].Seq())
	}
}

func TestSortKeyBreaksTiesWithSeq(t *testing.T) {
	a, _ := (Envelope{Ts: "2026-09-06T12:00:00Z", Payload: map[string]any{"seq": float64(2)}}).SortKey()
	b, _ := (Envelope{Ts: "2026-09-06T12:00:00Z", Payload: map[string]any{"seq": float64(10)}}).SortKey()
	if !(a < b) {
		t.Fatalf("%s should sort before %s", a, b)
	}
}

// TestReassembleFromScrambledDelivery pins the ordering contract end to
// end: a whole conversation delivered in a scrambled order, parts included
// and one message twice, folds back to seq order with the segmented event
// whole and verified.
func TestReassembleFromScrambledDelivery(t *testing.T) {
	big := strings.Repeat("0123456789日本語🚀\n", 3000)
	var delivered []Envelope
	mk := func(seq int, name string, payload map[string]any) Envelope {
		payload["conversation_id"] = "c1"
		payload["seq"] = float64(seq)
		return Envelope{Name: name, Ts: fmt.Sprintf("2026-09-06T12:00:00.%09dZ", seq), EventID: fmt.Sprintf("e%d", seq), Payload: payload}
	}
	delivered = append(delivered, mk(1, "conversation.lifecycle", map[string]any{"action": "created"}))
	delivered = append(delivered, mk(2, "conversation.user_message", map[string]any{"text": "hi"}))
	parts, err := SplitField(mk(3, "conversation.tool_call", map[string]any{"tool_name": "Bash", "output": big}), "/output", 7000)
	if err != nil {
		t.Fatal(err)
	}
	delivered = append(delivered, parts...)
	delivered = append(delivered, mk(4, "conversation.assistant_message", map[string]any{"text": "done"}))
	delivered = append(delivered, delivered[1]) // redelivery
	// Deterministic scramble: reverse, then swap pairs.
	for i, j := 0, len(delivered)-1; i < j; i, j = i+1, j-1 {
		delivered[i], delivered[j] = delivered[j], delivered[i]
	}
	for i := 0; i+1 < len(delivered); i += 2 {
		delivered[i], delivered[i+1] = delivered[i+1], delivered[i]
	}
	events, err := Reassemble(delivered)
	if err != nil {
		t.Fatal(err)
	}
	if len(events) != 4 {
		t.Fatalf("got %d events, want 4 (redelivery collapsed)", len(events))
	}
	for i, ev := range events {
		if ev.Seq() != int64(i+1) {
			t.Fatalf("event %d has seq %d; delivery order leaked into the reconstruction", i, ev.Seq())
		}
	}
	if tc := events[2]; tc.Parts != len(parts) || !tc.Verified || tc.Payload["output"] != big {
		t.Fatalf("segmented event did not come back whole from scrambled parts: parts=%d verified=%v", tc.Parts, tc.Verified)
	}
}
