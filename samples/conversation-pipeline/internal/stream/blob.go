package stream

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"strings"

	"github.com/Azure/azure-sdk-for-go/sdk/storage/azblob"
	"github.com/Azure/azure-sdk-for-go/sdk/storage/azblob/bloberror"
	"github.com/Azure/azure-sdk-for-go/sdk/storage/azblob/container"
)

// blob.go is the two blob-backed stores: the capture container (the record
// of truth: every delivered message, as Event Hubs Capture lays it out) and
// the archive container (one folded transcript per conversation).

// BlobConfig locates the storage account and the two containers.
type BlobConfig struct {
	ConnectionString string
	CaptureContainer string
	ArchiveContainer string
}

// BlobConfigFromEnv reads BLOB_CONNECTION_STRING, CAPTURE_CONTAINER, and
// ARCHIVE_CONTAINER with the sample's defaults.
func BlobConfigFromEnv() BlobConfig {
	return BlobConfig{
		ConnectionString: os.Getenv("BLOB_CONNECTION_STRING"),
		CaptureContainer: EnvOr("CAPTURE_CONTAINER", "capture"),
		ArchiveContainer: EnvOr("ARCHIVE_CONTAINER", "archive"),
	}
}

// BlobStores is a client for both containers.
type BlobStores struct {
	client  *azblob.Client
	capture *container.Client
	archive *container.Client
	cfg     BlobConfig
}

// OpenBlobStores connects and ensures both containers exist.
func OpenBlobStores(ctx context.Context, cfg BlobConfig) (*BlobStores, error) {
	if cfg.ConnectionString == "" {
		return nil, fmt.Errorf("BLOB_CONNECTION_STRING is required")
	}
	client, err := azblob.NewClientFromConnectionString(cfg.ConnectionString, nil)
	if err != nil {
		return nil, fmt.Errorf("blob client: %w", err)
	}
	b := &BlobStores{client: client, cfg: cfg}
	b.capture = client.ServiceClient().NewContainerClient(cfg.CaptureContainer)
	b.archive = client.ServiceClient().NewContainerClient(cfg.ArchiveContainer)
	for _, c := range []*container.Client{b.capture, b.archive} {
		if _, err := c.Create(ctx, nil); err != nil && !bloberror.HasCode(err, bloberror.ContainerAlreadyExists) {
			return nil, fmt.Errorf("blob container create: %w", err)
		}
	}
	Logf("INFO", "blob stores open", map[string]any{"capture": cfg.CaptureContainer, "archive": cfg.ArchiveContainer})
	return b, nil
}

// CaptureContainer is the container the capture writer fills.
func (b *BlobStores) CaptureContainer() *container.Client { return b.capture }

// CapturedEnvelopes reads every capture file and returns the envelopes it
// holds, filtered to one conversation when conversationID is non-empty.
// This is a full scan of the capture container, which is what a fold over
// a demo-sized container can afford; a production fold reads the Capture
// files for its time window, since Capture names them by enqueue time.
func (b *BlobStores) CapturedEnvelopes(ctx context.Context, conversationID string) ([]Envelope, int, error) {
	pager := b.capture.NewListBlobsFlatPager(nil)
	var out []Envelope
	files := 0
	for pager.More() {
		page, err := pager.NextPage(ctx)
		if err != nil {
			return nil, files, fmt.Errorf("list capture blobs: %w", err)
		}
		for _, item := range page.Segment.BlobItems {
			if item.Name == nil || !strings.HasSuffix(*item.Name, ".avro") {
				continue
			}
			files++
			resp, err := b.capture.NewBlobClient(*item.Name).DownloadStream(ctx, nil)
			if err != nil {
				return nil, files, fmt.Errorf("download %s: %w", *item.Name, err)
			}
			records, err := DecodeCapture(resp.Body)
			closeErr := resp.Body.Close()
			if err != nil {
				return nil, files, fmt.Errorf("decode %s: %w", *item.Name, err)
			}
			if closeErr != nil {
				Logf("WARN", "capture blob body close failed", map[string]any{"blob": *item.Name, "error": closeErr.Error()})
			}
			for _, r := range records {
				e, err := Parse(r.Body)
				if err != nil {
					Logf("WARN", "capture record is not a stream event; skipped", map[string]any{"blob": *item.Name, "sequence_number": r.SequenceNumber, "error": err.Error()})
					continue
				}
				if conversationID != "" && e.ConversationID() != conversationID {
					continue
				}
				out = append(out, e)
			}
		}
	}
	return out, files, nil
}

// archiveName is the blob one conversation's folded transcript lives at.
func archiveName(conversationID string) string { return conversationID + ".json" }

// WriteArchive stores a folded transcript, overwriting any earlier fold of
// the same conversation (a re-fold after late events is a newer, fuller
// record, never a duplicate).
func (b *BlobStores) WriteArchive(ctx context.Context, t Transcript) (string, error) {
	data, err := json.MarshalIndent(t, "", "  ")
	if err != nil {
		return "", fmt.Errorf("transcript marshal: %w", err)
	}
	name := archiveName(t.ConversationID)
	if _, err := b.archive.NewBlockBlobClient(name).UploadBuffer(ctx, data, nil); err != nil {
		return "", fmt.Errorf("archive upload %s: %w", name, err)
	}
	return name, nil
}

// ErrNotArchived is returned when a conversation has no archive object.
var ErrNotArchived = errors.New("conversation is not in the archive")

// ReadArchive loads a folded transcript.
func (b *BlobStores) ReadArchive(ctx context.Context, conversationID string) (Transcript, error) {
	resp, err := b.archive.NewBlobClient(archiveName(conversationID)).DownloadStream(ctx, nil)
	if err != nil {
		if bloberror.HasCode(err, bloberror.BlobNotFound) {
			return Transcript{}, ErrNotArchived
		}
		return Transcript{}, fmt.Errorf("archive download: %w", err)
	}
	defer func() {
		if err := resp.Body.Close(); err != nil {
			Logf("WARN", "archive body close failed", map[string]any{"error": err.Error()})
		}
	}()
	var buf bytes.Buffer
	if _, err := io.Copy(&buf, resp.Body); err != nil {
		return Transcript{}, fmt.Errorf("archive read: %w", err)
	}
	var t Transcript
	if err := json.Unmarshal(buf.Bytes(), &t); err != nil {
		return Transcript{}, fmt.Errorf("archive decode: %w", err)
	}
	return t, nil
}

// ArchivedConversations lists the conversation ids with an archive object.
func (b *BlobStores) ArchivedConversations(ctx context.Context) ([]string, error) {
	pager := b.archive.NewListBlobsFlatPager(nil)
	var out []string
	for pager.More() {
		page, err := pager.NextPage(ctx)
		if err != nil {
			return nil, fmt.Errorf("list archive: %w", err)
		}
		for _, item := range page.Segment.BlobItems {
			if item.Name != nil && strings.HasSuffix(*item.Name, ".json") {
				out = append(out, strings.TrimSuffix(*item.Name, ".json"))
			}
		}
	}
	return out, nil
}
