// Package checkpoints audits the blob checkpoints the hub's consumers keep
// and removes the ones that cannot belong to the hub as it exists now.
//
// A checkpoint outlives the stream it points into. When a hub is recreated
// (the local emulator on every redeploy; in Azure, a rebuilt namespace or a
// checkpoint that fell behind the retention window) the offsets it records
// no longer mean anything, and every consumer that trusts them either fails
// forever ("the supplied offset is invalid") or, worse, silently skips
// everything the new hub holds below the old sequence number. Neither SDK
// resets on its own. This package makes the decision explicit and checkable:
//
//   - a checkpoint blob last modified before the hub was created cannot be
//     for this hub;
//   - a checkpoint whose sequence number is past the partition's last
//     enqueued sequence number points beyond the end of the stream.
//
// Either condition is proof, not a guess, and the repair is to delete the
// checkpoint (and the partition's ownership record, so the consumer
// re-claims it and starts from the beginning of what the hub still holds).
package checkpoints

import (
	"context"
	"fmt"
	"strconv"
	"strings"
	"time"

	"github.com/Azure/azure-sdk-for-go/sdk/messaging/azeventhubs/v2"
	"github.com/Azure/azure-sdk-for-go/sdk/storage/azblob"
	"github.com/Azure/azure-sdk-for-go/sdk/storage/azblob/bloberror"

	"github.com/dsswift/ion/samples/conversation-pipeline/internal/stream"
)

// Group is one consumer group's checkpoint store: the blob container it
// writes to and the group name.
type Group struct {
	Container     string
	ConsumerGroup string
}

// Finding is one checkpoint the audit examined.
type Finding struct {
	Group     Group
	Partition string
	Blob      string
	Sequence  int64
	Modified  time.Time
	// Stale is set with the reason when the checkpoint cannot be for the
	// current hub. Repaired is true when it was deleted.
	Stale    string
	Repaired bool
}

// Hub is what the audit learned about the hub itself.
type Hub struct {
	Name       string
	CreatedOn  time.Time
	Partitions map[string]azeventhubs.PartitionProperties
}

// Audit compares every checkpoint in the given groups with the hub. With
// repair set, stale checkpoints and their ownership records are deleted.
func Audit(ctx context.Context, hubConn, hubName string, blobs *azblob.Client, groups []Group, repair bool) (Hub, []Finding, error) {
	consumer, err := azeventhubs.NewConsumerClientFromConnectionString(hubConn, hubName, azeventhubs.DefaultConsumerGroup, nil)
	if err != nil {
		return Hub{}, nil, fmt.Errorf("consumer client: %w", err)
	}
	defer consumer.Close(context.Background()) //nolint:errcheck // audit cleanup
	props, err := consumer.GetEventHubProperties(ctx, nil)
	if err != nil {
		return Hub{}, nil, fmt.Errorf("hub properties: %w", err)
	}
	hub := Hub{Name: props.Name, CreatedOn: props.CreatedOn, Partitions: map[string]azeventhubs.PartitionProperties{}}
	for _, pid := range props.PartitionIDs {
		pp, err := consumer.GetPartitionProperties(ctx, pid, nil)
		if err != nil {
			return Hub{}, nil, fmt.Errorf("partition %s properties: %w", pid, err)
		}
		hub.Partitions[pid] = pp
	}
	stream.Logf("INFO", "hub inspected for checkpoint audit", map[string]any{"hub": hub.Name, "created_on": hub.CreatedOn.UTC().Format(time.RFC3339), "partitions": len(hub.Partitions)})

	var findings []Finding
	for _, g := range groups {
		fs, err := auditGroup(ctx, blobs, g, hub, repair)
		if err != nil {
			return hub, findings, err
		}
		findings = append(findings, fs...)
	}
	return hub, findings, nil
}

