package extcontext

import (
	"sync"
	"testing"

	"github.com/dsswift/ion/engine/internal/extension"
	"github.com/dsswift/ion/engine/internal/types"
)

// pollReleaseSpyAccessor records which dispatches released their polls.
type pollReleaseSpyAccessor struct {
	*dispatchCountSpyAccessor
	releaseMu sync.Mutex
	released  []string
}

func (a *pollReleaseSpyAccessor) ReleaseDispatchPolls(dispatchID string) {
	a.releaseMu.Lock()
	a.released = append(a.released, dispatchID)
	a.releaseMu.Unlock()
}

// A dispatch that ends releases the polls it started. Without the release a
// poll whose owner ended stayed open and held the session in pending work.
func TestDispatchEndReleasesItsPolls(t *testing.T) {
	registry := NewDispatchRegistry()
	acc := &pollReleaseSpyAccessor{dispatchCountSpyAccessor: &dispatchCountSpyAccessor{child: &drippingChildBackend{numEvents: 1}, registry: registry}}

	result, err := BuildDispatchAgentFunc(acc, registry, 0, "")(extension.DispatchAgentOpts{WaitForCompletion: true, Name: "poll-owner", Task: "work"})
	if err != nil || result == nil {
		t.Fatalf("dispatch = (%+v, %v)", result, err)
	}

	acc.releaseMu.Lock()
	defer acc.releaseMu.Unlock()
	if len(acc.released) != 1 || acc.released[0] != result.DispatchID {
		t.Fatalf("released = %v, want exactly the ended dispatch %q", acc.released, result.DispatchID)
	}
}

// The leaf cap admits the judge of a caller at the deepest allowed level and
// nothing below that judge.
func TestLeafDispatchDepthCapAdmitsOneLevel(t *testing.T) {
	acc := &depthTestAccessor{config: &types.EngineRuntimeConfig{}}
	deepest := DefaultMaxDispatchDepth - 1
	leafCap := LeafDispatchDepthCap(deepest)

	result, _ := BuildDispatchAgentFunc(acc, nil, deepest, "deepest-agent")(extension.DispatchAgentOpts{Name: "poll-check", Task: "judge", MaxDispatchDepth: leafCap})
	if result != nil && result.DepthCapExceeded {
		t.Fatalf("judge of a depth-%d caller refused: its poll could never end", deepest)
	}

	below, err := BuildDispatchAgentFunc(acc, nil, deepest+1, "judge")(extension.DispatchAgentOpts{Name: "nested", Task: "x", MaxDispatchDepth: leafCap})
	if err != nil || below == nil || !below.DepthCapExceeded {
		t.Fatalf("a child below the judge was admitted: (%+v, %v)", below, err)
	}
}
