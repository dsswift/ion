// Package seed publishes one scripted conversation in the exact envelope
// Ion emits, including a tool output far larger than a hub message (so it
// arrives as segments) and, optionally, a redelivered message. The seed
// command and the guided demo both use it.
package seed

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	mrand "math/rand"
	"strings"
	"time"

	"github.com/Azure/azure-sdk-for-go/sdk/messaging/azeventhubs/v2"

	"github.com/dsswift/ion/samples/conversation-pipeline/internal/stream"
)

// schemaVersion mirrors the engine's published telemetry schema major at
// the time this seed was written. The pipeline never gates on it; it is
// carried so seeded events validate against the published schema document.
const schemaVersion = 4

// segmentChunkBytes is the field chunk the seed splits an oversize output
// into. Well under the emulator's negotiated message limit with room for
// the envelope, so every part is deliverable as one message.
const segmentChunkBytes = 700 * 1024

func randomID(bytes int) string {
	b := make([]byte, bytes)
	if _, err := rand.Read(b); err != nil {
		panic(err)
	}
	return hex.EncodeToString(b)
}

// Script is the scripted conversation. Build one with New.
type Script struct {
	conversationID string
	user           string
	traceID        string
	seq            int64
	bigBytes       int
}

func (s *Script) envelope(name string, payload map[string]any) stream.Envelope {
	s.seq++
	payload["conversation_id"] = s.conversationID
	payload["seq"] = s.seq
	return stream.Envelope{
		Name: name, Ts: time.Now().UTC().Format(time.RFC3339Nano), Schema: schemaVersion,
		Component: "engine", InstallID: "seed-install", Host: "seed", Version: "sample-seed",
		EventID: randomID(8), User: s.user, TraceID: s.traceID, ParentSpanID: "",
		Context: map[string]any{"conversation_id": s.conversationID, "trace_id": s.traceID,
			"app_context": map[string]any{"client": "seed", "tab_id": "tab-1"}},
		Payload: payload,
	}
}

// bigOutput is a deterministic, awkward, multi-megabyte tool output: every
// line is numbered so a reassembly error would be visible as a wrong line,
// and the content mixes multi-byte runes and JSON-escaped characters so a
// cut on the wrong byte would break verification.
func bigOutput(n int) string {
	var b strings.Builder
	line := 0
	for b.Len() < n {
		line++
		fmt.Fprintf(&b, "%08d  日本語 line with \"quotes\" \\ and a 🚀 — payload %s\n", line, strings.Repeat("x", 64))
	}
	return b.String()
}

func (s *Script) steps() [][]stream.Envelope {
	var out [][]stream.Envelope
	one := func(e stream.Envelope) { out = append(out, []stream.Envelope{e}) }
	one(s.envelope("conversation.lifecycle", map[string]any{"action": "created"}))
	one(s.envelope("conversation.user_message", map[string]any{"entry_id": "e1", "run_id": "run-1", "text": "Summarise the deploy log and tell me what failed."}))
	one(s.envelope("conversation.tool_call", map[string]any{"entry_id": "e2", "tool_use_id": "toolu_1", "tool_name": "Bash", "run_id": "run-1", "outcome": "success",
		"input": map[string]any{"command": "wc -l deploy.log"}, "output": "48213 deploy.log\n"}))
	big := s.envelope("conversation.tool_call", map[string]any{"entry_id": "e3", "tool_use_id": "toolu_2", "tool_name": "Bash", "run_id": "run-1", "outcome": "success",
		"input": map[string]any{"command": "cat deploy.log"}, "output": bigOutput(s.bigBytes)})
	parts, err := stream.SplitField(big, "/output", segmentChunkBytes)
	if err != nil {
		panic(err)
	}
	out = append(out, parts)
	one(s.envelope("conversation.assistant_message", map[string]any{"entry_id": "e4", "run_id": "run-1", "model": "claude-sonnet-5",
		"text": "The deploy failed at the migration step; the log shows a timeout against the database.",
		"cost": map[string]any{"input_tokens": 41230, "output_tokens": 88, "cache_read_input_tokens": 0, "cache_creation_input_tokens": 0, "cost_usd": 0.1249}}))
	one(s.envelope("conversation.user_message", map[string]any{"entry_id": "e5", "run_id": "run-2", "text": "Thanks."}))
	one(s.envelope("conversation.assistant_message", map[string]any{"entry_id": "e6", "run_id": "run-2", "model": "claude-sonnet-5", "text": "Any time.",
		"cost": map[string]any{"input_tokens": 41400, "output_tokens": 4, "cache_read_input_tokens": 41230, "cache_creation_input_tokens": 0, "cost_usd": 0.0071}}))
	return out
}

