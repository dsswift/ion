package conversation

import (
	"path/filepath"

	"github.com/dsswift/ion/engine/internal/types"
)

// recordFileSuffix names the file of a conversation's pair that holds the
// full message history with per-entry timestamps.
const recordFileSuffix = ".tree.jsonl"

// RecordPath returns the absolute path of id's conversation record: the tree
// file Save writes the full, timestamped history to. ownerSubject is the
// principal the conversation is (or will be) attributed to; it decides the
// directory for a conversation that has not been saved yet and is ignored
// once the conversation is indexed in a partition. Empty when id is empty.
//
// The file exists once the conversation's first entry has been persisted.
func RecordPath(id, ownerSubject string) string {
	if id == "" {
		return ""
	}
	dir := recordDir(id, ownerSubject)
	if dir == "" {
		return ""
	}
	return filepath.Join(dir, id+recordFileSuffix)
}

// recordDir resolves the directory Save writes id into, without Save's side
// effects (no marker write, no index registration).
func recordDir(id, ownerSubject string) string {
	if !PartitioningEnabled() {
		return DefaultConversationsDir()
	}
	if dir, ok := lookupPartitionDir(id); ok {
		return dir
	}
	if ownerSubject == "" {
		return DefaultConversationsDir()
	}
	return PartitionConversationsDir(ownerSubject)
}

// LoadReadOnly loads a conversation by ID from disk without writing anything
// back: unlike Load it does not persist a recovery repair found while
// loading. For callers that only inspect the record.
func LoadReadOnly(id string) (*Conversation, error) {
	return load(id, "", false)
}

// ReadMessagesPaginated returns a page of id's messages, each with its
// timestamp, reading the record from disk so an ended conversation is
// readable. Offset is zero-based; limit <= 0 returns every message from
// offset onward. It never writes to the record.
func ReadMessagesPaginated(id string, offset, limit int) (*PaginatedMessages, error) {
	conv, err := LoadReadOnly(id)
	if err != nil {
		return nil, err
	}
	return paginateMessages(flattenEntries(conv), offset, limit), nil
}

// paginateMessages slices all into one page. Offset is zero-based; limit <= 0
// means no page cap.
func paginateMessages(all []types.SessionMessage, offset, limit int) *PaginatedMessages {
	total := len(all)
	if offset < 0 {
		offset = 0
	}
	if offset >= total {
		return &PaginatedMessages{Messages: []types.SessionMessage{}, Total: total, HasMore: false}
	}
	end := total
	if limit > 0 && offset+limit < total {
		end = offset + limit
	}
	return &PaginatedMessages{Messages: all[offset:end], Total: total, HasMore: end < total}
}
