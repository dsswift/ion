// Command demo is the guided walkthrough: it seeds one conversation, waits
// for each store to actually hold it, reconstructs it from the hot store,
// folds it to the archive, reconstructs it again from the archive, and
// checks at every step that what came out is what went in. It narrates
// what is about to happen and what proves it worked, and exits non-zero
// if any check fails. Housekeeping log lines stay off the console unless
// --verbose is given.
package main

import (
	"context"
	"flag"
	"fmt"
	"math/rand"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/Azure/azure-sdk-for-go/sdk/storage/azblob"

	"github.com/dsswift/ion/samples/conversation-pipeline/internal/checkpoints"
	"github.com/dsswift/ion/samples/conversation-pipeline/internal/pipeline"
	"github.com/dsswift/ion/samples/conversation-pipeline/internal/seed"
	"github.com/dsswift/ion/samples/conversation-pipeline/internal/stream"
)

// Colors are on when stdout is a terminal and NO_COLOR is unset; the same
// output goes uncolored to a pipe or a log.
var (
	colorOn = isTerminal(os.Stdout) && os.Getenv("NO_COLOR") == ""
	bold    = paint("1")
	dim     = paint("2")
	cyan    = paint("36")
	green   = paint("32")
	red     = paint("31")
	yellow  = paint("33")
)

func paint(code string) func(string) string {
	return func(s string) string {
		if !colorOn {
			return s
		}
		return "\x1b[" + code + "m" + s + "\x1b[0m"
	}
}

func isTerminal(f *os.File) bool {
	info, err := f.Stat()
	return err == nil && info.Mode()&os.ModeCharDevice != 0
}

// walk carries the state one step hands to the next.
type walk struct {
	ctx     context.Context
	hot     *stream.HotStore
	blobs   *stream.BlobStores
	hub     string
	conn    string
	fnURL   string
	wait    time.Duration
	gap     time.Duration
	shuffle *rand.Rand
	seeded  seed.Result
	fromHot stream.Transcript
	failed  []string
	step    int
}

func (w *walk) heading(title string) {
	w.step++
	fmt.Printf("\n%s\n", bold(cyan(fmt.Sprintf("%d. %s", w.step, title))))
}

func say(format string, args ...any) { fmt.Printf("   %s\n", dim(fmt.Sprintf(format, args...))) }

// sent is one emission line: seq stands out, the rest reads as narration.
func sent(seq string, label, detail string) {
	if detail != "" {
		detail = " " + dim(detail)
	}
	fmt.Printf("   %s %s %-18s%s\n", dim("sent"), yellow(fmt.Sprintf("seq %-4s", seq)), label, detail)
}

func (w *walk) check(ok bool, format string, args ...any) {
	line := fmt.Sprintf(format, args...)
	if ok {
		fmt.Printf("   %s %s\n", green("✔"), line)
		return
	}
	fmt.Printf("   %s %s\n", red("✘"), bold(line))
	w.failed = append(w.failed, line)
}

// until polls fn every second until it reports done or the wait elapses,
// printing one dot per poll so a slow step is visibly alive.
func (w *walk) until(what string, fn func() (bool, string, error)) bool {
	deadline := time.Now().Add(w.wait)
	fmt.Printf("   %s", dim("waiting for "+what+" "))
	for {
		done, detail, err := fn()
		if err != nil {
			fmt.Println()
			say("error while waiting: %v", err)
			return false
		}
		if done {
			fmt.Printf(" %s\n", detail)
			return true
		}
		if time.Now().After(deadline) {
			fmt.Printf("\n   %s\n", red(fmt.Sprintf("gave up after %s (%s)", w.wait, detail)))
			return false
		}
		fmt.Print(dim("."))
		time.Sleep(time.Second)
	}
}

