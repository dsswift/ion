// Command checkpoints audits the consumers' blob checkpoints against the
// hub and, with --repair, deletes the ones that cannot belong to it. Run it
// after the hub has been recreated; make demo up does. See
// internal/checkpoints for the two proofs it uses.
package main

import (
	"context"
	"flag"
	"fmt"
	"os"
	"time"

	"github.com/Azure/azure-sdk-for-go/sdk/storage/azblob"

	"github.com/dsswift/ion/samples/conversation-pipeline/internal/checkpoints"
	"github.com/dsswift/ion/samples/conversation-pipeline/internal/stream"
)

func main() {
	repair := flag.Bool("repair", false, "delete stale checkpoints and their ownership records")
	flag.Parse()
	conn := os.Getenv("EVENTHUB_CONNECTION_STRING")
	blobConn := os.Getenv("BLOB_CONNECTION_STRING")
	if conn == "" || blobConn == "" {
		fmt.Fprintln(os.Stderr, "EVENTHUB_CONNECTION_STRING and BLOB_CONNECTION_STRING are required")
		os.Exit(2)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	blobs, err := azblob.NewClientFromConnectionString(blobConn, nil)
	if err != nil {
		stream.Logf("ERROR", "blob client", map[string]any{"error": err.Error()})
		os.Exit(1)
	}
	hub, findings, err := checkpoints.Audit(ctx, conn, stream.EnvOr("EVENTHUB_NAME", "conversation-events"), blobs, checkpoints.DefaultGroups(), *repair)
	if err != nil {
		stream.Logf("ERROR", "checkpoint audit failed", map[string]any{"error": err.Error()})
		os.Exit(1)
	}
	fmt.Printf("hub %s created %s, %d partition(s)\n", hub.Name, hub.CreatedOn.UTC().Format(time.RFC3339), len(hub.Partitions))
	for _, f := range findings {
		state := "ok"
		switch {
		case f.Repaired:
			state = "stale, deleted"
		case f.Stale != "":
			state = "stale, kept (run with --repair)"
		}
		fmt.Printf("  %-8s partition %s  sequence %-4d modified %s  %s", f.Group.ConsumerGroup, f.Partition, f.Sequence, f.Modified.UTC().Format(time.RFC3339), state)
		if f.Stale != "" {
			fmt.Printf(": %s", f.Stale)
		}
		fmt.Println()
	}
	if stale := checkpoints.Stale(findings); len(stale) > 0 && !*repair {
		os.Exit(3)
	}
}
