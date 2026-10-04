package backend

import (
	"testing"

	"github.com/dsswift/ion/engine/internal/tools"
	"github.com/dsswift/ion/engine/internal/types"
)

func toolNames(defs []types.LlmToolDef) []string {
	names := make([]string, len(defs))
	for i, d := range defs {
		names[i] = d.Name
	}
	return names
}

// TestBuildToolDefsOrderIsStable pins that a run's tool list is the same
// sequence every time it is built from the same inputs. The built-in registry
// is a map, so without an explicit order two builds differ.
func TestBuildToolDefsOrderIsStable(t *testing.T) {
	b := &ApiBackend{}
	opts := types.RunOptions{}
	build := func() []string {
		run := &activeRun{requestID: "order", cfg: &RunConfig{ExternalTools: []types.LlmToolDef{
			{Name: "zeta_ext"}, {Name: "alpha_ext"},
		}}}
		defs, _ := b.buildToolDefs(run, opts, &mockLlmProvider{id: "mock"})
		return toolNames(defs)
	}
	first := build()
	if len(first) < 5 {
		t.Fatalf("expected a populated tool list, got %v", first)
	}
	for i := 1; i < len(first); i++ {
		if first[i-1] > first[i] {
			t.Fatalf("tool list not ordered by name at %d: %q > %q", i, first[i-1], first[i])
		}
	}
	for n := 0; n < 50; n++ {
		got := build()
		if len(got) != len(first) {
			t.Fatalf("build %d: length %d, want %d", n, len(got), len(first))
		}
		for i := range got {
			if got[i] != first[i] {
				t.Fatalf("build %d: position %d is %q, want %q", n, i, got[i], first[i])
			}
		}
	}
}

// TestRegistryToolDefsOrderIsStable pins the registry's own ordering, which
// every consumer outside buildToolDefs (context breakdown, child dispatch)
// reads directly.
func TestRegistryToolDefsOrderIsStable(t *testing.T) {
	defs := tools.GetToolDefs()
	for i := 1; i < len(defs); i++ {
		if defs[i-1].Name > defs[i].Name {
			t.Fatalf("registry tool defs not ordered at %d: %q > %q", i, defs[i-1].Name, defs[i].Name)
		}
	}
	all := tools.GetAllTools()
	for i := 1; i < len(all); i++ {
		if all[i-1].Name > all[i].Name {
			t.Fatalf("registry tools not ordered at %d: %q > %q", i, all[i-1].Name, all[i].Name)
		}
	}
}
