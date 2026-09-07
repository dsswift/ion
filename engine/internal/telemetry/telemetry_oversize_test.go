package telemetry

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"math/rand"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
	"unicode/utf8"

	"github.com/dsswift/ion/engine/internal/types"
)

// awkwardText builds a string that exercises every way JSON encoding can
// expand a byte: quotes, backslashes, control characters, multi-byte runes,
// and the U+2028 line separator Go escapes to six bytes.
func awkwardText(n int, seed int64) string {
	pieces := []string{"plain ascii ", "\"quoted\" ", "back\\slash ", "tab\tnew\nline ", "ünïcödé ", "日本語のテキスト ", "  ", "emoji 🚀🔥 ", "\x01\x02 "}
	r := rand.New(rand.NewSource(seed))
	var b strings.Builder
	for b.Len() < n {
		b.WriteString(pieces[r.Intn(len(pieces))])
	}
	return b.String()
}

func toolCallEvent(output string, extra map[string]any) Event {
	payload := map[string]any{
		"conversation_id": "conv-1", "entry_id": "e-1", "tool_use_id": "toolu_1",
		"tool_name": "Bash", "run_id": "run-1", "outcome": "success",
		"input":  map[string]any{"command": "cat big.log"},
		"output": output,
	}
	for k, v := range extra {
		payload[k] = v
	}
	return Event{
		Name: ConversationToolCall, Ts: "2026-09-06T12:00:00.000000001Z", SchemaVersion: TelemetrySchemaVersion,
		Component: "engine", EventID: "evt-big", TraceID: "4bf92f3577b34da6a3ce929d0e0e4736",
		Context: map[string]any{"conversation_id": "conv-1"}, Payload: payload,
	}
}

// reassemble concatenates the split field across parts in part order and
// returns it with the sha256 the parts claim, the way a consumer would.
func reassemble(t *testing.T, parts []Event) (string, string, string) {
	t.Helper()
	ordered := make([]Event, len(parts))
	var field, sha string
	for _, p := range parts {
		seg, ok := p.Payload[segmentKey].(map[string]any)
		if !ok {
			t.Fatalf("part has no %q map: %v", segmentKey, p.Payload[segmentKey])
		}
		part, parts := asInt(seg["part"]), asInt(seg["parts"])
		if parts != len(ordered) || part < 1 || part > parts {
			t.Fatalf("part %d of %d is inconsistent with %d captured parts", part, parts, len(ordered))
		}
		ordered[part-1] = p
		field, sha = seg["field"].(string), seg["sha256"].(string) //nolint:errcheck // asMap writes strings
	}
	var b strings.Builder
	for _, p := range ordered {
		v, _ := lookupPointer(p.Payload, field).(string) //nolint:errcheck // the split field is always a string
		b.WriteString(v)
	}
	return b.String(), field, sha
}

// asInt reads a segment number whether it is the int asMap wrote or the
// float64 a JSON round-trip (the wire, the quarantine file) turned it into.
func asInt(v any) int {
	switch n := v.(type) {
	case int:
		return n
	case float64:
		return int(n)
	}
	return -1
}

func lookupPointer(payload map[string]any, pointer string) any {
	var node any = payload
	for _, tok := range strings.Split(strings.TrimPrefix(pointer, "/"), "/") {
		m, ok := node.(map[string]any)
		if !ok {
			return nil
		}
		node = m[unescapePointerToken(tok)]
	}
	return node
}

// TestSegmentEvent_ReassemblesExactly is the fidelity contract: a consumer
// that concatenates the split field across parts gets back byte-for-byte
// what the emitter produced, every part fits the budget as encoded, every
// part is valid UTF-8, and the envelope and the rest of the payload ride on
// every part unchanged.
func TestSegmentEvent_ReassemblesExactly(t *testing.T) {
	original := awkwardText(300_000, 1)
	e := toolCallEvent(original, nil)
	const budget = 20_000

	parts, field, err := segmentEvent(e, budget)
	if err != nil {
		t.Fatalf("segmentEvent: %v", err)
	}
	if field != "/output" {
		t.Fatalf("split field = %q, want /output", field)
	}
	if len(parts) < 15 {
		t.Fatalf("got %d parts for a 300 KB field at a 20 KB budget; expected many more", len(parts))
	}
	for i, p := range parts {
		n, err := encodedSize(p)
		if err != nil || n > budget {
			t.Errorf("part %d encodes to %d bytes (err %v), over the %d budget", i, n, err, budget)
		}
		if p.EventID != e.EventID || p.Ts != e.Ts || p.TraceID != e.TraceID || p.Name != e.Name {
			t.Errorf("part %d envelope drifted from the original", i)
		}
		if p.Payload["tool_name"] != "Bash" || p.Payload["input"].(map[string]any)["command"] != "cat big.log" { //nolint:errcheck // fixture shape
			t.Errorf("part %d lost an unsplit payload field", i)
		}
		if out, _ := p.Payload["output"].(string); !utf8.ValidString(out) { //nolint:errcheck // checked by ValidString
			t.Errorf("part %d carries a torn UTF-8 sequence", i)
		}
	}

	got, _, sha := reassemble(t, parts)
	if got != original {
		t.Fatalf("reassembled field differs from the original (len %d vs %d)", len(got), len(original))
	}
	sum := sha256.Sum256([]byte(original))
	if sha != hex.EncodeToString(sum[:]) {
		t.Fatalf("sha256 on parts = %s, want the original's %x", sha, sum)
	}
	// The original event must not have been mutated: its payload is shared
	// with the parts except along the split path.
	if e.Payload["output"] != original {
		t.Fatal("segmentEvent mutated the original event's payload")
	}
}

