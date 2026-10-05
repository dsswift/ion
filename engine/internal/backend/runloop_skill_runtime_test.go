package backend

import (
	"context"
	"testing"

	"github.com/dsswift/ion/engine/internal/types"
)

// Grants recorded during a run are visible to later permission checks in the
// same run, and a new run starts with only what its options seed.
func TestActiveRun_SkillGrantsAreRunScoped(t *testing.T) {
	run := &activeRun{requestID: "r1", opts: &types.RunOptions{}}
	if run.skillGrantsSnapshot() != nil {
		t.Fatal("a fresh run has no grants")
	}
	stampSkillRuntime(context.Background(), run, nil, nil)
	run.addSkillGrants([]types.PermissionRule{{Tool: "Bash", CommandPatterns: []string{"git *"}}})
	if got := run.skillGrantsSnapshot(); len(got) != 1 || got[0].Tool != "Bash" {
		t.Fatalf("grant not recorded: %+v", got)
	}

	next := &activeRun{requestID: "r2", opts: &types.RunOptions{}}
	if next.skillGrantsSnapshot() != nil {
		t.Fatal("grants must not leak into the next run")
	}
}
