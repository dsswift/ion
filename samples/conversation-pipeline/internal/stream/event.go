// Package stream is the consumer-side view of Ion's conversation.* event
// stream: the envelope as published in
// docs/observability/conversation-events.schema.json, the ordering rule, and
// segment reassembly. Every program in this sample reads events through it so
// the three stores (Event Hub, Cosmos DB, blob) agree on what an event is.
package stream

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"sort"
	"strings"
	"time"
	"unicode/utf8"
)

// Envelope is one delivered event, or one part of a segmented event. Fields
// the pipeline reads are typed; everything else rides in Raw so nothing the
// engine emits is dropped on the way to storage.
type Envelope struct {
	Name         string         `json:"name"`
	Ts           string         `json:"ts"`
	Schema       int            `json:"schema"`
	Component    string         `json:"component"`
	InstallID    string         `json:"install_id,omitempty"`
	Host         string         `json:"host,omitempty"`
	Version      string         `json:"version,omitempty"`
	EventID      string         `json:"event_id"`
	User         string         `json:"user,omitempty"`
	TraceID      string         `json:"trace_id"`
	ParentSpanID string         `json:"parent_span_id"`
	Context      map[string]any `json:"context,omitempty"`
	Payload      map[string]any `json:"payload"`
}

// Segment is the payload.segment block on a part of a segmented event.
type Segment struct {
	Part       int    `json:"part"`
	Parts      int    `json:"parts"`
	Field      string `json:"field"`
	TotalBytes int    `json:"total_bytes"`
	SHA256     string `json:"sha256"`
}

// Parse decodes one event body.
func Parse(body []byte) (Envelope, error) {
	var e Envelope
	if err := json.Unmarshal(body, &e); err != nil {
		return Envelope{}, fmt.Errorf("event body: %w", err)
	}
	if e.EventID == "" || e.Name == "" {
		return Envelope{}, fmt.Errorf("event body has no event_id or name")
	}
	return e, nil
}

// ConversationID is the conversation an envelope belongs to. The payload
// carries it on every conversation.* event; the context mirrors it.
func (e Envelope) ConversationID() string {
	if v, ok := e.Payload["conversation_id"].(string); ok && v != "" {
		return v
	}
	if v, ok := e.Context["conversation_id"].(string); ok {
		return v
	}
	return ""
}

// SegmentInfo returns the segment block when the envelope is a part.
func (e Envelope) SegmentInfo() (Segment, bool) {
	raw, ok := e.Payload["segment"].(map[string]any)
	if !ok {
		return Segment{}, false
	}
	b, err := json.Marshal(raw)
	if err != nil {
		return Segment{}, false
	}
	var s Segment
	if err := json.Unmarshal(b, &s); err != nil || s.Parts < 1 {
		return Segment{}, false
	}
	return s, true
}

// DocumentID is the identity a store keys one delivered message on: the
// event_id alone, or event_id plus part for a segment. It is what makes a
// redelivery from the engine's retry queue an idempotent upsert.
func (e Envelope) DocumentID() string {
	if s, ok := e.SegmentInfo(); ok {
		return fmt.Sprintf("%s:%d", e.EventID, s.Part)
	}
	return e.EventID
}

// Seq is the engine's per-conversation sequence number for the envelope,
// 0 when the event predates the field. Every part of a segmented event
// carries the same seq.
func (e Envelope) Seq() int64 {
	switch v := e.Payload["seq"].(type) {
	case float64:
		return int64(v)
	case int64:
		return v
	case int:
		return int64(v)
	}
	return 0
}

// SortKey is the ordering key for an envelope: nanoseconds since the epoch
// as a zero-padded 19-digit string, then the seq as a zero-padded 12-digit
// string, so the published order (ts, then seq) holds as plain string order
// in any store. The raw ts must never be compared as a string — RFC3339Nano
// trims trailing zeros, so "06.5Z" sorts after "06.53Z".
func (e Envelope) SortKey() (string, error) {
	t, err := time.Parse(time.RFC3339Nano, e.Ts)
	if err != nil {
		return "", fmt.Errorf("ts %q: %w", e.Ts, err)
	}
	return fmt.Sprintf("%019d-%012d", t.UnixNano(), e.Seq()), nil
}

// Event is one logical event after reassembly: a plain envelope, or the
// parts of a segmented event folded back into one with the split field
// restored and its integrity checked.
type Event struct {
	Envelope
	SortKey string
	// Parts is how many delivered messages this event came from (1 when it
	// was never segmented). Verified is true when the reassembled field
	// matched the sha256 and length the parts declared.
	Parts    int
	Verified bool
	Problem  string
}

// Reassemble folds a set of delivered envelopes into ordered logical events.
// Duplicates (the same DocumentID delivered twice) collapse to one. A
// segmented event with parts missing is returned with Problem set rather
// than dropped, so a gap is visible instead of silent.
func Reassemble(envelopes []Envelope) ([]Event, error) {
	byDoc := map[string]Envelope{}
	for _, e := range envelopes {
		byDoc[e.DocumentID()] = e
	}
	groups := map[string][]Envelope{}
	for _, e := range byDoc {
		groups[e.EventID] = append(groups[e.EventID], e)
	}
	var out []Event
	for _, parts := range groups {
		ev, err := fold(parts)
		if err != nil {
			return nil, err
		}
		out = append(out, ev)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].SortKey < out[j].SortKey })
	return out, nil
}

