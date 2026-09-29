package principalboundary

import (
	"testing"

	"github.com/dsswift/ion/engine/internal/conversation"
	"github.com/dsswift/ion/engine/internal/types"
)

func setup(t *testing.T, enforcement types.PrincipalEnforcement) {
	t.Helper()
	t.Setenv("ION_DATA_DIR", t.TempDir())
	conversation.ConfigurePartitioning(conversation.DefaultConversationsDir(), &types.PrincipalPartitioningConfig{Enabled: true, Enforcement: enforcement})
	t.Cleanup(conversation.ResetPartitioningForTest)
}

func bobsPath(sub string) string {
	return conversation.PartitionConversationsDir("oidc:bob") + "/" + sub
}

func TestNew_ReturnsNilWhenDisabledOrUnattributed(t *testing.T) {
	t.Setenv("ION_DATA_DIR", t.TempDir())
	conversation.ResetPartitioningForTest()
	if c := New("oidc:alice", types.EnforcementStrict); c != nil {
		t.Error("expected nil checker with partitioning disabled")
	}

	setup(t, types.EnforcementStrict)
	if c := New("", types.EnforcementStrict); c != nil {
		t.Error("expected nil checker for an unattributed (empty) subject")
	}
	if c := New("oidc:alice", types.EnforcementNone); c != nil {
		t.Error("expected nil checker at EnforcementNone")
	}
}

func TestCheck_NilCheckerAllowsEverything(t *testing.T) {
	var c *Checker
	if r := c.Check("Read", map[string]any{"file_path": "/anything"}, "/tmp"); r != nil {
		t.Errorf("expected nil-checker passthrough, got refusal %+v", r)
	}
}

func TestCheck_OwnPartitionAlwaysAllowed(t *testing.T) {
	setup(t, types.EnforcementStrict)
	c := New("oidc:alice", types.EnforcementStrict)
	own := conversation.PartitionConversationsDir("oidc:alice") + "/conv-1.llm.jsonl"
	if r := c.Check("Read", map[string]any{"file_path": own}, ""); r != nil {
		t.Errorf("expected own-partition read allowed, got %+v", r)
	}
	if r := c.Check("Write", map[string]any{"file_path": own}, ""); r != nil {
		t.Errorf("expected own-partition write allowed, got %+v", r)
	}
}

func TestCheck_UnrelatedPathAlwaysAllowed(t *testing.T) {
	setup(t, types.EnforcementStrict)
	c := New("oidc:alice", types.EnforcementStrict)
	if r := c.Check("Read", map[string]any{"file_path": "/tmp/scratch.txt"}, ""); r != nil {
		t.Errorf("expected an unrelated path allowed, got %+v", r)
	}
}

// Strict: the FR's own stated test -- Read, Glob, Grep, and Bash cat against
// another principal's partition are all refused.
func TestCheck_Strict_RefusesReadGlobGrepAndBashAgainstAnotherPrincipal(t *testing.T) {
	setup(t, types.EnforcementStrict)
	c := New("oidc:alice", types.EnforcementStrict)
	target := bobsPath("conv-1.llm.jsonl")

	if r := c.Check("Read", map[string]any{"file_path": target}, ""); r == nil {
		t.Error("expected Read against bob's partition refused under strict")
	}
	if r := c.Check("Glob", map[string]any{"path": bobsPath("")}, ""); r == nil {
		t.Error("expected Glob against bob's partition refused under strict")
	}
	if r := c.Check("Grep", map[string]any{"path": target}, ""); r == nil {
		t.Error("expected Grep against bob's partition refused under strict")
	}
	if r := c.Check("Bash", map[string]any{"command": "cat " + target}, "/tmp"); r == nil {
		t.Error("expected Bash cat against bob's partition refused under strict")
	}
}

func TestCheck_Strict_RefusesWriteToAnotherPrincipal(t *testing.T) {
	setup(t, types.EnforcementStrict)
	c := New("oidc:alice", types.EnforcementStrict)
	target := bobsPath("conv-1.llm.jsonl")

	if r := c.Check("Write", map[string]any{"file_path": target}, ""); r == nil {
		t.Error("expected Write to bob's partition refused under strict")
	}
	if r := c.Check("Edit", map[string]any{"file_path": target}, ""); r == nil {
		t.Error("expected Edit on bob's partition refused under strict")
	}
	if r := c.Check("NotebookEdit", map[string]any{"notebook_path": target}, ""); r == nil {
		t.Error("expected NotebookEdit on bob's partition refused under strict")
	}
}

func TestCheck_Strict_RefusesTheFlatRoot(t *testing.T) {
	setup(t, types.EnforcementStrict)
	c := New("oidc:alice", types.EnforcementStrict)
	flatFile := conversation.DefaultConversationsDir() + "/legacy-conv.llm.jsonl"
	if r := c.Check("Read", map[string]any{"file_path": flatFile}, ""); r == nil {
		t.Error("expected an attributed session refused the flat/unpartitioned root under strict")
	}
}

func TestCheck_BashCdIntoAnotherPrincipalRefused(t *testing.T) {
	setup(t, types.EnforcementStrict)
	c := New("oidc:alice", types.EnforcementStrict)
	cmd := "cd " + bobsPath("") + " && cat conv-1.llm.jsonl"
	if r := c.Check("Bash", map[string]any{"command": cmd}, "/tmp"); r == nil {
		t.Error("expected a cd into bob's partition (relative read after) refused")
	}
}

// read-only: cross-partition READS pass, writes (and Bash) still refused.
func TestCheck_ReadOnly_AllowsCrossPartitionReadRefusesWrite(t *testing.T) {
	setup(t, types.EnforcementReadOnly)
	c := New("oidc:alice", types.EnforcementReadOnly)
	target := bobsPath("conv-1.llm.jsonl")

	if r := c.Check("Read", map[string]any{"file_path": target}, ""); r != nil {
		t.Errorf("expected Read allowed under read-only enforcement, got %+v", r)
	}
	if r := c.Check("Write", map[string]any{"file_path": target}, ""); r == nil {
		t.Error("expected Write still refused under read-only enforcement")
	}
	if r := c.Check("Bash", map[string]any{"command": "cat " + target}, "/tmp"); r == nil {
		t.Error("expected Bash still refused under read-only enforcement (treated as write-class)")
	}
}

func TestCheck_UnknownToolPassesThrough(t *testing.T) {
	setup(t, types.EnforcementStrict)
	c := New("oidc:alice", types.EnforcementStrict)
	if r := c.Check("WebFetch", map[string]any{"url": bobsPath("x")}, ""); r != nil {
		t.Errorf("expected an ungated tool to pass through untouched, got %+v", r)
	}
}
