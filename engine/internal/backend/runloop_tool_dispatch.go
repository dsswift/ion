package backend

import (
	"golang.org/x/sync/errgroup"

	"github.com/dsswift/ion/engine/internal/conversation"
	"github.com/dsswift/ion/engine/internal/types"
)

// dispatchTools decides HOW a response's tool calls run; executeTools decides
// what each one does. Split out because runloop_tools.go is at its size cap
// and this is the natural seam.
func (b *ApiBackend) dispatchTools(
	g *errgroup.Group,
	toolUseBlocks []types.LlmContentBlock,
	runOne func(int, types.LlmContentBlock) error,
	results []conversation.ToolResultEntry,
) ([]conversation.ToolResultEntry, error) {
	// Tool calls in one response run concurrently, EXCEPT that calls naming the
	// same file run in the order the model listed them.
	//
	// Without that exception, a model batching Edit(f) + Read(f) races its own
	// write and can be handed pre-edit content while the file on disk holds the
	// edit. Reported three times from a Windows endpoint as a Read caching bug;
	// Read has no cache, and the transcript showed the two calls sharing one
	// assistant-block timestamp every time. Warning about it in the tool
	// description did not stop it -- the next run batched them four more times
	// against a build carrying the warning. See runloop_tool_file_order.go.
	conflicts := fileConflictGroups(toolUseBlocks)
	if len(conflicts) > 0 {
		logFileConflictOrdering(conflicts, toolUseBlocks)
	}
	serialized := map[int]bool{}
	for _, idx := range conflicts {
		for _, i := range idx {
			serialized[i] = true
		}
	}

	for i, block := range toolUseBlocks {
		if serialized[i] {
			continue
		}
		i, block := i, block
		g.Go(func() error { return runOne(i, block) })
	}

	// Each contended file gets one goroutine that walks its calls in order, so
	// distinct files still proceed in parallel with each other.
	for _, idx := range conflicts {
		idx := idx
		g.Go(func() error {
			for _, i := range idx {
				if err := runOne(i, toolUseBlocks[i]); err != nil {
					return err
				}
			}
			return nil
		})
	}

	if err := g.Wait(); err != nil {
		return nil, err
	}
	return results, nil
}