func fold(parts []Envelope) (Event, error) {
	first := parts[0]
	key, err := first.SortKey()
	if err != nil {
		return Event{}, err
	}
	seg, segmented := first.SegmentInfo()
	if !segmented {
		if len(parts) != 1 {
			return Event{}, fmt.Errorf("event %s: %d envelopes share an event_id without a segment block", first.EventID, len(parts))
		}
		return Event{Envelope: first, SortKey: key, Parts: 1, Verified: true}, nil
	}
	sort.Slice(parts, func(i, j int) bool {
		a, _ := parts[i].SegmentInfo()
		b, _ := parts[j].SegmentInfo()
		return a.Part < b.Part
	})
	var joined strings.Builder
	have := map[int]bool{}
	for _, p := range parts {
		s, _ := p.SegmentInfo()
		have[s.Part] = true
		v, _ := lookupPointer(p.Payload, s.Field).(string)
		joined.WriteString(v)
	}
	ev := Event{Envelope: first, SortKey: key, Parts: len(parts)}
	ev.Payload = clonePayload(first.Payload)
	delete(ev.Payload, "segment")
	setPointer(ev.Payload, seg.Field, joined.String())
	var missing []int
	for i := 1; i <= seg.Parts; i++ {
		if !have[i] {
			missing = append(missing, i)
		}
	}
	sum := sha256.Sum256([]byte(joined.String()))
	switch {
	case len(missing) > 0:
		ev.Problem = fmt.Sprintf("missing parts %v of %d", missing, seg.Parts)
	case joined.Len() != seg.TotalBytes:
		ev.Problem = fmt.Sprintf("reassembled %d bytes, parts declared %d", joined.Len(), seg.TotalBytes)
	case hex.EncodeToString(sum[:]) != seg.SHA256:
		ev.Problem = "reassembled field sha256 does not match the parts' declaration"
	default:
		ev.Verified = true
	}
	return ev, nil
}

func clonePayload(p map[string]any) map[string]any {
	out := make(map[string]any, len(p))
	for k, v := range p {
		out[k] = v
	}
	return out
}

func unescape(s string) string {
	return strings.ReplaceAll(strings.ReplaceAll(s, "~1", "/"), "~0", "~")
}

func lookupPointer(payload map[string]any, pointer string) any {
	var node any = payload
	for _, tok := range strings.Split(strings.TrimPrefix(pointer, "/"), "/") {
		m, ok := node.(map[string]any)
		if !ok {
			return nil
		}
		node = m[unescape(tok)]
	}
	return node
}

// setPointer writes value at pointer, copying the containers along the path
// so the caller's other references to the payload are untouched.
func setPointer(payload map[string]any, pointer string, value string) {
	toks := strings.Split(strings.TrimPrefix(pointer, "/"), "/")
	node := payload
	for i, tok := range toks {
		key := unescape(tok)
		if i == len(toks)-1 {
			node[key] = value
			return
		}
		child, _ := node[key].(map[string]any)
		copied := clonePayload(child)
		node[key] = copied
		node = copied
	}
}

// SplitField splits the string at pointer across parts whose field is at most
// chunkBytes long, producing the same shape the engine emits under its
// "segment" oversize policy: every part shares the envelope, and a segment
// block names the field, its total length, and its sha256. It exists so a
// consumer can build test fixtures (and this sample can seed a stream)
// without an engine; it is the inverse of Reassemble and is pinned to it by
// the tests. Cuts land on rune boundaries.
func SplitField(e Envelope, pointer string, chunkBytes int) ([]Envelope, error) {
	value, ok := lookupPointer(e.Payload, pointer).(string)
	if !ok {
		return nil, fmt.Errorf("split: %q is not a string field", pointer)
	}
	if chunkBytes < 1 {
		return nil, fmt.Errorf("split: chunk size must be positive")
	}
	sum := sha256.Sum256([]byte(value))
	var chunks []string
	for i := 0; i < len(value); {
		end := i + chunkBytes
		if end >= len(value) {
			end = len(value)
		} else {
			for end > i+1 && !utf8.RuneStart(value[end]) {
				end--
			}
		}
		chunks = append(chunks, value[i:end])
		i = end
	}
	if len(chunks) == 0 {
		chunks = []string{""}
	}
	parts := make([]Envelope, 0, len(chunks))
	for i, chunk := range chunks {
		p := e
		p.Payload = clonePayload(e.Payload)
		setPointer(p.Payload, pointer, chunk)
		p.Payload["segment"] = map[string]any{
			"part": i + 1, "parts": len(chunks), "field": pointer,
			"total_bytes": len(value), "sha256": hex.EncodeToString(sum[:]),
		}
		parts = append(parts, p)
	}
	return parts, nil
}

// Summary is a one-line rendering of an event for a transcript listing.
func (ev Event) Summary(width int) string {
	var text string
	switch ev.Name {
	case "conversation.user_message", "conversation.assistant_message":
		text, _ = ev.Payload["text"].(string)
	case "conversation.tool_call":
		name, _ := ev.Payload["tool_name"].(string)
		outcome, _ := ev.Payload["outcome"].(string)
		out, _ := ev.Payload["output"].(string)
		text = fmt.Sprintf("%s [%s] -> %d bytes of output", name, outcome, len(out))
	case "conversation.lifecycle":
		text, _ = ev.Payload["action"].(string)
	}
	text = strings.ReplaceAll(text, "\n", " ")
	if width > 0 && len(text) > width {
		text = text[:width-1] + "…"
	}
	return text
}
