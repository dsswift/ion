// Package pipeline holds the two operations the commands and the guided
// demo share: loading one conversation from the hot store or the archive,
// and folding one conversation from capture into the archive.
package pipeline

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/dsswift/ion/samples/conversation-pipeline/internal/stream"
)

// LastActivity is the latest event timestamp among envelopes.
func LastActivity(envelopes []stream.Envelope) time.Time {
	var last time.Time
	for _, e := range envelopes {
		if t, err := time.Parse(time.RFC3339Nano, e.Ts); err == nil && t.After(last) {
			last = t
		}
	}
	return last
}

// FoldOptions tunes FoldOne.
type FoldOptions struct {
	DryRun  bool
	KeepHot bool
}

// FoldOutcome is what FoldOne did.
type FoldOutcome struct {
	// Archived is true when the archive object was written (or would be,
	// on a dry run). Cleared is how many hot documents were deleted.
	Archived   bool
	Cleared    int
	Transcript stream.Transcript
	// Reason explains a skip: capture behind the hot store, or already
	// archived and current.
	Reason string
}

// FoldOne folds one conversation from its captured envelopes. It never
// clears the hot store unless capture holds every hot document and the
// folded transcript verified cleanly.
func FoldOne(ctx context.Context, blobs *stream.BlobStores, hot *stream.HotStore, id string, captured []stream.Envelope, opts FoldOptions) (FoldOutcome, error) {
	hotDocs, err := hot.ConversationDocuments(ctx, id)
	if err != nil {
		return FoldOutcome{}, err
	}
	// The record of truth must hold everything the hot store holds before
	// the hot copy can go. A capture window that has not flushed yet shows
	// up here as hot documents with no captured counterpart.
	inCapture := map[string]bool{}
	for _, e := range captured {
		inCapture[e.DocumentID()] = true
	}
	missing := 0
	for _, d := range hotDocs {
		if !inCapture[d.ID] {
			missing++
		}
	}
	if missing > 0 {
		stream.Logf("WARN", "capture is behind the hot store; conversation not folded yet", map[string]any{
			"conversation_id": id, "hot_documents": len(hotDocs), "captured_messages": len(captured), "missing_from_capture": missing,
		})
		return FoldOutcome{Reason: fmt.Sprintf("capture is behind the hot store by %d message(s)", missing)}, nil
	}

	// Skip a conversation whose archive already reflects every captured
	// message and whose hot copy is already gone: nothing new to fold.
	existing, err := blobs.ReadArchive(ctx, id)
	switch {
	case err == nil && existing.Messages == len(captured) && len(hotDocs) == 0:
		stream.Logf("INFO", "already archived and current", map[string]any{"conversation_id": id, "messages": len(captured), "folded_at": existing.FoldedAt})
		return FoldOutcome{Reason: "already archived and current", Transcript: existing}, nil
	case err != nil && !errors.Is(err, stream.ErrNotArchived):
		return FoldOutcome{}, err
	}

	t, err := stream.Fold(id, "capture", captured)
	if err != nil {
		return FoldOutcome{}, err
	}
	if len(t.Problems) > 0 {
		stream.Logf("WARN", "transcript has verification problems; archived for visibility, hot store kept", map[string]any{
			"conversation_id": id, "problems": t.Problems,
		})
	}
	if opts.DryRun {
		stream.Logf("INFO", "dry run: would fold", map[string]any{"conversation_id": id, "messages": t.Messages, "events": t.Events, "segmented": t.Segmented, "hot_documents": len(hotDocs)})
		return FoldOutcome{Archived: true, Transcript: t}, nil
	}
	name, err := blobs.WriteArchive(ctx, t)
	if err != nil {
		return FoldOutcome{}, err
	}
	stream.Logf("INFO", "archive written", map[string]any{"conversation_id": id, "blob": name, "messages": t.Messages, "events": t.Events, "segmented": t.Segmented, "problems": len(t.Problems)})
	if opts.KeepHot || len(t.Problems) > 0 {
		return FoldOutcome{Archived: true, Transcript: t}, nil
	}
	deleted, err := hot.DeleteConversation(ctx, id)
	if err != nil {
		return FoldOutcome{}, fmt.Errorf("archive written but hot store clear failed: %w", err)
	}
	stream.Logf("INFO", "hot store cleared", map[string]any{"conversation_id": id, "deleted_documents": deleted})
	return FoldOutcome{Archived: true, Cleared: deleted, Transcript: t}, nil
}

// ErrNotFound is returned by Load when neither store holds the conversation.
var ErrNotFound = errors.New("conversation is in neither the hot store nor the archive")

// Load reads and folds one conversation. source is "auto" (hot store, then
// archive), "cosmos", or "archive". The returned transcript's Source says
// which store answered.
func Load(ctx context.Context, hot *stream.HotStore, blobs *stream.BlobStores, conversationID, source string) (stream.Transcript, error) {
	if source == "cosmos" || source == "auto" {
		docs, err := hot.ConversationDocuments(ctx, conversationID)
		if err != nil {
			return stream.Transcript{}, err
		}
		stream.Logf("INFO", "hot store read", map[string]any{"conversation_id": conversationID, "documents": len(docs)})
		if len(docs) > 0 {
			return stream.Fold(conversationID, "cosmos", stream.Envelopes(docs))
		}
		if source == "cosmos" {
			return stream.Transcript{}, fmt.Errorf("conversation %s is not in the hot store", conversationID)
		}
		stream.Logf("INFO", "hot store has no documents; trying the archive", map[string]any{"conversation_id": conversationID})
	}
	t, err := blobs.ReadArchive(ctx, conversationID)
	if errors.Is(err, stream.ErrNotArchived) {
		return stream.Transcript{}, ErrNotFound
	}
	if err != nil {
		return stream.Transcript{}, err
	}
	stream.Logf("INFO", "archive read", map[string]any{"conversation_id": conversationID, "events": t.Events, "folded_at": t.FoldedAt})
	return t, nil
}