func (w *walk) preflight() bool {
	w.heading("Check the stack")
	say("The demo talks to five containers: the Event Hubs emulator, Azurite, the Cosmos DB emulator, the capture writer, and the ingest function.")
	say("The two writers are not called directly; they consume the hub on their own and fill capture and Cosmos DB.")
	var err error
	w.hot, err = stream.OpenHotStore(w.ctx, stream.CosmosConfigFromEnv())
	w.check(err == nil, "Cosmos DB answers at %s%s", stream.CosmosConfigFromEnv().Endpoint, errSuffix(err))
	w.blobs, err = stream.OpenBlobStores(w.ctx, stream.BlobConfigFromEnv())
	w.check(err == nil, "Azurite answers and the capture and archive containers exist%s", errSuffix(err))
	w.auditCheckpoints()
	ok := w.until("the ingest function host", func() (bool, string, error) {
		resp, err := http.Get(w.fnURL) //nolint:noctx // a liveness probe on localhost
		if err != nil {
			return false, err.Error(), nil
		}
		resp.Body.Close() //nolint:errcheck // probe
		return resp.StatusCode == 200, fmt.Sprintf("answers %d at %s", resp.StatusCode, w.fnURL), nil
	})
	w.check(ok, "the ingest function host is up")
	return len(w.failed) == 0
}

// auditCheckpoints proves the consumers' checkpoints belong to the hub as
// it exists now and removes the ones that do not. A redeploy recreates the
// emulator hub while Azurite keeps the checkpoints, and a checkpoint into a
// hub that no longer exists leaves a partition unreadable forever or skips
// its start; the same thing happens in Azure after a hub is rebuilt.
func (w *walk) auditCheckpoints() {
	blobClient, err := azblob.NewClientFromConnectionString(os.Getenv("BLOB_CONNECTION_STRING"), nil)
	if err != nil {
		w.check(false, "blob client for the checkpoint audit: %v", err)
		return
	}
	hub, findings, err := checkpoints.Audit(w.ctx, w.conn, w.hub, blobClient, checkpoints.DefaultGroups(), true)
	if err != nil {
		w.check(false, "checkpoint audit: %v", err)
		return
	}
	stale := checkpoints.Stale(findings)
	if len(stale) == 0 {
		w.check(true, "the consumers' %d checkpoint(s) belong to this hub (created %s)", len(findings), hub.CreatedOn.UTC().Format(time.RFC3339))
		return
	}
	say("The hub was created %s, but some checkpoints in Azurite predate it or point past its end. They are from an earlier hub and were removed so both consumers re-read from the start:", hub.CreatedOn.UTC().Format(time.RFC3339))
	for _, f := range stale {
		say("  %s partition %s: %s", f.Group.ConsumerGroup, f.Partition, f.Stale)
	}
	w.check(true, "%d stale checkpoint(s) removed", len(stale))
}

func errSuffix(err error) string {
	if err == nil {
		return ""
	}
	return ": " + err.Error()
}

func (w *walk) seedStep(bigMB int) bool {
	w.heading("Publish one conversation to the hub")
	say("This is the only step that writes the hub. A real engine would be the other writer.")
	say("The script is seven events. One tool output is %d MiB, several times an Event Hub message, so it is split into parts that share one event id, exactly as the engine does.", bigMB)
	say("The first user message is sent twice on purpose, the way the engine's retry queue would redeliver it.")
	if w.shuffle != nil {
		say("The messages are sent in a scrambled order, parts included. Every message carries the engine's seq, and every part its part number, so the stores must put them back in order without any help from delivery order.")
	}
	id := "demo-" + time.Now().UTC().Format("20060102-150405")
	script := seed.New(id, "user@example.com", bigMB*1024*1024)
	seen := map[string]bool{}
	res, err := seed.Publish(w.ctx, w.conn, w.hub, script, seed.Options{Redeliver: true, Gap: w.gap, Shuffle: w.shuffle}, func(step int, envelopes []stream.Envelope) {
		e := envelopes[0]
		label := strings.TrimPrefix(e.Name, "conversation.")
		key := e.DocumentID()
		switch seg, ok := e.SegmentInfo(); {
		case ok:
			sent(fmt.Sprintf("%d", e.Seq()), label, fmt.Sprintf("part %d of %d (%d bytes split)", seg.Part, seg.Parts, seg.TotalBytes))
		case seen[key]:
			sent(fmt.Sprintf("%d", e.Seq()), label, "again (redelivery)")
		default:
			sent(fmt.Sprintf("%d", e.Seq()), label, "")
		}
		seen[key] = true
	})
	if err != nil {
		w.check(false, "publish failed: %v", err)
		return false
	}
	w.seeded = res
	w.check(true, "conversation %s: %d events became %d hub messages", res.ConversationID, res.Events, res.Messages)
	if w.shuffle != nil {
		w.check(true, "sent in the order %s", strings.Join(res.Order, " "))
	}
	return true
}

