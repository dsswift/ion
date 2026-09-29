// Package principalboundary is FR-03's in-process execution boundary: with
// principal partitioning enabled, a session may not use its own tools to
// read or write another principal's partition, regardless of whether the
// engine's OWN storage-resolution logic would ever have pointed it there.
//
// This is a backstop, not the primary boundary. The primary boundary for a
// shell is OS-level (the sandbox package's seatbelt/bwrap wrapping, wired
// alongside this checker) -- an in-process string check on a Bash command
// can always be defeated by a sufficiently indirect command
// (`$(base64 -d <<< ...)`, a subshell, a symlink). This package exists for
// the tools that AREN'T a shell -- Read/Write/Edit/NotebookEdit/Glob/Grep
// take a structured path argument with nothing to obfuscate -- and as a
// cheap, immediate refusal for the common, non-adversarial Bash case
// (`cat /principals/bob/...`) before the sandbox's process-level denial
// would otherwise be the only thing stopping it.
package principalboundary

import (
	"path/filepath"
	"strings"

	"github.com/dsswift/ion/engine/internal/conversation"
	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/workspaces"
)

// Refusal is the typed verdict for a refused tool call, mirroring
// workspaces.Refusal's shape so the two share the same tool-loop refusal
// path (runloop_tools.go) and the same permission_denied observability.
type Refusal struct {
	Target string
	Reason string
}

var readTools = map[string]bool{"Read": true, "read": true, "Glob": true, "glob": true, "Grep": true, "grep": true}
var writeTools = map[string]bool{"Write": true, "write": true, "Edit": true, "edit": true, "NotebookEdit": true, "notebookedit": true}
var bashTools = map[string]bool{"Bash": true, "bash": true}

// Checker answers "may this tool call proceed?" for the calling session's
// own principal boundary. Nil-safe: a nil *Checker (partitioning disabled,
// or the session is unattributed -- an unattributed session has no
// partition of its own to protect, and FR-01's storage layer already keeps
// it out of every partition) passes everything.
type Checker struct {
	// ownPartitionDir is this session's own principals/<dir> directory
	// (the whole partition -- conversations/, git/, everything under it),
	// or "" for an unattributed session (Checker is nil in that case; see
	// New).
	ownPartitionDir string
	// principalsRoot is <dataDir>/principals -- every OTHER subdirectory of
	// this is off-limits.
	principalsRoot string
	// flatRoot is <dataDir>/conversations -- off-limits to an attributed
	// session (FR-01: "an attributed session can never see the flat root").
	flatRoot    string
	enforcement types.PrincipalEnforcement
}

// New returns a Checker for subject at the given enforcement level, or nil
// when partitioning is disabled, enforcement is EnforcementNone, or subject
// is empty (nothing to protect). Threaded onto RunConfig.PrincipalBoundary
// exactly like workspaces.Checker is threaded as RunConfig.WorkspaceChecker.
func New(subject string, enforcement types.PrincipalEnforcement) *Checker {
	if subject == "" || enforcement == types.EnforcementNone {
		return nil
	}
	root := conversation.PartitionRoot()
	if root == "" {
		return nil
	}
	return &Checker{
		ownPartitionDir: filepath.Dir(conversation.PartitionConversationsDir(subject)),
		principalsRoot:  filepath.Join(filepath.Dir(root), "principals"),
		flatRoot:        root,
		enforcement:     enforcement,
	}
}

// Check is the single verdict function the tool loop calls before executing
// a gated tool. Returns nil when the call may proceed, or a typed Refusal.
func (c *Checker) Check(tool string, input map[string]interface{}, cwd string) *Refusal {
	if c == nil {
		return nil
	}

	isRead := readTools[tool]
	isWrite := writeTools[tool]
	isBash := bashTools[tool]
	if !isRead && !isWrite && !isBash {
		return nil
	}
	// read-only enforcement lets a cross-partition READ through; strict
	// refuses everything. Bash is judged as a write tool regardless of
	// enforcement level -- a Bash command's read/write intent cannot be
	// classified reliably from its text, and the sandbox (this checker's
	// OS-level backstop) makes the same all-or-nothing call for Bash.
	gateThisCall := c.enforcement == types.EnforcementStrict || isWrite || isBash

	if isBash {
		cmd, ok := input["command"].(string)
		if !ok || cmd == "" {
			return nil
		}
		return c.checkBash(cmd, cwd, gateThisCall)
	}

	target := workspaces.ExtractTargetPath(input, cwd)
	if target == "" {
		return nil
	}
	return c.checkPath(target, gateThisCall)
}

// checkBash judges every directory and literal absolute path a Bash command
// touches. gateThisCall is always true for Bash (see Check) -- kept as a
// parameter rather than inlined so the read/write classification stays
// visible at the call site and this function's own logic stays symmetric
// with checkPath's.
func (c *Checker) checkBash(command, cwd string, gateThisCall bool) *Refusal {
	if !gateThisCall {
		return nil
	}
	for _, dir := range workspaces.BashSegmentDirs(command, cwd) {
		if r := c.checkPath(dir, true); r != nil {
			return r
		}
	}
	for _, tok := range workspaces.LiteralAbsolutePathTokens(command) {
		if r := c.checkPath(tok, true); r != nil {
			return r
		}
	}
	return nil
}

// checkPath judges one absolute path against the session's own partition.
// A path outside BOTH principalsRoot and flatRoot is not this checker's
// concern (workspaces.Checker and the sandbox's deny-read list handle
// everything else); this checker only refuses paths that are SPECIFICALLY
// someone else's partition, or the flat root.
func (c *Checker) checkPath(target string, gateThisCall bool) *Refusal {
	if !gateThisCall || target == "" {
		return nil
	}
	clean := filepath.Clean(target)

	if within(clean, c.ownPartitionDir) {
		return nil
	}
	if within(clean, c.principalsRoot) {
		return &Refusal{
			Target: clean,
			Reason: "Refused: " + clean + " is inside another principal's partition. This engine partitions conversation storage per principal (FR-01); a session may only read/write its own.",
		}
	}
	if within(clean, c.flatRoot) {
		return &Refusal{
			Target: clean,
			Reason: "Refused: " + clean + " is the unpartitioned conversations root. An attributed session (this one) never sees unattributed/legacy conversation storage once principal partitioning is enabled.",
		}
	}
	return nil
}

func within(path, root string) bool {
	if root == "" {
		return false
	}
	rel, err := filepath.Rel(root, path)
	if err != nil {
		return false
	}
	return rel == "." || (!strings.HasPrefix(rel, "..") && rel != "..")
}