// TestSegmentEvent_SplitsNestedLargestField pins that the split target is
// the largest string anywhere in the payload, addressed by JSON pointer with
// RFC 6901 escaping — a Write tool's input.content is the realistic case.
func TestSegmentEvent_SplitsNestedLargestField(t *testing.T) {
	content := awkwardText(50_000, 2)
	e := toolCallEvent("short output", map[string]any{
		"input": map[string]any{"path/with~tilde": map[string]any{"content": content}},
	})
	parts, field, err := segmentEvent(e, 8_000)
	if err != nil {
		t.Fatalf("segmentEvent: %v", err)
	}
	if field != "/input/path~1with~0tilde/content" {
		t.Fatalf("split field pointer = %q, want RFC 6901 escaped nested path", field)
	}
	got, _, _ := reassemble(t, parts)
	if got != content {
		t.Fatal("nested field did not reassemble to the original")
	}
	for i, p := range parts {
		if p.Payload["output"] != "short output" {
			t.Errorf("part %d lost the unsplit output field", i)
		}
	}
}

// TestFitEvents_PolicyAndRejection pins the three outcomes of the size
// contract: a fitting event passes through untouched, an oversize event is
// segmented under the default policy and quarantined under the other, and
// an event no policy can carry is rejected with a reason.
func TestFitEvents_PolicyAndRejection(t *testing.T) {
	small := toolCallEvent("ok", nil)
	big := toolCallEvent(awkwardText(100_000, 3), nil)
	noStrings := Event{Name: ConversationLifecycle, Payload: map[string]any{"numbers": make([]any, 0)}}
	nums := make([]any, 20_000)
	for i := range nums {
		nums[i] = i
	}
	noStrings.Payload["numbers"] = nums
	const maxBytes = 40_000 + segmentHeadroomBytes

	fit, rejected := fitEvents([]Event{small, big, noStrings}, maxBytes, oversizePolicySegment)
	if len(rejected) != 1 || !strings.Contains(rejected[0].Reason, "no string field") {
		t.Fatalf("segment policy: rejected = %+v, want exactly the string-less event", rejected)
	}
	if len(fit) < 4 || fit[0].EventID != small.EventID {
		t.Fatalf("segment policy: fit = %d events, want the small event followed by the big one's parts", len(fit))
	}

	fit, rejected = fitEvents([]Event{small, big}, maxBytes, oversizePolicyQuarantine)
	if len(fit) != 1 || len(rejected) != 1 || rejected[0].Event.EventID != big.EventID {
		t.Fatalf("quarantine policy: fit=%d rejected=%d, want 1 and 1", len(fit), len(rejected))
	}
	if rejected[0].Bytes == 0 || !strings.Contains(rejected[0].Reason, "quarantine") {
		t.Fatalf("quarantine rejection carries no size or policy: %+v", rejected[0])
	}

	// Two huge strings: after the largest is split, the other alone still
	// exceeds the budget, so the event is undeliverable under segment too.
	twoBig := toolCallEvent(awkwardText(60_000, 4), map[string]any{"stderr": awkwardText(59_000, 5)})
	_, rejected = fitEvents([]Event{twoBig}, maxBytes, oversizePolicySegment)
	if len(rejected) != 1 || !strings.Contains(rejected[0].Reason, "envelope alone") {
		t.Fatalf("envelope-too-large: rejected = %+v", rejected)
	}
}