// uniqueMessages is how many distinct documents the seed should produce:
// every message minus the deliberate redelivery.
func (w *walk) uniqueMessages() int {
	if w.seeded.Redelivered {
		return w.seeded.Messages - 1
	}
	return w.seeded.Messages
}

func (w *walk) hotStep() bool {
	w.heading("Watch the ingest function fill Cosmos DB")
	say("The function reads the hub on its own consumer group and writes one document per message, keyed on event id plus part.")
	say("Look for %d documents, not %d: the redelivered message lands on the same document id and the upsert absorbs it.", w.uniqueMessages(), w.seeded.Messages)
	want := w.uniqueMessages()
	var got int
	ok := w.until("Cosmos DB to hold the conversation", func() (bool, string, error) {
		docs, err := w.hot.ConversationDocuments(w.ctx, w.seeded.ConversationID)
		if err != nil {
			return false, "", err
		}
		got = len(docs)
		return got >= want, fmt.Sprintf("%d documents", got), nil
	})
	w.check(ok && got == want, "Cosmos DB holds %d documents (want %d)", got, want)
	return ok
}

func (w *walk) captureStep() bool {
	w.heading("Watch the capture writer fill the capture container")
	say("The capture writer stands in for Event Hubs Capture. It buffers each partition for a short window, then writes one Avro file in Capture's own layout.")
	say("Look for all %d messages, redelivery included: capture keeps the raw stream, it does not deduplicate.", w.seeded.Messages)
	want := w.seeded.Messages
	var got int
	ok := w.until("the capture window to flush", func() (bool, string, error) {
		envs, _, err := w.blobs.CapturedEnvelopes(w.ctx, w.seeded.ConversationID)
		if err != nil {
			return false, "", err
		}
		got = len(envs)
		return got >= want, fmt.Sprintf("%d messages captured", got), nil
	})
	w.check(ok && got == want, "capture holds %d messages (want %d)", got, want)
	return ok
}

func (w *walk) transcriptFromHot() bool {
	w.heading("Reconstruct the conversation from Cosmos DB")
	say("One single-partition query ordered by the sort key, then reassembly: parts grouped by event id, joined in order, and the result checked against the length and SHA-256 the parts declared.")
	say("This is the read a portal would do while the conversation is hot.")
	t, err := pipeline.Load(w.ctx, w.hot, w.blobs, w.seeded.ConversationID, "cosmos")
	if err != nil {
		w.check(false, "load from Cosmos DB failed: %v", err)
		return false
	}
	fmt.Println()
	t.Render(os.Stdout, 90)
	fmt.Println()
	w.check(t.Events == w.seeded.Events, "%d events reconstructed (want %d)", t.Events, w.seeded.Events)
	w.check(t.Segmented == 1, "%d event was segmented and came back whole", t.Segmented)
	w.check(len(t.Problems) == 0, "every segmented event verified by length and SHA-256 (%d problems)", len(t.Problems))
	if w.shuffle != nil {
		w.check(inOrder(t), "events are in seq order 1..%d although they were delivered as %s", t.Events, strings.Join(w.seeded.Order, " "))
	} else {
		w.check(inOrder(t), "events are in seq order 1..%d", t.Events)
	}
	w.fromHot = t
	return len(w.failed) == 0
}

func inOrder(t stream.Transcript) bool {
	for i, ev := range t.Timeline {
		if ev.Seq() != int64(i+1) {
			return false
		}
	}
	return true
}

func (w *walk) foldStep() bool {
	w.heading("Fold the conversation into the archive")
	say("The fold reads the capture container, never Cosmos DB, and folds the raw stream into one verified transcript object.")
	say("Before it deletes anything it checks that capture holds every document Cosmos DB holds. Then it writes archive/%s.json and clears the hot documents.", w.seeded.ConversationID)
	say("In production this is the scheduled job where sanitization runs before the archive write; the hot window is thirty days, not thirty seconds.")
	captured, _, err := w.blobs.CapturedEnvelopes(w.ctx, w.seeded.ConversationID)
	if err != nil {
		w.check(false, "read capture failed: %v", err)
		return false
	}
	out, err := pipeline.FoldOne(w.ctx, w.blobs, w.hot, w.seeded.ConversationID, captured, pipeline.FoldOptions{})
	if err != nil {
		w.check(false, "fold failed: %v", err)
		return false
	}
	w.check(out.Archived, "archive object written%s", reasonSuffix(out.Reason))
	w.check(out.Cleared == w.uniqueMessages(), "%d hot documents cleared (want %d)", out.Cleared, w.uniqueMessages())
	docs, err := w.hot.ConversationDocuments(w.ctx, w.seeded.ConversationID)
	w.check(err == nil && len(docs) == 0, "Cosmos DB now holds 0 documents for the conversation%s", errSuffix(err))
	return out.Archived
}

