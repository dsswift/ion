package fleet

import (
	"context"
	"strings"
	"testing"
)

// A server reached only over its Studio connection cannot be a builder:
// building means running its tools over SSH. It says so, and never tries.
func TestCheckBuilder_AHostWithNoSSHTargetCannotBuild(t *testing.T) {
	d := &Deployer{} // no runner: a check that needs SSH would panic
	check := d.checkBuilder(context.Background(), Host{Name: "cluster", Kind: KindServer}, ComponentServer, "linux")
	if check.OK() || check.Problems[0].Code != ProblemNoSSH || check.Problems[0].Fixable || !strings.Contains(check.Problems[0].Message, "cluster has no SSH target to build over") {
		t.Fatalf("check = %+v", check)
	}
}