func TestResolveOversizePolicy(t *testing.T) {
	for raw, want := range map[string]oversizePolicy{"": oversizePolicySegment, "segment": oversizePolicySegment, "quarantine": oversizePolicyQuarantine} {
		got, err := resolveOversizePolicy(raw)
		if err != nil || got != want {
			t.Errorf("resolveOversizePolicy(%q) = %q, %v; want %q", raw, got, err, want)
		}
	}
	if _, err := resolveOversizePolicy("truncate"); err == nil {
		t.Error("an unknown policy must be an error, not a silent default")
	}
}

// TestProbeLinkMaxMessageBytes pins the negotiation search against a
// monotonic fake: it finds the exact limit, whatever the limit is, and
// reports a dead link as an error rather than as a limit.
func TestProbeLinkMaxMessageBytes(t *testing.T) {
	for _, limit := range []uint64{1, 1000, 262_144, 1_048_576, 1_048_577, 20 * 1024 * 1024} {
		calls := 0
		got, err := probeLinkMaxMessageBytes(func(n uint64) error {
			calls++
			if n > limit {
				return fmt.Errorf("larger than the maximum size allowed by link")
			}
			return nil
		})
		if err != nil || uint64(got) != limit {
			t.Errorf("limit %d: got %d, %v", limit, got, err)
		}
		if calls > 80 {
			t.Errorf("limit %d: %d probes, the search is not logarithmic", limit, calls)
		}
	}
	if _, err := probeLinkMaxMessageBytes(func(uint64) error { return fmt.Errorf("link detached") }); err == nil {
		t.Error("a link that refuses every probe must be an error")
	}
}

// newEventHubTestCollector builds a Collector whose eventhub sender is the
// fake, with the retry queue and quarantine in a temp dir, and captures every
// health observation.
func newEventHubTestCollector(t *testing.T, fake *fakeEventHubSender, policy string) (*Collector, *[]TelemetryHealth, *sync.Mutex) {
	t.Helper()
	t.Setenv("HOME", t.TempDir())
	c := NewCollector(types.TelemetryConfig{
		Enabled: true, Targets: []string{"eventhub"}, OversizeEventPolicy: policy,
	})
	t.Cleanup(c.Close)
	c.eventHubSender = fake
	var mu sync.Mutex
	var seen []TelemetryHealth
	c.SetHealthObserver(func(h TelemetryHealth) {
		mu.Lock()
		seen = append(seen, h)
		mu.Unlock()
	})
	return c, &seen, &mu
}

func readQuarantine(t *testing.T, c *Collector) []quarantineRecord {
	t.Helper()
	data, err := os.ReadFile(c.eventHubRetry.quarantine.path)
	if err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		t.Fatalf("read quarantine: %v", err)
	}
	var out []quarantineRecord
	for _, line := range strings.Split(strings.TrimSpace(string(data)), "\n") {
		var r quarantineRecord
		if err := json.Unmarshal([]byte(line), &r); err != nil {
			t.Fatalf("quarantine line does not parse: %v", err)
		}
		out = append(out, r)
	}
	return out
}

// TestDeliverToEventHub_SegmentsOversizeAndSendsAll pins the default path
// end to end through the Collector: an oversize event reaches the sender as
// parts, the small one alongside it untouched, nothing is queued and nothing
// is quarantined.
func TestDeliverToEventHub_SegmentsOversizeAndSendsAll(t *testing.T) {
	fake := &fakeEventHubSender{maxBytes: 32_000 + segmentHeadroomBytes}
	c, _, _ := newEventHubTestCollector(t, fake, "")

	big := awkwardText(100_000, 6)
	c.Event(ConversationToolCall, map[string]any{"conversation_id": "c", "output": "small"}, nil)
	c.Event(ConversationToolCall, map[string]any{"conversation_id": "c", "output": big}, nil)
	if err := c.Flush(); err != nil {
		t.Fatalf("Flush: %v", err)
	}
	if len(fake.sent) != 1 || len(fake.sent[0]) < 5 {
		t.Fatalf("sender received %d sends; want one send holding the small event plus the parts", len(fake.sent))
	}
	if fake.sent[0][0].Payload["output"] != "small" {
		t.Fatal("small event was not delivered first, untouched")
	}
	if got, _, _ := reassemble(t, fake.sent[0][1:]); got != big {
		t.Fatalf("reassembled %d bytes that differ from the %d byte original", len(got), len(big))
	}
	if c.eventHubRetry.load() != nil {
		t.Fatal("nothing should be queued after a successful segmented send")
	}
	if q := readQuarantine(t, c); q != nil {
		t.Fatalf("nothing should be quarantined under segment policy: %+v", q)
	}
}