func reasonSuffix(reason string) string {
	if reason == "" {
		return ""
	}
	return " (" + reason + ")"
}

func (w *walk) transcriptFromArchive() bool {
	w.heading("Reconstruct the conversation again, now from the archive")
	say("Same command a portal would run. Cosmos DB has nothing for this conversation, so the read falls through to the archive object.")
	t, err := pipeline.Load(w.ctx, w.hot, w.blobs, w.seeded.ConversationID, "auto")
	if err != nil {
		w.check(false, "load failed: %v", err)
		return false
	}
	fmt.Println()
	t.Render(os.Stdout, 90)
	fmt.Println()
	w.check(t.Source == "capture", "the archive answered (source %q)", t.Source)
	w.check(sameTimeline(w.fromHot, t), "the archived transcript is event-for-event identical to the one read from Cosmos DB")
	return true
}

// sameTimeline compares two transcripts by event id, seq, and the content
// fields a consumer reads, so a fold that lost or reordered anything shows
// up even though the two were folded from different stores.
func sameTimeline(a, b stream.Transcript) bool {
	if len(a.Timeline) != len(b.Timeline) {
		return false
	}
	for i := range a.Timeline {
		x, y := a.Timeline[i], b.Timeline[i]
		if x.EventID != y.EventID || x.Seq() != y.Seq() || x.Name != y.Name {
			return false
		}
		for _, k := range []string{"text", "output", "model", "action", "tool_name", "outcome"} {
			if x.Payload[k] != y.Payload[k] {
				return false
			}
		}
	}
	return true
}

func main() {
	verbose := flag.Bool("verbose", false, "show the JSON log lines the commands write while they work")
	bigMB := flag.Int("big-mb", 3, "size in MiB of the oversize tool output")
	wait := flag.Duration("wait", 3*time.Minute, "how long to wait for each store to catch up")
	gap := flag.Duration("gap", 500*time.Millisecond, "pause between the seeded messages, so the sequence is visible as one")
	inOrderFlag := flag.Bool("in-order", false, "send the messages in their natural order instead of scrambled")
	flag.Parse()
	stream.SetQuiet(!*verbose)

	conn := os.Getenv("EVENTHUB_CONNECTION_STRING")
	if conn == "" {
		fmt.Fprintln(os.Stderr, "EVENTHUB_CONNECTION_STRING is required (make demo run sets it)")
		os.Exit(2)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Minute)
	defer cancel()
	w := &walk{ctx: ctx, conn: conn, hub: stream.EnvOr("EVENTHUB_NAME", "conversation-events"),
		fnURL: stream.EnvOr("FUNCTION_URL", "http://localhost:7071/"), wait: *wait, gap: *gap}
	if !*inOrderFlag {
		w.shuffle = rand.New(rand.NewSource(time.Now().UnixNano())) //nolint:gosec // a scramble, not a secret
	}

	fmt.Println(bold("Ion conversation pipeline: the whole path, one conversation, every step checked."))
	fmt.Println(dim("engine -> Event Hub -> capture (record of truth) and Cosmos DB (hot index) -> fold -> archive"))

	steps := []func() bool{w.preflight, func() bool { return w.seedStep(*bigMB) }, w.hotStep, w.captureStep, w.transcriptFromHot, w.foldStep, w.transcriptFromArchive}
	for _, s := range steps {
		if !s() {
			break
		}
	}

	fmt.Println()
	if len(w.failed) == 0 {
		fmt.Println(bold(green("PASS")) + ": every check held. The conversation went in once, out of order, and came out whole and in sequence from both stores.")
		return
	}
	fmt.Printf("%s: %d check(s) did not hold:\n", bold(red("FAIL")), len(w.failed))
	for _, f := range w.failed {
		fmt.Printf("  - %s\n", f)
	}
	if !*verbose {
		fmt.Println("re-run with --verbose to see the commands' log lines, or `make demo logs SVC=pipeline-ingest` for the function.")
	}
	os.Exit(1)
}
