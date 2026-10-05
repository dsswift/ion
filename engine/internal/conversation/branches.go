package conversation

import (
	"fmt"
	"strings"
)

// Branch listing over the conversation tree.
//
// Every entry records its parentId, so a rewind that starts a sibling path
// leaves the old path on disk. A branch is the root-to-leaf path ending at a
// tree leaf: a chained entry no other chained entry names as its parent.
// Detached agent-dispatch records (extra roots that never move the leaf) are
// not part of any path and are ignored here.

// branchPreviewRunes bounds BranchSummary.Preview.
const branchPreviewRunes = 160

// BranchSummary is one root-to-leaf path of the conversation tree.
type BranchSummary struct {
	// LeafID is the path's last entry.
	LeafID string `json:"leafId"`
	// Timestamp is the leaf entry's timestamp (Unix ms).
	Timestamp int64 `json:"timestamp"`
	// Preview is the text of the path's last message that has any, cut to a
	// bounded length. Empty when the path holds no text message.
	Preview string `json:"preview"`
	// MessageCount counts the message entries on the path.
	MessageCount int `json:"messageCount"`
	// ForkPointID is the deepest entry on the path with more than one
	// chained child. Empty when the path passes through no such entry: it is
	// the only path, or it diverges from the others at the root.
	ForkPointID string `json:"forkPointId,omitempty"`
	// Active is true when the conversation's current leaf is this leaf.
	Active bool `json:"active"`
}

// BranchPoint is an entry with more than one chained child, or the root when
// the tree has more than one chained root (EntryID "").
type BranchPoint struct {
	EntryID   string   `json:"entryId"`
	Timestamp int64    `json:"timestamp"`
	ChildIDs  []string `json:"childIds"`
}

// BranchListing is every branch of a conversation, in entry order of their
// leaves, with the entries they fork at.
type BranchListing struct {
	// ActiveLeafID is the conversation's current leaf. It names an interior
	// entry right after a rewind (no branch is Active then) and is empty when
	// the leaf was cleared back to before the first entry.
	ActiveLeafID string          `json:"activeLeafId"`
	Branches     []BranchSummary `json:"branches"`
	BranchPoints []BranchPoint   `json:"branchPoints"`
}

// branchIndex is the chained part of the tree: detached records left out,
// and an entry whose parent is missing (the partial-compaction boundary)
// treated as a root.
type branchIndex struct {
	byID     map[string]SessionEntry
	order    []string
	children map[string][]string // "" holds the roots
}

func isDetachedEntry(e SessionEntry) bool {
	return e.Type == EntryAgentDispatch
}

func buildBranchIndexLocked(conv *Conversation) branchIndex {
	idx := branchIndex{byID: map[string]SessionEntry{}, children: map[string][]string{}}
	for _, e := range conv.Entries {
		if isDetachedEntry(e) {
			continue
		}
		if _, dup := idx.byID[e.ID]; !dup {
			idx.order = append(idx.order, e.ID)
		}
		idx.byID[e.ID] = e
	}
	for _, id := range idx.order {
		e := idx.byID[id]
		parent := ""
		if e.ParentID != nil {
			if _, ok := idx.byID[*e.ParentID]; ok {
				parent = *e.ParentID
			}
		}
		idx.children[parent] = append(idx.children[parent], id)
	}
	return idx
}

func (idx branchIndex) isLeaf(id string) bool {
	_, known := idx.byID[id]
	return known && len(idx.children[id]) == 0
}

// pathTo returns the root-first path ending at id.
func (idx branchIndex) pathTo(id string) []SessionEntry {
	var path []SessionEntry
	seen := map[string]bool{}
	for cur, ok := idx.byID[id]; ok && !seen[cur.ID]; {
		seen[cur.ID] = true
		path = append(path, cur)
		if cur.ParentID == nil {
			break
		}
		cur, ok = idx.byID[*cur.ParentID]
	}
	for i, j := 0, len(path)-1; i < j; i, j = i+1, j-1 {
		path[i], path[j] = path[j], path[i]
	}
	return path
}

// ListBranches reports every branch and branch point of conv. Safe for
// concurrent use.
func ListBranches(conv *Conversation) BranchListing {
	conv.lock()
	defer conv.unlock()

	listing := BranchListing{Branches: []BranchSummary{}, BranchPoints: []BranchPoint{}}
	if conv.LeafID != nil {
		listing.ActiveLeafID = *conv.LeafID
	}
	idx := buildBranchIndexLocked(conv)

	if roots := idx.children[""]; len(roots) > 1 {
		listing.BranchPoints = append(listing.BranchPoints, BranchPoint{EntryID: "", ChildIDs: append([]string(nil), roots...)})
	}
	for _, id := range idx.order {
		if kids := idx.children[id]; len(kids) > 1 {
			listing.BranchPoints = append(listing.BranchPoints, BranchPoint{
				EntryID: id, Timestamp: idx.byID[id].Timestamp, ChildIDs: append([]string(nil), kids...),
			})
		}
	}

	for _, id := range idx.order {
		if !idx.isLeaf(id) {
			continue
		}
		path := idx.pathTo(id)
		b := BranchSummary{LeafID: id, Timestamp: idx.byID[id].Timestamp, Active: id == listing.ActiveLeafID}
		for _, e := range path {
			if len(idx.children[e.ID]) > 1 {
				b.ForkPointID = e.ID
			}
			if e.Type != EntryMessage {
				continue
			}
			b.MessageCount++
			if text := branchEntryText(e); text != "" {
				b.Preview = text
			}
		}
		b.Preview = truncateRunes(b.Preview, branchPreviewRunes)
		listing.Branches = append(listing.Branches, b)
	}
	return listing
}

// SwitchBranch makes leafID the conversation's current leaf and rebuilds the
// model context from that path alone. leafID must be a branch leaf; moving
// the leaf to an interior entry is NavigateTree's job. Returns the previous
// leaf id ("" when none). Safe for concurrent use.
func SwitchBranch(conv *Conversation, leafID string) (string, error) {
	conv.lock()
	defer conv.unlock()
	idx := buildBranchIndexLocked(conv)
	if !idx.isLeaf(leafID) {
		return "", fmt.Errorf("entry %q is not a branch leaf of this conversation", leafID)
	}
	previous := ""
	if conv.LeafID != nil {
		previous = *conv.LeafID
	}
	setLeafLocked(conv, leafID)
	conv.Messages = buildContextPathLocked(conv)
	return previous, nil
}

// ForkConversationAtLeaf creates an independent conversation holding exactly
// the branch that ends at leafID. The source tree is not changed.
func ForkConversationAtLeaf(conv *Conversation, leafID string) (*Conversation, error) {
	conv.lock()
	defer conv.unlock()
	idx := buildBranchIndexLocked(conv)
	if !idx.isLeaf(leafID) {
		return nil, fmt.Errorf("entry %q is not a branch leaf of this conversation", leafID)
	}
	return forkConversationAtPathLocked(conv, idx.pathTo(leafID)), nil
}

func branchEntryText(e SessionEntry) string {
	md := asMessageData(e.Data)
	if md == nil {
		return ""
	}
	var parts []string
	for _, b := range contentToBlocks(md.Content) {
		if b.Type == "text" && strings.TrimSpace(b.Text) != "" {
			parts = append(parts, strings.TrimSpace(b.Text))
		}
	}
	return strings.Join(parts, " ")
}

func truncateRunes(s string, limit int) string {
	r := []rune(s)
	if len(r) <= limit {
		return s
	}
	return string(r[:limit]) + "…"
}