// TestDeliverToEventHub_QuarantinesUnderPolicyAndReports pins the quarantine
// path: the oversize event is written whole to the quarantine file with a
// reason, the deliverable event still ships, the retry queue stays empty,
// and the health observer hears the quarantine count.
func TestDeliverToEventHub_QuarantinesUnderPolicyAndReports(t *testing.T) {
	fake := &fakeEventHubSender{maxBytes: 32_000 + segmentHeadroomBytes}
	c, seen, mu := newEventHubTestCollector(t, fake, "quarantine")

	c.Event(ConversationToolCall, map[string]any{"conversation_id": "c", "output": "small"}, nil)
	c.Event(ConversationToolCall, map[string]any{"conversation_id": "c", "output": awkwardText(100_000, 7)}, nil)
	if err := c.Flush(); err != nil {
		t.Fatalf("Flush: %v", err)
	}
	if len(fake.sent) != 1 || len(fake.sent[0]) != 1 || fake.sent[0][0].Payload["output"] != "small" {
		t.Fatalf("sender received %v; want exactly the small event", fake.sent)
	}
	q := readQuarantine(t, c)
	if len(q) != 1 || q[0].Target != "eventhub" || q[0].Bytes < 100_000 || !strings.Contains(q[0].Reason, "quarantine") {
		t.Fatalf("quarantine file = %+v; want one full record for the oversize event", q)
	}
	if len(q[0].Event.Payload["output"].(string)) < 100_000 { //nolint:errcheck // fixture shape
		t.Fatal("quarantined event was not preserved whole")
	}
	if c.eventHubRetry.load() != nil {
		t.Fatal("a quarantined event must never enter the retry queue")
	}
	mu.Lock()
	defer mu.Unlock()
	reported := false
	for _, h := range *seen {
		if h.QuarantinedEvents == 1 && h.QuarantinedBytes >= 100_000 {
			reported = true
		}
	}
	if !reported {
		t.Fatalf("health observer never saw the quarantine: %+v", *seen)
	}
}

// TestDeliverToEventHub_LinkRejectionQuarantinesAndResumes pins the
// backstop: when the link refuses an event the size check accepted, that
// event is quarantined, the events before it count as delivered, and the
// events after it are sent — nothing loops.
func TestDeliverToEventHub_LinkRejectionQuarantinesAndResumes(t *testing.T) {
	idx := 1
	fake := &fakeEventHubSender{rejectOnce: &idx}
	c, _, _ := newEventHubTestCollector(t, fake, "")

	for _, out := range []string{"first", "poison", "third"} {
		c.Event(ConversationToolCall, map[string]any{"conversation_id": "c", "output": out}, nil)
	}
	if err := c.Flush(); err != nil {
		t.Fatalf("Flush: %v", err)
	}
	var delivered []string
	for _, batch := range fake.sent {
		for _, e := range batch {
			delivered = append(delivered, e.Payload["output"].(string)) //nolint:errcheck // fixture shape
		}
	}
	if strings.Join(delivered, ",") != "first,third" {
		t.Fatalf("delivered %v, want first and third with the poison removed", delivered)
	}
	q := readQuarantine(t, c)
	if len(q) != 1 || q[0].Event.Payload["output"] != "poison" {
		t.Fatalf("quarantine = %+v, want the rejected event", q)
	}
	if c.eventHubRetry.load() != nil {
		t.Fatal("nothing should remain queued")
	}
}

// TestDeliverToEventHub_UnknownLimitFallsBackToDefault pins that a link that
// cannot be negotiated does not stop delivery: the published default applies
// and the event ships.
func TestDeliverToEventHub_UnknownLimitFallsBackToDefault(t *testing.T) {
	fake := &fakeEventHubSender{maxErr: fmt.Errorf("link detached")}
	c, _, _ := newEventHubTestCollector(t, fake, "")
	c.Event(ConversationToolCall, map[string]any{"conversation_id": "c", "output": "x"}, nil)
	if err := c.Flush(); err != nil {
		t.Fatalf("Flush: %v", err)
	}
	if len(fake.sent) != 1 {
		t.Fatal("event was not delivered under the fallback limit")
	}
}

