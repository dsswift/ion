package conversation

import (
	"fmt"

	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

// AppendEntry adds an entry to the tree, chained from the current leaf.
// Safe for concurrent use; see lock.go for the package locking discipline.
func AppendEntry(conv *Conversation, entryType SessionEntryType, data any) *SessionEntry {
	conv.lock()
	defer conv.unlock()
	return appendEntryLocked(conv, entryType, data, "")
}

// Branch moves the leaf pointer to an existing entry and rebuilds the message list.
func Branch(conv *Conversation, entryID string) ([]types.LlmMessage, error) {
	conv.lock()
	defer conv.unlock()
	if conv.Entries == nil {
		return conv.Messages, nil
	}
	found := false
	for _, e := range conv.Entries {
		if e.ID == entryID {
			found = true
			break
		}
	}
	if !found {
		return nil, fmt.Errorf("entry not found: %s", entryID)
	}
	setLeafLocked(conv, entryID)
	conv.Messages = buildContextPathLocked(conv)
	return conv.Messages, nil
}

// BuildContextPath walks from the current leaf to the root and extracts messages.
// Safe for concurrent use.
func BuildContextPath(conv *Conversation) []types.LlmMessage {
	conv.lock()
	defer conv.unlock()
	return buildContextPathLocked(conv)
}

// NavigateTree moves the leaf pointer to target and rebuilds messages.
func NavigateTree(conv *Conversation, targetID string) ([]types.LlmMessage, error) {
	return Branch(conv, targetID)
}

// BranchBefore moves the leaf pointer to the PARENT of the given entry and
// rebuilds the message list. This is the tree-native rewind primitive: a
// consumer rewinding "to before user turn X" branches at X's parent so the
// next appended turn becomes X's sibling — replacing it on the active path —
// instead of chaining after the old leaf and duplicating it. When the entry
// is a root (no parent), the leaf clears and the context path empties: the
// next turn starts a fresh branch from the top.
func BranchBefore(conv *Conversation, entryID string) ([]types.LlmMessage, error) {
	conv.lock()
	defer conv.unlock()
	if conv.Entries == nil {
		return conv.Messages, nil
	}
	var parent *string
	found := false
	for i := range conv.Entries {
		if conv.Entries[i].ID == entryID {
			parent = conv.Entries[i].ParentID
			found = true
			break
		}
	}
	if !found {
		return nil, fmt.Errorf("entry not found: %s", entryID)
	}
	if parent == nil {
		conv.LeafID = nil
		conv.Messages = nil
		return conv.Messages, nil
	}
	setLeafLocked(conv, *parent)
	conv.Messages = buildContextPathLocked(conv)
	return conv.Messages, nil
}

// GetTree builds the full tree structure for visualization.
func GetTree(conv *Conversation) []TreeNode {
	conv.lock()
	defer conv.unlock()
	if len(conv.Entries) == 0 {
		return nil
	}

	childMap := make(map[string][]SessionEntry)
	for _, entry := range conv.Entries {
		key := ""
		if entry.ParentID != nil {
			key = *entry.ParentID
		}
		childMap[key] = append(childMap[key], entry)
	}

	var buildNode func(SessionEntry) TreeNode
	buildNode = func(entry SessionEntry) TreeNode {
		children := childMap[entry.ID]
		nodes := make([]TreeNode, len(children))
		for i, child := range children {
			nodes[i] = buildNode(child)
		}
		return TreeNode{Entry: entry, Children: nodes}
	}

	roots := childMap[""]
	result := make([]TreeNode, len(roots))
	for i, r := range roots {
		result[i] = buildNode(r)
	}
	return result
}

// GetBranchPoints returns entries that have more than one child.
func GetBranchPoints(conv *Conversation) []SessionEntry {
	conv.lock()
	defer conv.unlock()
	if len(conv.Entries) == 0 {
		return nil
	}

	childCount := make(map[string]int)
	for _, e := range conv.Entries {
		if e.ParentID != nil {
			childCount[*e.ParentID]++
		}
	}

	entryMap := buildEntryMap(conv.Entries)
	var result []SessionEntry
	for id, count := range childCount {
		if count > 1 {
			if e, ok := entryMap[id]; ok {
				result = append(result, e)
			}
		}
	}
	return result
}

// GetLeaves returns entries with no children.
func GetLeaves(conv *Conversation) []SessionEntry {
	conv.lock()
	defer conv.unlock()
	if len(conv.Entries) == 0 {
		return nil
	}

	hasChildren := make(map[string]bool)
	for _, e := range conv.Entries {
		if e.ParentID != nil {
			hasChildren[*e.ParentID] = true
		}
	}

	var result []SessionEntry
	for _, e := range conv.Entries {
		if !hasChildren[e.ID] {
			result = append(result, e)
		}
	}
	return result
}

// ForkConversationBefore creates an independent conversation whose active path
// stops immediately before entryID. The target must be a user turn on the
// current path so a stale or foreign-branch client identity fails loudly.
func ForkConversationBefore(conv *Conversation, entryID string) (*Conversation, error) {
	conv.lock()
	defer conv.unlock()

	path := getContextPathEntriesLocked(conv)
	cut := -1
	for i, entry := range path {
		if entry.ID != entryID {
			continue
		}
		message := asMessageData(entry.Data)
		if entry.Type != EntryMessage || message == nil || message.Role != "user" {
			return nil, fmt.Errorf("entry %q is not a user turn on the current path", entryID)
		}
		cut = i
		break
	}
	if cut < 0 {
		return nil, fmt.Errorf("entry %q is not a user turn on the current path", entryID)
	}
	return forkConversationAtPathLocked(conv, path[:cut]), nil
}

// ForkConversation creates an independent conversation whose active path ends at
// the requested message index. The source tree is never mutated: a fork and its
// source must be able to advance independently after this call.
func ForkConversation(conv *Conversation, atMessageIndex int) *Conversation {
	conv.lock()
	defer conv.unlock()

	if len(conv.Entries) > 0 {
		path := getContextPathEntriesLocked(conv)
		messageIndex := -1
		cut := len(path)
		for i, entry := range path {
			if entry.Type != EntryMessage {
				continue
			}
			messageIndex++
			if messageIndex == atMessageIndex {
				cut = i + 1
				break
			}
		}
		if atMessageIndex < 0 {
			cut = 0
		}
		return forkConversationAtPathLocked(conv, path[:cut])
	}

	idx := atMessageIndex
	if idx >= len(conv.Messages) {
		idx = len(conv.Messages) - 1
	}
	forked := newForkedConversation(conv)
	if idx >= 0 {
		forked.Messages = append([]types.LlmMessage(nil), conv.Messages[:idx+1]...)
	}
	return forked
}

func forkConversationAtPathLocked(source *Conversation, path []SessionEntry) *Conversation {
	forked := newForkedConversation(source)
	forked.Entries = cloneEntries(path)
	if len(forked.Entries) > 0 {
		leaf := forked.Entries[len(forked.Entries)-1].ID
		forked.LeafID = &leaf
	}
	forked.Messages = buildContextPathLocked(forked)
	return forked
}

func newForkedConversation(source *Conversation) *Conversation {
	return &Conversation{
		ID:               NewConversationID(),
		System:           source.System,
		Model:            source.Model,
		CreatedAt:        nowMillis(),
		Version:          CurrentVersion,
		ParentID:         source.ID,
		WorkingDirectory: source.WorkingDirectory,
	}
}

// cloneEntries copies entry headers and parent pointers. Entry payloads are
// immutable values replaced wholesale by mutators, so sharing them is safe.
func cloneEntries(entries []SessionEntry) []SessionEntry {
	cloned := make([]SessionEntry, len(entries))
	copy(cloned, entries)
	for i := range cloned {
		if cloned[i].ParentID != nil {
			parent := *cloned[i].ParentID
			cloned[i].ParentID = &parent
		}
	}
	return cloned
}

func getContextPathEntries(conv *Conversation) []SessionEntry {
	conv.lock()
	defer conv.unlock()
	return getContextPathEntriesLocked(conv)
}

// getContextPathEntriesLocked walks leaf → root and returns the path in
// root-first order. Callers must hold conv.mu.
//
// A walk that stops on a missing parent is silent data loss unless the stop
// is the designed partial-compaction boundary (the truncated first file-order
// entry legitimately references a dropped parent). Every other miss — a
// missing leaf, or a mid-chain dangling parent — is logged at ERROR so a
// truncated history can never again pass as a successful load.
func getContextPathEntriesLocked(conv *Conversation) []SessionEntry {
	if conv.Entries == nil || conv.LeafID == nil {
		return nil
	}
	entryMap := buildEntryMap(conv.Entries)

	var path []SessionEntry
	current, ok := entryMap[*conv.LeafID]
	if !ok {
		utils.LogWithFields(utils.LevelError, "conversation", "context path: leaf id not found in entries", map[string]any{
			"conversation_id": conv.ID,
			"leaf_id":         *conv.LeafID,
			"total_entries":   len(conv.Entries),
		})
	}
	for ok {
		path = append(path, current)
		if current.ParentID == nil {
			break
		}
		next, found := entryMap[*current.ParentID]
		if !found {
			// The truncated first file-order entry keeping a reference to its
			// dropped parent is partial-compaction working as designed; any
			// other dangling parent is a broken chain.
			if len(conv.Entries) == 0 || current.ID != conv.Entries[0].ID {
				utils.LogWithFields(utils.LevelError, "conversation", "context path: dangling parent truncated walk", map[string]any{
					"conversation_id": conv.ID,
					"stopped_at":      current.ID,
					"missing_parent":  *current.ParentID,
					"path_len":        len(path),
					"total_entries":   len(conv.Entries),
				})
			}
			break
		}
		current = next
	}

	for i, j := 0, len(path)-1; i < j; i, j = i+1, j-1 {
		path[i], path[j] = path[j], path[i]
	}
	return path
}

func buildEntryMap(entries []SessionEntry) map[string]SessionEntry {
	m := make(map[string]SessionEntry, len(entries))
	for _, e := range entries {
		m[e.ID] = e
	}
	return m
}