// send publishes envelopes as one or more batches, splitting when a batch
// fills, the same way the engine's sender does.
func send(ctx context.Context, producer *azeventhubs.ProducerClient, envelopes []stream.Envelope) (int, error) {
	batch, err := producer.NewEventDataBatch(ctx, nil)
	if err != nil {
		return 0, err
	}
	sent := 0
	for _, e := range envelopes {
		body, err := json.Marshal(e)
		if err != nil {
			return sent, err
		}
		ed := &azeventhubs.EventData{Body: body}
		if err := batch.AddEventData(ed, nil); err == nil {
			continue
		} else if !errors.Is(err, azeventhubs.ErrEventDataTooLarge) {
			return sent, err
		}
		if batch.NumEvents() == 0 {
			return sent, fmt.Errorf("event %s (%d bytes) does not fit an empty batch", e.EventID, len(body))
		}
		if err := producer.SendEventDataBatch(ctx, batch, nil); err != nil {
			return sent, err
		}
		sent += int(batch.NumEvents())
		if batch, err = producer.NewEventDataBatch(ctx, nil); err != nil {
			return sent, err
		}
		if err := batch.AddEventData(ed, nil); err != nil {
			return sent, fmt.Errorf("event %s (%d bytes) does not fit an empty batch: %w", e.EventID, len(body), err)
		}
	}
	if batch.NumEvents() > 0 {
		if err := producer.SendEventDataBatch(ctx, batch, nil); err != nil {
			return sent, err
		}
		sent += int(batch.NumEvents())
	}
	return sent, nil
}

// New builds a script for conversationID with the given user and oversize
// output size.
func New(conversationID, user string, bigBytes int) *Script {
	return &Script{conversationID: conversationID, user: user, traceID: randomID(16), bigBytes: bigBytes}
}

// Steps returns the emissions in order: each is one envelope, or the parts
// of a segmented event.
func (s *Script) Steps() [][]stream.Envelope { return s.steps() }

// Options tune Publish.
type Options struct {
	// Redeliver re-sends the first user message after the script, the way
	// the engine's retry queue would.
	Redeliver bool
	// Gap is the pause between emissions: a real conversation does not
	// happen in one millisecond, and a watcher should see the sequence as a
	// sequence.
	Gap time.Duration
	// Shuffle, when set, sends the emissions in a scrambled order and the
	// parts of the segmented event out of order too. The stream's ordering
	// contract (ts, then seq, then part) means a consumer must reconstruct
	// the right sequence regardless of delivery order; this is how the
	// demo proves it does.
	Shuffle *mrand.Rand
}

// Result describes what Publish sent.
type Result struct {
	ConversationID string
	// Events is the number of logical events; Messages is the number of
	// hub messages, which exceeds Events by the extra parts of segmented
	// events plus one for the redelivery when it was requested.
	Events, Messages int
	// BigParts is how many parts the oversize tool output was sent as, and
	// BigBytes its size before splitting.
	BigParts, BigBytes int
	Redelivered        bool
	// Order is the seq of each emission in the order it was sent, with a
	// segmented event's parts as "seq/part"; it reads as the scramble when
	// Shuffle was set.
	Order []string
}

// Publish sends the script to the hub one emission at a time. onStep, when
// set, is called after each emission with the envelopes it sent.
func Publish(ctx context.Context, connectionString, hub string, s *Script, opts Options, onStep func(step int, envelopes []stream.Envelope)) (Result, error) {
	producer, err := azeventhubs.NewProducerClientFromConnectionString(connectionString, hub, nil)
	if err != nil {
		return Result{}, fmt.Errorf("producer client: %w", err)
	}
	defer producer.Close(context.Background()) //nolint:errcheck // shutdown

	steps := s.steps()
	res := Result{ConversationID: s.conversationID, Events: len(steps), Redelivered: opts.Redeliver}
	for _, envelopes := range steps {
		if seg, ok := envelopes[0].SegmentInfo(); ok {
			res.BigParts, res.BigBytes = seg.Parts, seg.TotalBytes
		}
	}
	// Every emission becomes its own send so parts can travel out of order
	// too; a plain event is one send, a segmented event is one per part.
	var sends [][]stream.Envelope
	for _, envelopes := range steps {
		for _, e := range envelopes {
			sends = append(sends, []stream.Envelope{e})
		}
	}
	if opts.Redeliver {
		sends = append(sends, []stream.Envelope{steps[1][0]})
	}
	if opts.Shuffle != nil {
		opts.Shuffle.Shuffle(len(sends), func(i, j int) { sends[i], sends[j] = sends[j], sends[i] })
	}
	for i, envelopes := range sends {
		n, err := send(ctx, producer, envelopes)
		res.Messages += n
		if err != nil {
			return res, fmt.Errorf("send %d: %w", i, err)
		}
		e := envelopes[0]
		if seg, ok := e.SegmentInfo(); ok {
			res.Order = append(res.Order, fmt.Sprintf("%d/%d", e.Seq(), seg.Part))
		} else {
			res.Order = append(res.Order, fmt.Sprintf("%d", e.Seq()))
		}
		if onStep != nil {
			onStep(i, envelopes)
		}
		if i < len(sends)-1 {
			time.Sleep(opts.Gap)
		}
	}
	return res, nil
}
