package checkpoints

import (
	"testing"
	"time"

	"github.com/Azure/azure-sdk-for-go/sdk/messaging/azeventhubs/v2"
)

// TestStaleReason pins the two proofs and the one case that is not proof.
func TestStaleReason(t *testing.T) {
	created := time.Date(2026, 9, 6, 12, 0, 0, 0, time.UTC)
	hub := Hub{CreatedOn: created, Partitions: map[string]azeventhubs.PartitionProperties{
		"0": {LastEnqueuedSequenceNumber: 6},
	}}
	older := Finding{Partition: "0", Sequence: 3, Modified: created.Add(-time.Hour)}
	if r := staleReason(older, hub); r == "" {
		t.Fatal("a checkpoint written before the hub existed must be stale")
	}
	beyond := Finding{Partition: "0", Sequence: 9, Modified: created.Add(time.Hour)}
	if r := staleReason(beyond, hub); r == "" {
		t.Fatal("a checkpoint past the last enqueued sequence must be stale")
	}
	fine := Finding{Partition: "0", Sequence: 6, Modified: created.Add(time.Hour)}
	if r := staleReason(fine, hub); r != "" {
		t.Fatalf("a current checkpoint must not be stale: %s", r)
	}
	unknownPartition := Finding{Partition: "7", Sequence: 99, Modified: created.Add(time.Hour)}
	if r := staleReason(unknownPartition, hub); r != "" {
		t.Fatalf("a partition the hub did not report cannot be judged by sequence: %s", r)
	}
}
