package backend

import (
	"sort"

	"github.com/dsswift/ion/engine/internal/types"
)

// sortToolDefs orders a run's assembled tool list by name, in place.
//
// A provider's prompt cache is keyed on the serialized tool list, order
// included. The list is assembled from several sources (built-in registry,
// external and MCP tools, capability tools, client tools, sentinels), and the
// order each contributes in is not stable from run to run. Sorting the final
// list makes the bytes a function of the tool set alone. The sort is stable so
// two definitions sharing a name keep their assembly order.
func sortToolDefs(defs []types.LlmToolDef) {
	sort.SliceStable(defs, func(i, j int) bool { return defs[i].Name < defs[j].Name })
}
