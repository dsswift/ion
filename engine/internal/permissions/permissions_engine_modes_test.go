package permissions

import (
	"strings"
	"testing"

	"github.com/dsswift/ion/engine/internal/types"
)

// =============================================================================
// Engine: allow mode tests
// =============================================================================

func TestEngine_AllowMode(t *testing.T) {
	t.Run("permits safe tool calls", func(t *testing.T) {
		e := NewEngine(&types.PermissionPolicy{Mode: "allow"})
		result := e.Check(CheckInfo{
			Tool:  "read",
			Input: map[string]interface{}{"path": "/tmp/test.txt"},
			Cwd:   "/tmp",
		})
		if result.Decision != "allow" {
			t.Fatalf("expected allow, got %q", result.Decision)
		}
	})

	t.Run("permits write to normal paths", func(t *testing.T) {
		e := NewEngine(&types.PermissionPolicy{Mode: "allow"})
		result := e.Check(CheckInfo{
			Tool:  "write",
			Input: map[string]interface{}{"path": "/app/src/index.ts"},
			Cwd:   "/app",
		})
		if result.Decision != "allow" {
			t.Fatalf("expected allow, got %q", result.Decision)
		}
	})

	t.Run("permits safe bash commands", func(t *testing.T) {
		e := NewEngine(&types.PermissionPolicy{Mode: "allow"})
		result := e.Check(CheckInfo{
			Tool:  "bash",
			Input: map[string]interface{}{"command": "ls -la"},
			Cwd:   "/tmp",
		})
		if result.Decision != "allow" {
			t.Fatalf("expected allow, got %q", result.Decision)
		}
	})

	t.Run("allows dangerous commands in allow mode", func(t *testing.T) {
		// Allow mode skips all engine-level enforcement. Harness engineer opted out.
		e := NewEngine(&types.PermissionPolicy{Mode: "allow"})
		result := e.Check(CheckInfo{
			Tool:  "bash",
			Input: map[string]interface{}{"command": "rm -rf /"},
			Cwd:   "/tmp",
		})
		if result.Decision != "allow" {
			t.Fatalf("expected allow (allow mode skips checks), got %q", result.Decision)
		}
	})

	t.Run("allows sensitive paths in allow mode", func(t *testing.T) {
		// Allow mode skips all engine-level enforcement.
		e := NewEngine(&types.PermissionPolicy{Mode: "allow"})
		result := e.Check(CheckInfo{
			Tool:  "read",
			Input: map[string]interface{}{"path": "/etc/shadow"},
			Cwd:   "/tmp",
		})
		if result.Decision != "allow" {
			t.Fatalf("expected allow (allow mode skips checks), got %q", result.Decision)
		}
	})
}

// =============================================================================
// Engine: deny mode tests
// =============================================================================

func TestEngine_DenyMode(t *testing.T) {
	t.Run("blocks all tool calls with no rules", func(t *testing.T) {
		e := NewEngine(&types.PermissionPolicy{Mode: "deny"})
		result := e.Check(CheckInfo{
			Tool:  "bash",
			Input: map[string]interface{}{"command": "echo hi"},
			Cwd:   "/tmp",
		})
		if result.Decision != "deny" {
			t.Fatalf("expected deny, got %q", result.Decision)
		}
	})

	t.Run("blocks Write with no matching rule", func(t *testing.T) {
		e := NewEngine(&types.PermissionPolicy{Mode: "deny"})
		result := e.Check(CheckInfo{
			Tool:  "write",
			Input: map[string]interface{}{"path": "/app/file.txt"},
			Cwd:   "/tmp",
		})
		if result.Decision != "deny" {
			t.Fatalf("expected deny, got %q", result.Decision)
		}
	})

	t.Run("blocks Read with no matching rule", func(t *testing.T) {
		e := NewEngine(&types.PermissionPolicy{Mode: "deny"})
		result := e.Check(CheckInfo{
			Tool:  "read",
			Input: map[string]interface{}{"path": "/app/file.txt"},
			Cwd:   "/tmp",
		})
		if result.Decision != "deny" {
			t.Fatalf("expected deny, got %q", result.Decision)
		}
	})

	t.Run("allows via rule even in deny mode", func(t *testing.T) {
		// G29: Rules can punch holes in deny mode (matches TS behavior)
		e := NewEngine(&types.PermissionPolicy{
			Mode: "deny",
			Rules: []types.PermissionRule{
				{Tool: "*", Decision: "allow"},
			},
		})
		result := e.Check(CheckInfo{
			Tool:  "read",
			Input: map[string]interface{}{"path": "/tmp/test.txt"},
			Cwd:   "/tmp",
		})
		if result.Decision != "allow" {
			t.Fatalf("expected allow (rule punches hole in deny mode), got %q", result.Decision)
		}
	})
}

