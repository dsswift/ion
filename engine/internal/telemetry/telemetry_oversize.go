package telemetry

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/dsswift/ion/engine/internal/utils"
)

// telemetry_oversize.go is the size contract between an event and the
// transport that carries it.
//
// The conversation.* family carries full-fidelity content by design: a tool
// that returns 50 MB of output produces a 50 MB conversation.tool_call, and
// the emitter neither truncates nor redacts it. Every network transport has a
// ceiling, though — Event Hubs negotiates a per-message maximum over the AMQP
// link — and before this file existed the engine simply pushed events at the
// transport and hoped. An event over the ceiling was enqueued for retry,
// failed on every attempt, and held the batch it shared with innocent events
// hostage forever, while the size-based health signal stayed silent because
// one undeliverable batch is small.
//
// So the contract is enforced BEFORE an event enters the retry queue: the
// queue only ever holds messages the transport has agreed it can carry.
// An event over the limit is handled by the configured oversize policy:
//
//   - segment (the default): the largest string field in the payload is
//     split across N events that share the original event_id and carry a
//     "segment" block (part, parts, field, total_bytes, sha256). Nothing is
//     lost; a consumer reassembles by concatenating the field across parts.
//     This needs no second store and works on any transport, which is why
//     it is the least-opinionated default.
//   - quarantine: the event is written whole to a quarantine file beside the
//     retry queue and never sent. It is preserved on disk, not in the
//     stream, and the health signal says so.
//
// Either way an event that cannot be delivered under its policy — the
// envelope alone exceeds the limit, or the payload has no string field to
// split — is quarantined rather than retried, so the queue never contains a
// poison message again.

// oversizePolicy names what happens to an event larger than its transport's
// maximum message size. See the file doc comment.
type oversizePolicy string

const (
	oversizePolicySegment    oversizePolicy = "segment"
	oversizePolicyQuarantine oversizePolicy = "quarantine"
)

// resolveOversizePolicy parses the operator's configured policy. Empty
// selects segment; an unknown value is an error rather than a silent
// default, because a misspelled policy that quietly segmented would be
// indistinguishable from the one the operator asked for.
func resolveOversizePolicy(raw string) (oversizePolicy, error) {
	switch raw {
	case "", string(oversizePolicySegment):
		return oversizePolicySegment, nil
	case string(oversizePolicyQuarantine):
		return oversizePolicyQuarantine, nil
	}
	return "", fmt.Errorf("unknown oversizeEventPolicy %q (want %q or %q)", raw, oversizePolicySegment, oversizePolicyQuarantine)
}

// segmentKey is the payload key carrying segmentMeta on a segmented event.
// It is published in docs/observability/conversation-events.schema.json;
// renaming it is a contract change.
const segmentKey = "segment"

// segmentHeadroomBytes is reserved below the transport's negotiated maximum
// for what the transport wraps around the body — AMQP message annotations,
// properties, and the batch envelope. The SDK counts that framing against the
// limit, the JSON size does not, so an event is only "fitting" when its JSON
// leaves this much room.
const segmentHeadroomBytes = 16 * 1024

// minSegmentChunkBytes is the smallest field chunk worth producing. Below
// this the envelope is consuming nearly the whole budget and the event would
// need thousands of parts; treat it as undeliverable instead.
const minSegmentChunkBytes = 64

// segmentMeta is the block a segmented event carries under segmentKey.
// Field is an RFC 6901 JSON pointer into the payload naming the split field;
// TotalBytes and SHA256 describe the original, unsplit value so a consumer
// can verify its reassembly.
type segmentMeta struct {
	Part       int    `json:"part"`
	Parts      int    `json:"parts"`
	Field      string `json:"field"`
	TotalBytes int    `json:"total_bytes"`
	SHA256     string `json:"sha256"`
}

// rejectedEvent is an event the size contract could not make deliverable.
type rejectedEvent struct {
	Event  Event
	Bytes  int
	Reason string
}

