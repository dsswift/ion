// Command transcript reconstructs one conversation from the hot store or
// the archive — every event, in order, segmented events reassembled and
// verified — and renders it. It is the query tooling ADR-6001 requires,
// in its smallest honest form.
package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"time"

	"github.com/dsswift/ion/samples/conversation-pipeline/internal/pipeline"
	"github.com/dsswift/ion/samples/conversation-pipeline/internal/stream"
)

func main() {
	conversationID := flag.String("conversation", "", "conversation id to reconstruct")
	list := flag.Bool("list", false, "list conversations in the hot store and the archive")
	source := flag.String("source", "auto", "where to read from: auto (hot store, then archive), cosmos, or archive")
	asJSON := flag.Bool("json", false, "emit the folded transcript as JSON instead of a listing")
	verify := flag.Bool("verify", false, "exit non-zero if any event failed reassembly or verification")
	width := flag.Int("width", 100, "column width for the listing")
	flag.Parse()

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()

	if *list {
		listAll(ctx)
		return
	}
	if *conversationID == "" {
		fmt.Fprintln(os.Stderr, "usage: transcript --conversation <id> [--source auto|cosmos|archive] [--json] [--verify] | --list")
		os.Exit(2)
	}
	hot, err := stream.OpenHotStore(ctx, stream.CosmosConfigFromEnv())
	if err != nil {
		stream.Logf("ERROR", "hot store", map[string]any{"error": err.Error()})
		os.Exit(1)
	}
	blobs, err := stream.OpenBlobStores(ctx, stream.BlobConfigFromEnv())
	if err != nil {
		stream.Logf("ERROR", "blob stores", map[string]any{"error": err.Error()})
		os.Exit(1)
	}
	t, err := pipeline.Load(ctx, hot, blobs, *conversationID, *source)
	if err != nil {
		stream.Logf("ERROR", "transcript failed", map[string]any{"conversation_id": *conversationID, "source": *source, "error": err.Error()})
		os.Exit(1)
	}
	if *asJSON {
		enc := json.NewEncoder(os.Stdout)
		enc.SetIndent("", "  ")
		if err := enc.Encode(t); err != nil {
			stream.Logf("ERROR", "encode", map[string]any{"error": err.Error()})
			os.Exit(1)
		}
	} else {
		t.Render(os.Stdout, *width)
	}
	if *verify && len(t.Problems) > 0 {
		stream.Logf("ERROR", "transcript has problems", map[string]any{"conversation_id": *conversationID, "problems": len(t.Problems)})
		os.Exit(3)
	}
}

func listAll(ctx context.Context) {
	hot, err := stream.OpenHotStore(ctx, stream.CosmosConfigFromEnv())
	if err != nil {
		stream.Logf("ERROR", "hot store", map[string]any{"error": err.Error()})
		os.Exit(1)
	}
	summaries, err := hot.Conversations(ctx)
	if err != nil {
		stream.Logf("ERROR", "list hot store", map[string]any{"error": err.Error()})
		os.Exit(1)
	}
	fmt.Printf("hot store: %d conversation(s)\n", len(summaries))
	for _, s := range summaries {
		fmt.Printf("  %-40s user %-22s documents %-5d first %s  last %s\n", s.ConversationID, s.User, s.Documents, keyTime(s.FirstSortKey), keyTime(s.LastSortKey))
	}
	blobs, err := stream.OpenBlobStores(ctx, stream.BlobConfigFromEnv())
	if err != nil {
		stream.Logf("ERROR", "blob stores", map[string]any{"error": err.Error()})
		os.Exit(1)
	}
	archived, err := blobs.ArchivedConversations(ctx)
	if err != nil {
		stream.Logf("ERROR", "list archive", map[string]any{"error": err.Error()})
		os.Exit(1)
	}
	fmt.Printf("archive: %d conversation(s)\n", len(archived))
	for _, id := range archived {
		fmt.Printf("  %s\n", id)
	}
}

// keyTime renders the timestamp half of a sort key.
func keyTime(key string) string {
	var nanos int64
	if _, err := fmt.Sscanf(key, "%d", &nanos); err != nil {
		return key
	}
	return time.Unix(0, nanos).UTC().Format("2006-01-02 15:04:05.000")
}
