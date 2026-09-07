// Command fold is the warm-to-cold job: for every conversation that has
// been idle past the hot window, it reads the conversation from the record
// of truth (the capture container), folds it into one verified transcript,
// writes that to the archive, and clears the conversation from the hot
// store. It is where ADR-6002's Tier 2 sanitization will run; this sample
// performs the fold and records that sanitization did not.
//
// The fold never destroys what it has not proven it holds: a conversation
// is cleared from the hot store only when every hot document is also in
// capture and the folded transcript verified cleanly. A capture writer
// that is behind, or a segmented event with a missing part, leaves the hot
// documents in place and says so. See internal/pipeline.FoldOne.
package main

import (
	"context"
	"flag"
	"os"
	"sort"
	"time"

	"github.com/dsswift/ion/samples/conversation-pipeline/internal/pipeline"
	"github.com/dsswift/ion/samples/conversation-pipeline/internal/stream"
)

func main() {
	hotWindow := flag.Duration("hot-window", 30*24*time.Hour, "how long a conversation must be idle before it is folded")
	only := flag.String("conversation", "", "fold this conversation regardless of idleness")
	dryRun := flag.Bool("dry-run", false, "report what would be folded without writing or deleting")
	keepHot := flag.Bool("keep-hot", false, "write the archive but leave the hot store untouched")
	flag.Parse()

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
	defer cancel()
	blobs, err := stream.OpenBlobStores(ctx, stream.BlobConfigFromEnv())
	if err != nil {
		stream.Logf("ERROR", "blob stores", map[string]any{"error": err.Error()})
		os.Exit(1)
	}
	hot, err := stream.OpenHotStore(ctx, stream.CosmosConfigFromEnv())
	if err != nil {
		stream.Logf("ERROR", "hot store", map[string]any{"error": err.Error()})
		os.Exit(1)
	}

	captured, files, err := blobs.CapturedEnvelopes(ctx, *only)
	if err != nil {
		stream.Logf("ERROR", "read capture", map[string]any{"error": err.Error()})
		os.Exit(1)
	}
	byConversation := map[string][]stream.Envelope{}
	for _, e := range captured {
		byConversation[e.ConversationID()] = append(byConversation[e.ConversationID()], e)
	}
	stream.Logf("INFO", "capture scanned", map[string]any{"files": files, "messages": len(captured), "conversations": len(byConversation)})

	ids := make([]string, 0, len(byConversation))
	for id := range byConversation {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	folded, skipped := 0, 0
	for _, id := range ids {
		envelopes := byConversation[id]
		idle := time.Since(pipeline.LastActivity(envelopes))
		if *only == "" && idle < *hotWindow {
			stream.Logf("INFO", "conversation still hot; not folded", map[string]any{"conversation_id": id, "idle": idle.Round(time.Second).String(), "hot_window": hotWindow.String()})
			skipped++
			continue
		}
		outcome, err := pipeline.FoldOne(ctx, blobs, hot, id, envelopes, pipeline.FoldOptions{DryRun: *dryRun, KeepHot: *keepHot})
		if err != nil {
			stream.Logf("ERROR", "fold failed; hot store left as is", map[string]any{"conversation_id": id, "error": err.Error()})
			skipped++
			continue
		}
		if outcome.Archived {
			folded++
		} else {
			skipped++
		}
	}
	stream.Logf("INFO", "fold complete", map[string]any{"folded": folded, "skipped": skipped, "dry_run": *dryRun})
}