// TestRetryQueue_StuckEscalatesOnAgeNotSize is the regression test for the
// silent 255-attempt failure: a tiny batch that keeps failing must be
// reported stuck once it is old enough, with no size notch ever crossed,
// and reported un-stuck once it finally drains.
func TestRetryQueue_StuckEscalatesOnAgeNotSize(t *testing.T) {
	dir := t.TempDir()
	failing := true
	q := newRetryQueue("eventhub", filepath.Join(dir, "retry.jsonl"), 0, 0, 1, func(events []Event) ([]Event, error) {
		if failing {
			return events, fmt.Errorf("still failing")
		}
		return nil, nil
	})
	var mu sync.Mutex
	var seen []TelemetryHealth
	q.setHealthObserver(func(h TelemetryHealth) {
		mu.Lock()
		seen = append(seen, h)
		mu.Unlock()
	})

	q.enqueue([]Event{{Name: ConversationToolCall, Payload: map[string]any{"output": "tiny"}}})
	// Age the batch past the 1 minute stuck window and make it due.
	batches := q.load()
	batches[0].EnqueuedAt = time.Now().Add(-2 * time.Minute).UnixMilli()
	batches[0].NextRetryAt = time.Now().Add(-time.Second).UnixMilli()
	batches[0].Attempt = 7
	q.save(batches)

	q.drainAndRetry()
	mu.Lock()
	last := seen[len(seen)-1]
	mu.Unlock()
	if !last.Stuck || last.MaxAttempts != 8 || last.CrossedThreshold != 0 || last.Healthy {
		t.Fatalf("after an aged failure: %+v; want Stuck with MaxAttempts 8 and no size notch", last)
	}
	if last.OldestAgeMs < 2*time.Minute.Milliseconds()-1000 {
		t.Fatalf("OldestAgeMs = %d, want the exact enqueue age", last.OldestAgeMs)
	}

	// Recovery: make it due again and let delivery succeed.
	failing = false
	batches = q.load()
	batches[0].NextRetryAt = time.Now().Add(-time.Second).UnixMilli()
	q.save(batches)
	q.drainAndRetry()
	mu.Lock()
	last = seen[len(seen)-1]
	mu.Unlock()
	if last.Stuck || last.QueuedBatches != 0 || !last.Healthy {
		t.Fatalf("after draining: %+v; want un-stuck, empty, healthy", last)
	}
}

// TestRetryQueue_BatchShrinksToWhatIsOwed pins that the queue persists what
// the target hands back — a batch whose members were quarantined mid-retry
// does not carry them into the next attempt, and one with nothing left is
// removed even though the attempt reported an error.
func TestRetryQueue_BatchShrinksToWhatIsOwed(t *testing.T) {
	dir := t.TempDir()
	q := newRetryQueue("eventhub", filepath.Join(dir, "retry.jsonl"), 0, 0, 0, func(events []Event) ([]Event, error) {
		// Dispose of the first event each time, fail on the rest.
		return events[1:], fmt.Errorf("partial")
	})
	q.enqueue([]Event{{Name: "a"}, {Name: "b"}, {Name: "c"}})
	due := func() {
		b := q.load()
		b[0].NextRetryAt = time.Now().Add(-time.Second).UnixMilli()
		q.save(b)
	}
	due()
	q.drainAndRetry()
	if b := q.load(); len(b) != 1 || len(b[0].Events) != 2 || b[0].Events[0].Name != "b" {
		t.Fatalf("after first retry: %+v; want the batch holding b,c", b)
	}
	due()
	q.drainAndRetry()
	due()
	q.drainAndRetry()
	if b := q.load(); b != nil {
		t.Fatalf("after every event was disposed of the batch must be gone: %+v", b)
	}
}

// TestRetryQueue_LoadDerivesEnqueuedAtForLegacyEntries pins the migration:
// a queue file written before enqueued_at_ms existed still reports an
// accurate age instead of zero.
func TestRetryQueue_LoadDerivesEnqueuedAtForLegacyEntries(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "retry.jsonl")
	legacy := `[{"events":[{"name":"a","ts":"","schema":4,"component":"engine","payload":{},"trace_id":"","parent_span_id":""}],"next_retry_at_ms":1000005000,"attempt":0}]`
	if err := os.WriteFile(path, []byte(legacy), 0o644); err != nil {
		t.Fatal(err)
	}
	q := newRetryQueue("http", path, 0, 0, 0, func([]Event) ([]Event, error) { return nil, nil })
	b := q.load()
	if len(b) != 1 || b[0].EnqueuedAt != 1000000000 {
		t.Fatalf("legacy EnqueuedAt = %+v, want derived 1000000000", b)
	}
}

func TestQuarantinePath(t *testing.T) {
	if got := quarantinePath("/x/eventhub-retry-abc.jsonl"); got != "/x/eventhub-retry-abc.quarantine.jsonl" {
		t.Fatalf("quarantinePath = %q", got)
	}
}