// =============================================================================
// Engine: tier rules (pluggable permission_classify integration)
// =============================================================================

func TestEngine_TierRules(t *testing.T) {
	t.Run("CRITICAL tier denies in deny mode", func(t *testing.T) {
		e := NewEngine(&types.PermissionPolicy{
			Mode: "deny",
			TierRules: map[string]string{
				"SAFE":     "allow",
				"CRITICAL": "deny",
			},
		})
		result := e.Check(CheckInfo{
			Tool:  "bash",
			Input: map[string]interface{}{"command": "echo hi"},
			Cwd:   "/tmp",
			Tier:  "CRITICAL",
		})
		if result.Decision != "deny" {
			t.Fatalf("expected deny, got %q", result.Decision)
		}
		if result.Tier != "CRITICAL" {
			t.Fatalf("expected tier echo CRITICAL, got %q", result.Tier)
		}
	})

	t.Run("SAFE tier allows in deny mode", func(t *testing.T) {
		e := NewEngine(&types.PermissionPolicy{
			Mode: "deny",
			TierRules: map[string]string{
				"SAFE": "allow",
			},
		})
		result := e.Check(CheckInfo{
			Tool:  "read",
			Input: map[string]interface{}{"path": "/tmp/file.txt"},
			Cwd:   "/tmp",
			Tier:  "SAFE",
		})
		if result.Decision != "allow" {
			t.Fatalf("expected allow, got %q", result.Decision)
		}
	})

	t.Run("unknown tier falls through to mode default", func(t *testing.T) {
		e := NewEngine(&types.PermissionPolicy{
			Mode: "deny",
			TierRules: map[string]string{
				"SAFE": "allow",
			},
		})
		result := e.Check(CheckInfo{
			Tool:  "read",
			Input: map[string]interface{}{"path": "/tmp/file.txt"},
			Cwd:   "/tmp",
			Tier:  "UNKNOWN_TIER",
		})
		if result.Decision != "deny" {
			t.Fatalf("expected fall-through to deny, got %q", result.Decision)
		}
	})

	t.Run("empty tier skips tier rules entirely", func(t *testing.T) {
		e := NewEngine(&types.PermissionPolicy{
			Mode: "deny",
			TierRules: map[string]string{
				"SAFE": "allow", // would match if tier were set
			},
		})
		result := e.Check(CheckInfo{
			Tool:  "read",
			Input: map[string]interface{}{"path": "/tmp/file.txt"},
			Cwd:   "/tmp",
			// Tier omitted
		})
		if result.Decision != "deny" {
			t.Fatalf("expected deny when no classifier ran, got %q", result.Decision)
		}
	})
}

// =============================================================================
// Engine: ask mode tests
// =============================================================================