// encodedSize is the JSON size of an event as the sender marshals it.
func encodedSize(e Event) (int, error) {
	body, err := json.Marshal(e)
	if err != nil {
		return 0, err
	}
	return len(body), nil
}

// fitEvents applies the size contract to a batch: every returned fit event
// encodes to at most maxBytes - segmentHeadroomBytes, and every event that
// could not be made to is returned as rejected with the reason. Events are
// returned in their original order, with a segmented event's parts in place
// of the original.
func fitEvents(events []Event, maxBytes int, policy oversizePolicy) (fit []Event, rejected []rejectedEvent) {
	budget := maxBytes - segmentHeadroomBytes
	for _, e := range events {
		size, err := encodedSize(e)
		if err != nil {
			rejected = append(rejected, rejectedEvent{Event: e, Reason: "marshal: " + err.Error()})
			continue
		}
		if size <= budget {
			fit = append(fit, e)
			continue
		}
		if policy != oversizePolicySegment {
			rejected = append(rejected, rejectedEvent{Event: e, Bytes: size, Reason: fmt.Sprintf("event is %d bytes, over the %d byte transport limit, and the oversize policy is %s", size, maxBytes, policy)})
			continue
		}
		parts, field, err := segmentEvent(e, budget)
		if err != nil {
			rejected = append(rejected, rejectedEvent{Event: e, Bytes: size, Reason: fmt.Sprintf("event is %d bytes, over the %d byte transport limit, and cannot be segmented: %s", size, maxBytes, err.Error())})
			continue
		}
		utils.LogWithFields(utils.LevelInfo, "telemetry", "oversize event segmented for transport", map[string]any{
			"event": e.Name, "event_id": e.EventID, "bytes": size, "max_bytes": maxBytes,
			"parts": len(parts), "field": field,
		})
		fit = append(fit, parts...)
	}
	return fit, rejected
}

// asMap renders the block as the plain map every other payload value is,
// so nothing downstream (frame encoders, hook payloads, tests that inspect
// payloads) meets a struct where it expects JSON-shaped data.
func (m segmentMeta) asMap() map[string]any {
	return map[string]any{
		"part": m.Part, "parts": m.Parts, "field": m.Field,
		"total_bytes": m.TotalBytes, "sha256": m.SHA256,
	}
}

// segmentEvent splits e's largest string field so every part encodes to at
// most budget bytes. All parts share e's envelope (event_id, ts, context,
// trace) and every other payload field; only the split field differs. The
// returned pointer names the field that was split.
func segmentEvent(e Event, budget int) ([]Event, string, error) {
	pointer, value, ok := largestStringLeaf(e.Payload)
	if !ok {
		return nil, "", fmt.Errorf("payload has no string field to split")
	}
	sum := sha256.Sum256([]byte(value))
	meta := segmentMeta{Field: pointer, TotalBytes: len(value), SHA256: hex.EncodeToString(sum[:])}

	// Size the envelope with the split field emptied and the widest segment
	// numbers it could carry, so the chunk budget is a guaranteed bound
	// rather than an estimate that a nine-digit part count could exceed.
	probe := e
	probe.Payload = cloneWith(e.Payload, pointer, "")
	wide := meta
	wide.Part, wide.Parts = 999_999_999, 999_999_999
	probe.Payload[segmentKey] = wide.asMap()
	overhead, err := encodedSize(probe)
	if err != nil {
		return nil, "", err
	}
	chunkBudget := budget - overhead
	if chunkBudget < minSegmentChunkBytes {
		return nil, "", fmt.Errorf("envelope alone is %d bytes of a %d byte budget; too little room to carry %q in chunks", overhead, budget, pointer)
	}

	chunks := splitForBudget(value, chunkBudget)
	parts := make([]Event, 0, len(chunks))
	for i, chunk := range chunks {
		part := e
		part.Payload = cloneWith(e.Payload, pointer, chunk)
		m := meta
		m.Part, m.Parts = i+1, len(chunks)
		part.Payload[segmentKey] = m.asMap()
		parts = append(parts, part)
	}
	return parts, pointer, nil
}

