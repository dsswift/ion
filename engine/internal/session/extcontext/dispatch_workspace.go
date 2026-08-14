package extcontext

import "github.com/dsswift/ion/engine/internal/workspaces"

// workspaceCheckerSource exposes the parent's selected containment checker.
// It is optional so focused dispatch test accessors retain narrow contracts.
type workspaceCheckerSource interface {
	WorkspaceChecker() *workspaces.Checker
}

func workspaceCheckerFor(sa SessionAccessor) *workspaces.Checker {
	source, ok := sa.(workspaceCheckerSource)
	if !ok {
		return nil
	}
	return source.WorkspaceChecker()
}