func TestEngine_AskMode(t *testing.T) {
	t.Run("auto-approves safe bash commands", func(t *testing.T) {
		e := NewEngine(&types.PermissionPolicy{Mode: "ask"})
		result := e.Check(CheckInfo{
			Tool:  "bash",
			Input: map[string]interface{}{"command": "ls"},
			Cwd:   "/tmp",
		})
		// Safe commands are auto-approved in ask mode
		if result.Decision != "allow" {
			t.Fatalf("expected allow for safe command, got %q", result.Decision)
		}
	})

	t.Run("returns ask for non-safe bash commands", func(t *testing.T) {
		e := NewEngine(&types.PermissionPolicy{Mode: "ask"})
		result := e.Check(CheckInfo{
			Tool:  "bash",
			Input: map[string]interface{}{"command": "docker build ."},
			Cwd:   "/tmp",
		})
		if result.Decision != "ask" {
			t.Fatalf("expected ask for non-safe command, got %q", result.Decision)
		}
	})

	t.Run("returns ask for non-bash tools", func(t *testing.T) {
		e := NewEngine(&types.PermissionPolicy{Mode: "ask"})
		result := e.Check(CheckInfo{
			Tool:  "write",
			Input: map[string]interface{}{"file_path": "/tmp/test.txt"},
			Cwd:   "/tmp",
		})
		if result.Decision != "ask" {
			t.Fatalf("expected ask for non-bash tool, got %q", result.Decision)
		}
	})

	t.Run("allows tools matching explicit allow rule", func(t *testing.T) {
		e := NewEngine(&types.PermissionPolicy{
			Mode: "ask",
			Rules: []types.PermissionRule{
				{Tool: "read", Decision: "allow"},
			},
		})
		result := e.Check(CheckInfo{
			Tool:  "read",
			Input: map[string]interface{}{"path": "/app/file.txt"},
			Cwd:   "/tmp",
		})
		if result.Decision != "allow" {
			t.Fatalf("expected allow, got %q", result.Decision)
		}
	})

	t.Run("denies dangerous commands even with allow rule", func(t *testing.T) {
		e := NewEngine(&types.PermissionPolicy{
			Mode: "ask",
			Rules: []types.PermissionRule{
				{Tool: "bash", Decision: "allow"},
			},
		})
		result := e.Check(CheckInfo{
			Tool:  "bash",
			Input: map[string]interface{}{"command": "rm -rf /"},
			Cwd:   "/tmp",
		})
		if result.Decision != "deny" {
			t.Fatalf("expected deny for dangerous command, got %q", result.Decision)
		}
	})
}

// =============================================================================
// Engine: nil policy defaults
// =============================================================================

func TestEngine_NilPolicy(t *testing.T) {
	t.Run("defaults to allow mode", func(t *testing.T) {
		e := NewEngine(nil)
		result := e.Check(CheckInfo{
			Tool:  "read",
			Input: map[string]interface{}{"path": "/tmp/test.txt"},
			Cwd:   "/tmp",
		})
		if result.Decision != "allow" {
			t.Fatalf("expected allow for nil policy, got %q", result.Decision)
		}
	})

	t.Run("allows dangerous commands with nil policy (allow mode)", func(t *testing.T) {
		// Nil policy defaults to allow mode, which skips all checks
		e := NewEngine(nil)
		result := e.Check(CheckInfo{
			Tool:  "bash",
			Input: map[string]interface{}{"command": "rm -rf /"},
			Cwd:   "/tmp",
		})
		if result.Decision != "allow" {
			t.Fatalf("expected allow (nil policy = allow mode), got %q", result.Decision)
		}
	})

	t.Run("allows sensitive paths with nil policy (allow mode)", func(t *testing.T) {
		// Nil policy defaults to allow mode, which skips all checks
		e := NewEngine(nil)
		result := e.Check(CheckInfo{
			Tool:  "read",
			Input: map[string]interface{}{"path": "/etc/shadow"},
			Cwd:   "/tmp",
		})
		if result.Decision != "allow" {
			t.Fatalf("expected allow (nil policy = allow mode), got %q", result.Decision)
		}
	})
}

// =============================================================================
// Engine: unknown policy mode
// =============================================================================

func TestEngine_UnknownMode(t *testing.T) {
	e := NewEngine(&types.PermissionPolicy{Mode: "custom"})
	result := e.Check(CheckInfo{
		Tool:  "read",
		Input: map[string]interface{}{"path": "/tmp/file.txt"},
		Cwd:   "/tmp",
	})
	if result.Decision != "deny" {
		t.Fatalf("expected deny for unknown mode, got %q", result.Decision)
	}
	if !strings.Contains(result.Reason, "unknown policy mode") {
		t.Errorf("expected reason to mention unknown mode, got %q", result.Reason)
	}
}

// =============================================================================
// Engine: explicit rules
// =============================================================================