func auditGroup(ctx context.Context, blobs *azblob.Client, g Group, hub Hub, repair bool) ([]Finding, error) {
	container := blobs.ServiceClient().NewContainerClient(g.Container)
	pager := container.NewListBlobsFlatPager(&azblob.ListBlobsFlatOptions{Include: azblob.ListBlobsInclude{Metadata: true}})
	var findings []Finding
	for pager.More() {
		page, err := pager.NextPage(ctx)
		if err != nil {
			if bloberror.HasCode(err, bloberror.ContainerNotFound) {
				stream.Logf("INFO", "checkpoint container does not exist yet; nothing to audit", map[string]any{"container": g.Container, "consumer_group": g.ConsumerGroup})
				return nil, nil
			}
			return nil, fmt.Errorf("list %s: %w", g.Container, err)
		}
		for _, item := range page.Segment.BlobItems {
			if item.Name == nil {
				continue
			}
			marker := "/" + g.ConsumerGroup + "/checkpoint/"
			idx := strings.Index(*item.Name, marker)
			if idx < 0 {
				continue
			}
			f := Finding{Group: g, Partition: (*item.Name)[idx+len(marker):], Blob: *item.Name}
			if item.Properties != nil && item.Properties.LastModified != nil {
				f.Modified = *item.Properties.LastModified
			}
			if seq, ok := item.Metadata["sequencenumber"]; ok && seq != nil {
				f.Sequence, _ = strconv.ParseInt(*seq, 10, 64) //nolint:errcheck // an unparsable value reads as 0, which the audit treats as unknown
			}
			f.Stale = staleReason(f, hub)
			if f.Stale != "" && repair {
				if err := deleteBlob(ctx, blobs, g.Container, f.Blob); err != nil {
					return findings, err
				}
				owner := strings.Replace(f.Blob, "/checkpoint/", "/ownership/", 1)
				if err := deleteBlob(ctx, blobs, g.Container, owner); err != nil {
					return findings, err
				}
				f.Repaired = true
			}
			level := "INFO"
			if f.Stale != "" {
				level = "WARN"
			}
			stream.Logf(level, "checkpoint audited", map[string]any{
				"consumer_group": g.ConsumerGroup, "partition": f.Partition, "sequence": f.Sequence,
				"modified": f.Modified.UTC().Format(time.RFC3339), "stale": f.Stale, "repaired": f.Repaired,
			})
			findings = append(findings, f)
		}
	}
	return findings, nil
}

// staleReason returns why a checkpoint cannot be for the current hub, or
// empty when it can.
func staleReason(f Finding, hub Hub) string {
	if !f.Modified.IsZero() && !hub.CreatedOn.IsZero() && f.Modified.Before(hub.CreatedOn) {
		return fmt.Sprintf("written %s before the hub was created %s", f.Modified.UTC().Format(time.RFC3339), hub.CreatedOn.UTC().Format(time.RFC3339))
	}
	if pp, ok := hub.Partitions[f.Partition]; ok && f.Sequence > pp.LastEnqueuedSequenceNumber {
		return fmt.Sprintf("sequence %d is past the partition's last enqueued sequence %d", f.Sequence, pp.LastEnqueuedSequenceNumber)
	}
	return ""
}

func deleteBlob(ctx context.Context, blobs *azblob.Client, container, name string) error {
	if _, err := blobs.DeleteBlob(ctx, container, name, nil); err != nil && !bloberror.HasCode(err, bloberror.BlobNotFound) {
		return fmt.Errorf("delete %s/%s: %w", container, name, err)
	}
	return nil
}

// Stale returns the findings that were stale.
func Stale(findings []Finding) []Finding {
	var out []Finding
	for _, f := range findings {
		if f.Stale != "" {
			out = append(out, f)
		}
	}
	return out
}

// DefaultGroups are the two consumer groups this sample runs: the capture
// writer's store and the Functions host's store (its container name is the
// Event Hubs extension's fixed choice).
func DefaultGroups() []Group {
	return []Group{
		{Container: stream.EnvOr("CAPTURE_CONTAINER", "capture") + "-checkpoints", ConsumerGroup: stream.EnvOr("CAPTURE_CONSUMER_GROUP", "capture")},
		{Container: "azure-webjobs-eventhub", ConsumerGroup: stream.EnvOr("EVENTHUB_CONSUMER_GROUP", "ingest")},
	}
}
