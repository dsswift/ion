// Command capture stands in for Event Hubs Capture, which the local emulator
// does not provide: it reads the hub on its own consumer group and writes
// every event to blob storage as Avro files laid out exactly the way Capture
// lays them out ({namespace}/{hub}/{partition}/{yyyy}/{MM}/{dd}/{HH}/{mm}/{ss}.avro),
// windowed by time or size. In Azure this process does not exist — Capture
// is a checkbox on the hub — and the blob container it fills is the record
// of truth the fold job reads from.
package main

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/Azure/azure-sdk-for-go/sdk/azcore/log"
	"github.com/Azure/azure-sdk-for-go/sdk/azcore/to"
	"github.com/Azure/azure-sdk-for-go/sdk/messaging/azeventhubs/v2"
	ehcheckpoints "github.com/Azure/azure-sdk-for-go/sdk/messaging/azeventhubs/v2/checkpoints"
	"github.com/Azure/azure-sdk-for-go/sdk/storage/azblob"
	"github.com/Azure/azure-sdk-for-go/sdk/storage/azblob/bloberror"
	"github.com/Azure/azure-sdk-for-go/sdk/storage/azblob/container"

	"github.com/dsswift/ion/samples/conversation-pipeline/internal/checkpoints"
	"github.com/dsswift/ion/samples/conversation-pipeline/internal/stream"
)

// The SDK's own log is the only record of a partition the processor could
// not open (a stale checkpoint, a lost link); without this listener that
// failure is invisible, and an invisible failure is a defect.
func init() {
	log.SetEvents(azeventhubs.EventConsumer, azeventhubs.EventConn, azeventhubs.EventAuth)
	log.SetListener(func(event log.Event, msg string) {
		level := "INFO"
		if strings.Contains(msg, "error") || strings.Contains(msg, "Error") || strings.Contains(msg, "failed") {
			level = "WARN"
		}
		stream.Logf(level, "eventhubs sdk", map[string]any{"event": string(event), "detail": msg})
	})
}

type config struct {
	eventHubConn  string
	eventHubName  string
	namespace     string
	consumerGroup string
	blobConn      string
	container     string
	windowSeconds int
	windowBytes   int
}

func loadConfig() config {
	secs, _ := strconv.Atoi(stream.EnvOr("CAPTURE_WINDOW_SECONDS", "60"))
	bytes, _ := strconv.Atoi(stream.EnvOr("CAPTURE_WINDOW_BYTES", strconv.Itoa(10*1024*1024)))
	return config{
		eventHubConn:  os.Getenv("EVENTHUB_CONNECTION_STRING"),
		eventHubName:  stream.EnvOr("EVENTHUB_NAME", "conversation-events"),
		namespace:     stream.EnvOr("EVENTHUB_NAMESPACE", "emulatorns1"),
		consumerGroup: stream.EnvOr("CAPTURE_CONSUMER_GROUP", "capture"),
		blobConn:      os.Getenv("BLOB_CONNECTION_STRING"),
		container:     stream.EnvOr("CAPTURE_CONTAINER", "capture"),
		windowSeconds: secs,
		windowBytes:   bytes,
	}
}

func ensureContainer(ctx context.Context, c *container.Client) error {
	_, err := c.Create(ctx, nil)
	if err != nil && !bloberror.HasCode(err, bloberror.ContainerAlreadyExists) {
		return err
	}
	return nil
}