func TestEngine_ExplicitRules(t *testing.T) {
	t.Run("matches tool name exactly", func(t *testing.T) {
		e := NewEngine(&types.PermissionPolicy{
			Mode: "ask",
			Rules: []types.PermissionRule{
				{Tool: "bash", Decision: "allow"},
			},
		})
		result := e.Check(CheckInfo{
			Tool:  "bash",
			Input: map[string]interface{}{"command": "ls"},
			Cwd:   "/tmp",
		})
		if result.Decision != "allow" {
			t.Fatalf("expected allow, got %q", result.Decision)
		}
		if result.Rule == nil {
			t.Fatal("expected rule to be set")
		}
	})

	t.Run("matches tool name exactly only", func(t *testing.T) {
		// Go engine matchTool only supports exact match and bare "*" wildcard.
		// Glob patterns like "mcp__*" are not supported for tool names.
		e := NewEngine(&types.PermissionPolicy{
			Mode: "ask",
			Rules: []types.PermissionRule{
				{Tool: "mcp__github", Decision: "allow"},
				{Tool: "mcp__slack", Decision: "allow"},
			},
		})
		r1 := e.Check(CheckInfo{Tool: "mcp__github", Input: map[string]interface{}{}, Cwd: "/tmp"})
		r2 := e.Check(CheckInfo{Tool: "mcp__slack", Input: map[string]interface{}{}, Cwd: "/tmp"})
		r3 := e.Check(CheckInfo{Tool: "bash", Input: map[string]interface{}{"command": "ls"}, Cwd: "/tmp"})

		if r1.Decision != "allow" {
			t.Errorf("mcp__github: expected allow, got %q", r1.Decision)
		}
		if r2.Decision != "allow" {
			t.Errorf("mcp__slack: expected allow, got %q", r2.Decision)
		}
		if r3.Decision != "allow" {
			t.Errorf("bash safe cmd: expected allow (auto-approved), got %q", r3.Decision)
		}
	})

	t.Run("wildcard tool matches all tools", func(t *testing.T) {
		e := NewEngine(&types.PermissionPolicy{
			Mode: "ask",
			Rules: []types.PermissionRule{
				{Tool: "*", Decision: "allow"},
			},
		})
		r1 := e.Check(CheckInfo{Tool: "read", Input: map[string]interface{}{}, Cwd: "/tmp"})
		r2 := e.Check(CheckInfo{Tool: "bash", Input: map[string]interface{}{"command": "ls"}, Cwd: "/tmp"})
		if r1.Decision != "allow" {
			t.Errorf("read: expected allow, got %q", r1.Decision)
		}
		if r2.Decision != "allow" {
			t.Errorf("bash: expected allow, got %q", r2.Decision)
		}
	})

	t.Run("matches command patterns", func(t *testing.T) {
		e := NewEngine(&types.PermissionPolicy{
			Mode: "ask",
			Rules: []types.PermissionRule{
				{
					Tool:            "bash",
					Decision:        "allow",
					CommandPatterns: []string{"git *"},
				},
			},
		})
		r1 := e.Check(CheckInfo{
			Tool:  "bash",
			Input: map[string]interface{}{"command": "git status"},
			Cwd:   "/tmp",
		})
		r2 := e.Check(CheckInfo{
			Tool:  "bash",
			Input: map[string]interface{}{"command": "npm install"},
			Cwd:   "/tmp",
		})

		if r1.Decision != "allow" {
			t.Errorf("git status: expected allow, got %q", r1.Decision)
		}
		if r2.Decision != "ask" {
			t.Errorf("npm install: expected ask, got %q", r2.Decision)
		}
	})

	t.Run("matches path patterns", func(t *testing.T) {
		e := NewEngine(&types.PermissionPolicy{
			Mode: "ask",
			Rules: []types.PermissionRule{
				{
					Tool:         "write",
					Decision:     "allow",
					PathPatterns: []string{"/app/src/*"},
				},
			},
		})
		r1 := e.Check(CheckInfo{
			Tool:  "write",
			Input: map[string]interface{}{"path": "/app/src/index.ts"},
			Cwd:   "/tmp",
		})
		r2 := e.Check(CheckInfo{
			Tool:  "write",
			Input: map[string]interface{}{"path": "/app/lib/index.ts"},
			Cwd:   "/tmp",
		})

		if r1.Decision != "allow" {
			t.Errorf("/app/src/index.ts: expected allow, got %q", r1.Decision)
		}
		if r2.Decision != "ask" {
			t.Errorf("/app/lib/index.ts: expected ask, got %q", r2.Decision)
		}
	})

	t.Run("rejects path pattern rule when no path in input", func(t *testing.T) {
		e := NewEngine(&types.PermissionPolicy{
			Mode: "ask",
			Rules: []types.PermissionRule{
				{
					Tool:         "write",
					Decision:     "allow",
					PathPatterns: []string{"/app/*"},
				},
			},
		})
		result := e.Check(CheckInfo{
			Tool:  "write",
			Input: map[string]interface{}{},
			Cwd:   "/tmp",
		})
		if result.Decision != "ask" {
			t.Fatalf("expected ask when no path in input, got %q", result.Decision)
		}
	})

	t.Run("combined command and path patterns", func(t *testing.T) {
		e := NewEngine(&types.PermissionPolicy{
			Mode: "ask",
			Rules: []types.PermissionRule{
				{
					Tool:            "bash",
					Decision:        "allow",
					CommandPatterns: []string{"git *"},
				},
				{
					Tool:         "write",
					Decision:     "allow",
					PathPatterns: []string{"/tmp/*"},
				},
			},
		})

		tests := []struct {
			name     string
			info     CheckInfo
			decision string
		}{
			{
				name: "git command allowed",
				info: CheckInfo{
					Tool:  "bash",
					Input: map[string]interface{}{"command": "git status"},
					Cwd:   "/project",
				},
				decision: "allow",
			},
			{
				name: "write to tmp allowed",
				info: CheckInfo{
					Tool:  "write",
					Input: map[string]interface{}{"path": "/tmp/output.txt"},
					Cwd:   "/project",
				},
				decision: "allow",
			},
			{
				name: "other bash returns ask in ask mode",
				info: CheckInfo{
					Tool:  "bash",
					Input: map[string]interface{}{"command": "npm install"},
					Cwd:   "/project",
				},
				decision: "ask",
			},
		}

		for _, tt := range tests {
			t.Run(tt.name, func(t *testing.T) {
				result := e.Check(tt.info)
				if result.Decision != tt.decision {
					t.Errorf("expected %q, got %q (reason: %s)", tt.decision, result.Decision, result.Reason)
				}
			})
		}
	})

	t.Run("command patterns checked for all tools", func(t *testing.T) {
		// Go engine checks commandPatterns for all tools (not Bash-specific).
		// If commandPatterns is set and input has no "command" key, the rule won't match.
		e := NewEngine(&types.PermissionPolicy{
			Mode: "ask",
			Rules: []types.PermissionRule{
				{
					Tool:            "read",
					Decision:        "allow",
					CommandPatterns: []string{"git *"},
				},
			},
		})
		// Read with commandPatterns but no command in input: rule won't match
		result := e.Check(CheckInfo{
			Tool:  "read",
			Input: map[string]interface{}{"path": "/app/file.txt"},
			Cwd:   "/tmp",
		})
		if result.Decision != "ask" {
			t.Fatalf("expected ask (commandPatterns can't match without command input), got %q", result.Decision)
		}
	})

	t.Run("rule without patterns matches tool only", func(t *testing.T) {
		// A rule with no commandPatterns and no pathPatterns matches any input for that tool
		e := NewEngine(&types.PermissionPolicy{
			Mode: "ask",
			Rules: []types.PermissionRule{
				{Tool: "read", Decision: "allow"},
			},
		})
		result := e.Check(CheckInfo{
			Tool:  "read",
			Input: map[string]interface{}{"path": "/app/file.txt"},
			Cwd:   "/tmp",
		})
		if result.Decision != "allow" {
			t.Fatalf("expected allow for rule with no patterns, got %q", result.Decision)
		}
	})
}
