package conversation

import (
	"github.com/dsswift/ion/engine/internal/utils"
)

// Load-time tree validation and deterministic repair.
//
// A persisted tree can arrive broken: before tree mutation was serialized
// (see lock.go), a concurrent append could lose an entry while children were
// persisted referencing the lost id. The historical walk (leaf → root via
// ParentID) then silently truncates at the gap — in the forensic case that
// motivated this file, 237 of 241 messages became unreachable and every
// consumer rendered a 4-message conversation with no error anywhere.
//
// validateAndRepairTree makes a loaded tree fully reachable again, using only
// deterministic, file-order-based rules, and logs every repair loudly. It
// mutates the in-memory tree only; the repaired shape persists on the next
// Save, healing the file in place.

// TreeRepairReport summarizes what validateAndRepairTree changed.
type TreeRepairReport struct {
	// DanglingParentsRepaired counts entries whose ParentID referenced a
	// missing id and was rewired to the preceding file-order entry.
	DanglingParentsRepaired int
	// LeafRepaired is true when the header leafId referenced a missing entry
	// and was repointed to the last file-order entry.
	LeafRepaired bool
	// DuplicateIDs counts ids that appear on more than one entry (counted
	// once per extra occurrence). Duplicates are kept — dropping user data is
	// not the loader's call — but they are logged because the walk can only
	// ever reach one of them.
	DuplicateIDs int
	// CyclesBroken counts parent links severed to break reference cycles.
	CyclesBroken int
}

// repaired reports whether any repair was performed.
func (r TreeRepairReport) repaired() bool {
	return r.DanglingParentsRepaired > 0 || r.LeafRepaired || r.CyclesBroken > 0
}

// validateAndRepairTree validates entry linkage and repairs deterministically:
//
//   - An entry (other than the first in file order) whose ParentID references
//     a missing id is reattached to the entry immediately before it in file
//     order. Appends are written in chronological file order, so the
//     preceding entry is the chain position the lost parent occupied.
//   - The FIRST file-order entry with a missing parent keeps a nil parent
//     instead: partial compaction ("before") legitimately truncates the entry
//     slice and leaves the new first entry referencing a dropped parent — the
//     walk already treats that entry as the root, so nil preserves semantics.
//   - A leafId referencing a missing entry is repointed to the last
//     file-order entry.
//   - A cycle in the parent chain is broken at the revisited link by nil-ing
//     the offending ParentID (the walk would otherwise never terminate).
//
// The function is idempotent: running it on an already-repaired tree reports
// zero repairs.
func validateAndRepairTree(conv *Conversation) TreeRepairReport {
	var report TreeRepairReport
	if len(conv.Entries) == 0 {
		return report
	}

	ids := make(map[string]int, len(conv.Entries)) // id → first file-order index
	for i := range conv.Entries {
		id := conv.Entries[i].ID
		if _, dup := ids[id]; dup {
			report.DuplicateIDs++
			utils.LogWithFields(utils.LevelError, "conversation", "tree repair: duplicate entry id", map[string]any{
				"conversation_id": conv.ID,
				"entry_id":        id,
				"file_index":      i,
			})
			continue
		}
		ids[id] = i
	}

	// Dangling parents → reattach to the preceding file-order entry.
	for i := range conv.Entries {
		p := conv.Entries[i].ParentID
		if p == nil {
			continue
		}
		if _, ok := ids[*p]; ok {
			continue
		}
		missing := *p
		if i == 0 {
			// Partial-compaction residue: the truncated first entry keeps a
			// reference to its dropped parent by design. Normalize to nil —
			// identical walk semantics, and the persisted file stops carrying
			// a reference that cannot resolve.
			conv.Entries[i].ParentID = nil
			utils.LogWithFields(utils.LevelWarn, "conversation", "tree repair: first entry parent normalized to root", map[string]any{
				"conversation_id": conv.ID,
				"entry_id":        conv.Entries[i].ID,
				"missing_parent":  missing,
			})
			continue
		}
		prev := conv.Entries[i-1].ID
		v := prev
		conv.Entries[i].ParentID = &v
		report.DanglingParentsRepaired++
		utils.LogWithFields(utils.LevelError, "conversation", "tree repair: dangling parent reattached", map[string]any{
			"conversation_id": conv.ID,
			"entry_id":        conv.Entries[i].ID,
			"missing_parent":  missing,
			"repaired_to":     prev,
			"file_index":      i,
		})
	}

	// Dangling leaf → repoint to the last file-order entry.
	if conv.LeafID != nil {
		if _, ok := ids[*conv.LeafID]; !ok {
			missing := *conv.LeafID
			setLeafLocked(conv, conv.Entries[len(conv.Entries)-1].ID)
			report.LeafRepaired = true
			utils.LogWithFields(utils.LevelError, "conversation", "tree repair: dangling leaf repointed", map[string]any{
				"conversation_id": conv.ID,
				"missing_leaf":    missing,
				"repaired_to":     *conv.LeafID,
			})
		}
	}

	// Cycle guard: walk leaf → root; sever the link that revisits a node.
	// Without this, a cyclic chain would spin BuildContextPath forever.
	if conv.LeafID != nil {
		entryIdx := make(map[string]int, len(conv.Entries))
		for i := range conv.Entries {
			entryIdx[conv.Entries[i].ID] = i
		}
		visited := make(map[string]bool)
		cur, ok := entryIdx[*conv.LeafID]
		for ok {
			id := conv.Entries[cur].ID
			if visited[id] {
				// Should be unreachable — the previous iteration severs the
				// link before revisiting. Kept as a hard stop.
				break
			}
			visited[id] = true
			p := conv.Entries[cur].ParentID
			if p == nil {
				break
			}
			next, found := entryIdx[*p]
			if !found {
				break
			}
			if visited[conv.Entries[next].ID] {
				conv.Entries[cur].ParentID = nil
				report.CyclesBroken++
				utils.LogWithFields(utils.LevelError, "conversation", "tree repair: parent cycle severed", map[string]any{
					"conversation_id": conv.ID,
					"entry_id":        id,
					"cycled_parent":   *p,
				})
				break
			}
			cur = next
		}
	}

	if report.repaired() {
		utils.LogWithFields(utils.LevelWarn, "conversation", "tree repair: repaired on load", map[string]any{
			"conversation_id":   conv.ID,
			"dangling_parents":  report.DanglingParentsRepaired,
			"leaf_repaired":     report.LeafRepaired,
			"duplicate_ids":     report.DuplicateIDs,
			"cycles_broken":     report.CyclesBroken,
			"total_entries":     len(conv.Entries),
		})
	}
	return report
}
