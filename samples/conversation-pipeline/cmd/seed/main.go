// Command seed publishes one scripted conversation to the hub so the
// pipeline can be exercised without an engine in the loop. See
// internal/seed for what it sends.
package main

import (
	"context"
	"flag"
	"fmt"
	"math/rand"
	"os"
	"time"

	"github.com/dsswift/ion/samples/conversation-pipeline/internal/seed"
	"github.com/dsswift/ion/samples/conversation-pipeline/internal/stream"
)

func main() {
	conversationID := flag.String("conversation", "", "conversation id to seed (default: seed-<time>)")
	user := flag.String("user", "user@example.com", "user identity stamped on every event")
	bigMB := flag.Int("big-mb", 3, "size in MiB of the oversize tool output")
	redeliver := flag.Bool("redeliver", true, "send the first user message a second time, as the engine's retry queue would")
	gap := flag.Duration("gap", 50*time.Millisecond, "pause between emissions")
	shuffle := flag.Int64("shuffle", 0, "when non-zero, send the messages in a scrambled order seeded by this value")
	flag.Parse()

	conn := os.Getenv("EVENTHUB_CONNECTION_STRING")
	if conn == "" {
		stream.Logf("ERROR", "EVENTHUB_CONNECTION_STRING is required", nil)
		os.Exit(2)
	}
	if *conversationID == "" {
		*conversationID = "seed-" + time.Now().UTC().Format("20060102-150405")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Minute)
	defer cancel()

	opts := seed.Options{Redeliver: *redeliver, Gap: *gap}
	if *shuffle != 0 {
		opts.Shuffle = rand.New(rand.NewSource(*shuffle)) //nolint:gosec // a scramble, not a secret
	}
	script := seed.New(*conversationID, *user, *bigMB*1024*1024)
	res, err := seed.Publish(ctx, conn, stream.EnvOr("EVENTHUB_NAME", "conversation-events"), script, opts, func(step int, envelopes []stream.Envelope) {
		e := envelopes[0]
		fields := map[string]any{"step": step, "event": e.Name, "event_id": e.EventID, "seq": e.Seq()}
		if seg, ok := e.SegmentInfo(); ok {
			fields["part"], fields["parts"], fields["total_bytes"] = seg.Part, seg.Parts, seg.TotalBytes
		}
		stream.Logf("INFO", "published", fields)
	})
	if err != nil {
		stream.Logf("ERROR", "seed failed", map[string]any{"error": err.Error()})
		os.Exit(1)
	}
	stream.Logf("INFO", "conversation seeded", map[string]any{"conversation_id": res.ConversationID, "logical_events": res.Events, "messages": res.Messages, "redelivered": res.Redelivered, "order": res.Order})
	fmt.Println(res.ConversationID)
}
