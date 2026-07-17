package extcontext

import (
	"github.com/dsswift/ion/engine/internal/extension"
)

// buildChildElicitFn adapts an OnChildQuestion dispatcher callback into the
// backend.RunConfig.ChildElicitFn shape the runloop calls. When the child
// run's AskUserQuestion fires, the runloop invokes the returned function with
// the question text; this wraps it in a DispatchChildQuestionInfo stamped with
// the dispatch's name, id, and depth, then forwards to the dispatcher. Kept as
// a package-level function (rather than an inline closure) so the wiring is
// directly unit-testable without standing up a full child run.
func buildChildElicitFn(fn func(extension.DispatchChildQuestionInfo) (string, bool, error), name, dispatchID string, depth int) func(string) (string, bool, error) {
	return func(question string) (string, bool, error) {
		return fn(extension.DispatchChildQuestionInfo{
			Name:       name,
			DispatchID: dispatchID,
			Question:   question,
			Depth:      depth,
		})
	}
}