// splitForBudget cuts s into chunks whose JSON-encoded form (the escaped
// content between the quotes) is at most budget bytes each. Cuts land on
// rune boundaries so no part carries a torn UTF-8 sequence, which would
// otherwise be replaced on decode and break the sha256 check downstream.
func splitForBudget(s string, budget int) []string {
	var chunks []string
	for i := 0; i < len(s); {
		end := i + budget
		if end > len(s) {
			end = len(s)
		}
		end = runeAlign(s, i, end)
		for {
			enc := encodedStringLen(s[i:end])
			if enc <= budget || end-i <= 1 {
				break
			}
			// Escaping expanded the chunk; shrink proportionally and re-check.
			shrunk := i + (end-i)*budget/enc
			if shrunk <= i {
				shrunk = i + 1
			}
			end = runeAlign(s, i, shrunk)
			if end <= i {
				end = i + 1
				for end < len(s) && !utf8.RuneStart(s[end]) {
					end++
				}
			}
		}
		chunks = append(chunks, s[i:end])
		i = end
	}
	return chunks
}

// runeAlign moves end backward to the nearest rune boundary at or after
// start+1, so a cut never lands inside a multi-byte sequence.
func runeAlign(s string, start, end int) int {
	for end > start+1 && end < len(s) && !utf8.RuneStart(s[end]) {
		end--
	}
	return end
}

// encodedStringLen is the byte length of s as JSON string content, without
// the surrounding quotes.
func encodedStringLen(s string) int {
	b, err := json.Marshal(s)
	if err != nil {
		return len(s) * 6
	}
	return len(b) - 2
}

// largestStringLeaf walks payload and returns the JSON pointer and value of
// its largest string, descending through nested maps and slices. ok is false
// when the payload holds no string at all.
func largestStringLeaf(payload map[string]any) (pointer, value string, ok bool) {
	var walk func(node any, path string)
	walk = func(node any, path string) {
		switch v := node.(type) {
		case string:
			if !ok || len(v) > len(value) {
				pointer, value, ok = path, v, true
			}
		case map[string]any:
			for k, child := range v {
				walk(child, path+"/"+escapePointerToken(k))
			}
		case []any:
			for i, child := range v {
				walk(child, fmt.Sprintf("%s/%d", path, i))
			}
		}
	}
	walk(payload, "")
	return pointer, value, ok
}

// escapePointerToken applies RFC 6901 escaping to one path segment.
func escapePointerToken(s string) string {
	return strings.ReplaceAll(strings.ReplaceAll(s, "~", "~0"), "/", "~1")
}

func unescapePointerToken(s string) string {
	return strings.ReplaceAll(strings.ReplaceAll(s, "~1", "/"), "~0", "~")
}

// cloneWith returns a copy of payload with the value at pointer replaced.
// Only the containers along the path are copied; every other subtree is
// shared, which is what keeps segmenting a 50 MB event from costing 50 MB
// per part. Shared subtrees are never mutated after this returns.
func cloneWith(payload map[string]any, pointer string, value string) map[string]any {
	tokens := strings.Split(strings.TrimPrefix(pointer, "/"), "/")
	out, _ := setPath(payload, tokens, value).(map[string]any) //nolint:errcheck // root is always the map we were given
	return out
}

func setPath(node any, tokens []string, value string) any {
	if len(tokens) == 0 {
		return value
	}
	key := unescapePointerToken(tokens[0])
	switch v := node.(type) {
	case map[string]any:
		out := make(map[string]any, len(v))
		for k, child := range v {
			out[k] = child
		}
		out[key] = setPath(v[key], tokens[1:], value)
		return out
	case []any:
		out := make([]any, len(v))
		copy(out, v)
		var idx int
		if _, err := fmt.Sscanf(key, "%d", &idx); err == nil && idx >= 0 && idx < len(out) {
			out[idx] = setPath(v[idx], tokens[1:], value)
		}
		return out
	}
	return node
}

