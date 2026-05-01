package conversation

import (
	"fmt"

	"github.com/dsswift/ion/engine/internal/types"
)

// AppendEntry adds an entry to the tree, chained from the current leaf.
func AppendEntry(conv *Conversation, entryType SessionEntryType, data any) *SessionEntry {
	if conv.Entries == nil {
		conv.Entries = []SessionEntry{}
	}
	entry := SessionEntry{
		ID:        GenEntryID(),
		ParentID:  conv.LeafID,
		Type:      entryType,
		Timestamp: nowMillis(),
		Data:      data,
	}
	conv.Entries = append(conv.Entries, entry)
	conv.LeafID = &conv.Entries[len(conv.Entries)-1].ID
	return &conv.Entries[len(conv.Entries)-1]
}

// Branch moves the leaf pointer to an existing entry and rebuilds the message list.
func Branch(conv *Conversation, entryID string) ([]types.LlmMessage, error) {
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
	conv.LeafID = &entryID
	conv.Messages = BuildContextPath(conv)
	return conv.Messages, nil
}

// BuildContextPath walks from the current leaf to the root and extracts messages.
func BuildContextPath(conv *Conversation) []types.LlmMessage {
	if conv.Entries == nil || conv.LeafID == nil {
		return conv.Messages
	}

	entryMap := buildEntryMap(conv.Entries)

	var path []SessionEntry
	current, ok := entryMap[*conv.LeafID]
	for ok {
		path = append(path, current)
		if current.ParentID != nil {
			current, ok = entryMap[*current.ParentID]
		} else {
			ok = false
		}
	}

	for i, j := 0, len(path)-1; i < j; i, j = i+1, j-1 {
		path[i], path[j] = path[j], path[i]
	}

	var messages []types.LlmMessage
	for _, entry := range path {
		switch entry.Type {
		case EntryMessage:
			md := asMessageData(entry.Data)
			if md != nil {
				messages = append(messages, types.LlmMessage{Role: md.Role, Content: md.Content})
			}
		case EntryCompaction:
			cd := asCompactionData(entry.Data)
			if cd != nil {
				messages = append(messages, types.LlmMessage{
					Role:    "user",
					Content: []types.LlmContentBlock{textBlock("[Previous conversation summary]: " + cd.Summary)},
				})
			}
		}
	}
	return messages
}

// NavigateTree moves the leaf pointer to target and rebuilds messages.
func NavigateTree(conv *Conversation, targetID string) ([]types.LlmMessage, error) {
	return Branch(conv, targetID)
}

// GetTree builds the full tree structure for visualization.
func GetTree(conv *Conversation) []TreeNode {
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

// ForkConversation forks at a message index. For v2 trees, uses branch in-place.
// For legacy v1 conversations, creates a new conversation with copied messages.
func ForkConversation(conv *Conversation, atMessageIndex int) *Conversation {
	if len(conv.Entries) > 0 {
		path := getContextPathEntries(conv)
		var messageEntries []SessionEntry
		for _, e := range path {
			if e.Type == EntryMessage {
				messageEntries = append(messageEntries, e)
			}
		}
		idx := atMessageIndex
		if idx >= len(messageEntries) {
			idx = len(messageEntries) - 1
		}
		if idx >= 0 && idx < len(messageEntries) {
			Branch(conv, messageEntries[idx].ID)
		}
		return conv
	}

	newID := fmt.Sprintf("fork-%s-%d", conv.ID, nowMillis())
	idx := atMessageIndex
	if idx >= len(conv.Messages) {
		idx = len(conv.Messages) - 1
	}
	if idx < 0 {
		idx = 0
	}

	forked := make([]types.LlmMessage, idx+1)
	for i := 0; i <= idx; i++ {
		forked[i] = types.LlmMessage{
			Role:    conv.Messages[i].Role,
			Content: conv.Messages[i].Content,
		}
	}

	return &Conversation{
		ID:        newID,
		System:    conv.System,
		Model:     conv.Model,
		Messages:  forked,
		CreatedAt: nowMillis(),
		Version:   CurrentVersion,
		ParentID:  conv.ID,
		LeafID:    nil,
	}
}

func getContextPathEntries(conv *Conversation) []SessionEntry {
	if conv.Entries == nil || conv.LeafID == nil {
		return nil
	}
	entryMap := buildEntryMap(conv.Entries)

	var path []SessionEntry
	current, ok := entryMap[*conv.LeafID]
	for ok {
		path = append(path, current)
		if current.ParentID != nil {
			current, ok = entryMap[*current.ParentID]
		} else {
			ok = false
		}
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