func main() {
	cfg := loadConfig()
	if cfg.eventHubConn == "" || cfg.blobConn == "" {
		stream.Logf("ERROR", "EVENTHUB_CONNECTION_STRING and BLOB_CONNECTION_STRING are required", nil)
		os.Exit(2)
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	blobClient, err := azblob.NewClientFromConnectionString(cfg.blobConn, nil)
	if err != nil {
		stream.Logf("ERROR", "blob client", map[string]any{"error": err.Error()})
		os.Exit(1)
	}
	capture := blobClient.ServiceClient().NewContainerClient(cfg.container)
	checkpointContainer := blobClient.ServiceClient().NewContainerClient(cfg.container + "-checkpoints")
	for _, c := range []*container.Client{capture, checkpointContainer} {
		if err := ensureContainer(ctx, c); err != nil {
			stream.Logf("ERROR", "blob container create", map[string]any{"error": err.Error()})
			os.Exit(1)
		}
	}
	// Before trusting the checkpoints in that container, prove they belong
	// to the hub as it exists now; a checkpoint from a recreated hub would
	// otherwise leave a partition unreadable or silently skip its start.
	if _, findings, err := checkpoints.Audit(ctx, cfg.eventHubConn, cfg.eventHubName, blobClient,
		[]checkpoints.Group{{Container: cfg.container + "-checkpoints", ConsumerGroup: cfg.consumerGroup}}, true); err != nil {
		stream.Logf("ERROR", "checkpoint audit failed; starting with the checkpoints as they are", map[string]any{"error": err.Error()})
	} else if stale := checkpoints.Stale(findings); len(stale) > 0 {
		stream.Logf("WARN", "stale checkpoints removed; the partitions they covered restart from the beginning of the hub", map[string]any{"count": len(stale)})
	}
	store, err := ehcheckpoints.NewBlobStore(checkpointContainer, nil)
	if err != nil {
		stream.Logf("ERROR", "checkpoint store", map[string]any{"error": err.Error()})
		os.Exit(1)
	}
	consumer, err := azeventhubs.NewConsumerClientFromConnectionString(cfg.eventHubConn, cfg.eventHubName, cfg.consumerGroup, nil)
	if err != nil {
		stream.Logf("ERROR", "consumer client", map[string]any{"error": err.Error()})
		os.Exit(1)
	}
	defer consumer.Close(context.Background()) //nolint:errcheck // shutdown
	processor, err := azeventhubs.NewProcessor(consumer, store, &azeventhubs.ProcessorOptions{
		StartPositions: azeventhubs.StartPositions{Default: azeventhubs.StartPosition{Earliest: to.Ptr(true)}},
	})
	if err != nil {
		stream.Logf("ERROR", "processor", map[string]any{"error": err.Error()})
		os.Exit(1)
	}
	stream.Logf("INFO", "capture writer starting", map[string]any{
		"event_hub": cfg.eventHubName, "consumer_group": cfg.consumerGroup, "container": cfg.container,
		"window_seconds": cfg.windowSeconds, "window_bytes": cfg.windowBytes,
	})

	go func() {
		for {
			pc := processor.NextPartitionClient(ctx)
			if pc == nil {
				return
			}
			go runPartition(ctx, cfg, capture, pc)
		}
	}()
	if err := processor.Run(ctx); err != nil && ctx.Err() == nil {
		stream.Logf("ERROR", "processor stopped", map[string]any{"error": err.Error()})
		os.Exit(1)
	}
	stream.Logf("INFO", "capture writer stopped", nil)
}

// window accumulates one partition's events until the time or size bound.
type window struct {
	partition string
	records   []stream.CaptureRecord
	last      *azeventhubs.ReceivedEventData
	bytes     int
	openedAt  time.Time
}

func (w *window) add(ev *azeventhubs.ReceivedEventData) {
	if len(w.records) == 0 {
		w.openedAt = time.Now()
	}
	enq := ""
	if ev.EnqueuedTime != nil {
		enq = ev.EnqueuedTime.UTC().Format(time.RFC3339Nano)
	}
	w.records = append(w.records, stream.CaptureRecord{
		SequenceNumber: ev.SequenceNumber, Offset: fmt.Sprint(ev.Offset), EnqueuedTimeUtc: enq, Body: ev.Body,
	})
	w.bytes += len(ev.Body)
	w.last = ev
}

func (w *window) due(cfg config) bool {
	if len(w.records) == 0 {
		return false
	}
	return time.Since(w.openedAt) >= time.Duration(cfg.windowSeconds)*time.Second || w.bytes >= cfg.windowBytes
}

// flush writes the window as one Avro blob at the Capture path for now, then
// checkpoints so a restart resumes after it. The checkpoint follows the
// write, never precedes it: a crash between the two replays the window,
// which the idempotent stores downstream absorb, whereas the reverse order
// would lose it.
func (w *window) flush(ctx context.Context, cfg config, c *container.Client, pc *azeventhubs.ProcessorPartitionClient) {
	if len(w.records) == 0 {
		return
	}
	now := time.Now().UTC()
	name := fmt.Sprintf("%s/%s/%s/%04d/%02d/%02d/%02d/%02d/%02d.avro", cfg.namespace, cfg.eventHubName, w.partition,
		now.Year(), now.Month(), now.Day(), now.Hour(), now.Minute(), now.Second())
	data, err := stream.EncodeCapture(w.records)
	if err != nil {
		stream.Logf("ERROR", "capture window encode failed; window retained", map[string]any{"partition": w.partition, "error": err.Error()})
		return
	}
	if _, err := c.NewBlockBlobClient(name).UploadBuffer(ctx, data, nil); err != nil {
		stream.Logf("ERROR", "capture window upload failed; window retained for retry", map[string]any{"partition": w.partition, "blob": name, "error": err.Error()})
		return
	}
	stream.Logf("INFO", "capture window written", map[string]any{
		"partition": w.partition, "blob": name, "events": len(w.records), "body_bytes": w.bytes, "avro_bytes": len(data),
		"last_sequence_number": w.last.SequenceNumber,
	})
	if err := pc.UpdateCheckpoint(ctx, w.last, nil); err != nil {
		stream.Logf("WARN", "checkpoint update failed; window will replay after restart", map[string]any{"partition": w.partition, "error": err.Error()})
	}
	w.records, w.bytes, w.last = nil, 0, nil
}

func runPartition(ctx context.Context, cfg config, c *container.Client, pc *azeventhubs.ProcessorPartitionClient) {
	defer pc.Close(context.Background()) //nolint:errcheck // shutdown
	w := &window{partition: pc.PartitionID()}
	stream.Logf("INFO", "partition claimed", map[string]any{"partition": w.partition})
	for {
		rctx, cancel := context.WithTimeout(ctx, 5*time.Second)
		events, err := pc.ReceiveEvents(rctx, 200, nil)
		cancel()
		if err != nil && !errors.Is(err, context.DeadlineExceeded) {
			if ctx.Err() != nil {
				w.flush(context.Background(), cfg, c, pc)
				return
			}
			var ehErr *azeventhubs.Error
			if errors.As(err, &ehErr) && ehErr.Code == azeventhubs.ErrorCodeOwnershipLost {
				stream.Logf("INFO", "partition ownership lost", map[string]any{"partition": w.partition})
				return
			}
			stream.Logf("ERROR", "receive failed", map[string]any{"partition": w.partition, "error": err.Error()})
			time.Sleep(2 * time.Second)
			continue
		}
		for _, ev := range events {
			w.add(ev)
		}
		if w.due(cfg) {
			w.flush(ctx, cfg, c, pc)
		}
	}
}