// quarantine is the append-only file an undeliverable event is written to.
// One record per event, JSONL, beside the retry queue it came from. The
// count and bytes are cumulative for the process so a health snapshot can
// say how much of the stream is on disk rather than delivered.
type quarantine struct {
	mu     sync.Mutex
	path   string
	target string
	events int
	bytes  int64
}

// quarantineRecord is one line of the quarantine file.
type quarantineRecord struct {
	QuarantinedAt string `json:"quarantined_at"`
	Target        string `json:"target"`
	Reason        string `json:"reason"`
	Bytes         int    `json:"bytes"`
	Event         Event  `json:"event"`
}

// quarantinePath derives the quarantine file from its retry queue's path:
// the ".jsonl" suffix is replaced with ".quarantine.jsonl", so the two stay
// adjacent on disk and share the queue's target discriminator.
func quarantinePath(queuePath string) string {
	return strings.TrimSuffix(queuePath, filepath.Ext(queuePath)) + ".quarantine.jsonl"
}

func newQuarantine(queuePath, target string) *quarantine {
	return &quarantine{path: quarantinePath(queuePath), target: target}
}

// add writes each rejected event as its own record and logs each at ERROR:
// content that was meant for the audit stream is now only on this disk,
// which is a loss an operator has to hear about, not a housekeeping detail.
// Returns the number of events written.
func (q *quarantine) add(rejected []rejectedEvent) int {
	if q == nil || len(rejected) == 0 {
		return 0
	}
	q.mu.Lock()
	defer q.mu.Unlock()
	if err := os.MkdirAll(filepath.Dir(q.path), 0o755); err != nil {
		utils.LogWithFields(utils.LevelError, "telemetry", "quarantine directory create failed; undeliverable events are lost", map[string]any{
			"path": q.path, "target": q.target, "error": err.Error(), "events": len(rejected),
		})
		return 0
	}
	f, err := os.OpenFile(q.path, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o644)
	if err != nil {
		utils.LogWithFields(utils.LevelError, "telemetry", "quarantine file open failed; undeliverable events are lost", map[string]any{
			"path": q.path, "target": q.target, "error": err.Error(), "events": len(rejected),
		})
		return 0
	}
	defer func() {
		if closeErr := f.Close(); closeErr != nil {
			utils.LogWithFields(utils.LevelInfo, "telemetry", "quarantine file close failed", map[string]any{"path": q.path, "error": closeErr.Error()})
		}
	}()
	written := 0
	for _, r := range rejected {
		line, err := json.Marshal(quarantineRecord{
			QuarantinedAt: time.Now().UTC().Format(time.RFC3339Nano),
			Target:        q.target, Reason: r.Reason, Bytes: r.Bytes, Event: r.Event,
		})
		if err != nil {
			utils.LogWithFields(utils.LevelError, "telemetry", "quarantine record marshal failed", map[string]any{"path": q.path, "event": r.Event.Name, "error": err.Error()})
			continue
		}
		if _, err := f.Write(append(line, '\n')); err != nil {
			utils.LogWithFields(utils.LevelError, "telemetry", "quarantine record write failed", map[string]any{"path": q.path, "event": r.Event.Name, "error": err.Error()})
			continue
		}
		written++
		q.events++
		q.bytes += int64(r.Bytes)
		conversationID, _ := r.Event.Payload["conversation_id"].(string) //nolint:errcheck // log context only
		utils.LogWithFields(utils.LevelError, "telemetry", "event quarantined; it is preserved on disk but will not reach the stream", map[string]any{
			"path": q.path, "target": q.target, "event": r.Event.Name, "event_id": r.Event.EventID,
			"conversation_id": conversationID, "bytes": r.Bytes, "reason": r.Reason,
		})
	}
	return written
}

// counts returns the cumulative quarantined events and bytes.
func (q *quarantine) counts() (int, int64) {
	if q == nil {
		return 0, 0
	}
	q.mu.Lock()
	defer q.mu.Unlock()
	return q.events, q.bytes
}
