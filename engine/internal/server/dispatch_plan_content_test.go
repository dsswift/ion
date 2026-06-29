package server

// dispatch_plan_content_test.go — end-to-end tests for the get_plan_content
// command handler. Each test goes through the full JSON-decode → dispatch
// path so the security check and paging logic are exercised against actual
// wire input.
//
// Test matrix:
//  1. Normal single-window fetch: file <= 64 KB → hasMore=false, correct content.
//  2. Multi-window fetch: file > 64 KB → hasMore=true on first page, then fetch
//     page 2 with offset = first-page byte length → hasMore=false.
//  3. Path rejection: path outside the session's plan directory → result ok=false.
//  4. Past-EOF: offset > file size → empty content, hasMore=false.

import (
	"encoding/json"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/dsswift/ion/engine/internal/types"
)

// planContentTestEnv sets up a server with a started session whose working
// directory is set to planWorkingDir. planWorkingDir is also the base for
// the plan directory (<planWorkingDir>/.ion/plans/). Returns the server,
// the client conn, and the plan directory path.
func planContentTestEnv(t *testing.T, planWorkingDir string) (*Server, net.Conn, string) {
	t.Helper()

	mb := newMockBackend()
	srv := newShortPathTestServer(t, mb)

	conn := dialServer(t, srv)
	t.Cleanup(func() { conn.Close() })

	// Start a session with a working directory pointing at planWorkingDir.
	sendJSON(t, conn, map[string]interface{}{
		"cmd": "start_session",
		"key": "plan-test",
		"config": map[string]interface{}{
			"profileId":        "default",
			"extensionDir":     "/tmp",
			"workingDirectory": planWorkingDir,
			"model":            "claude-sonnet-4-6",
		},
		"requestId": "req-start",
	})
	_ = readLines(t, conn, 8, 2*time.Second)

	planDir := filepath.Join(planWorkingDir, ".ion", "plans")
	if err := os.MkdirAll(planDir, 0755); err != nil {
		t.Fatalf("MkdirAll planDir: %v", err)
	}

	return srv, conn, planDir
}

// findPlanContentEvent scans NDJSON lines for an engine_plan_content event and
// unmarshals it into EngineEvent. Returns nil when not found.
func findPlanContentEvent(t *testing.T, lines []string) *types.EngineEvent {
	t.Helper()
	for _, l := range lines {
		if !strings.Contains(l, `"engine_plan_content"`) {
			continue
		}
		// Engine events are wrapped: {"key":"...","event":{...}}
		var wrapper struct {
			Event json.RawMessage `json:"event"`
		}
		if err := json.Unmarshal([]byte(l), &wrapper); err != nil {
			continue
		}
		var evt types.EngineEvent
		if err := json.Unmarshal(wrapper.Event, &evt); err != nil {
			continue
		}
		if evt.Type == types.EventPlanContent {
			return &evt
		}
	}
	return nil
}

// TestGetPlanContent_SingleWindow verifies that a plan file smaller than
// 64 KB is returned in one event with hasMore=false.
func TestGetPlanContent_SingleWindow(t *testing.T) {
	workDir := t.TempDir()
	srv, conn, planDir := planContentTestEnv(t, workDir)
	_ = srv

	// Write a small plan file.
	planPath := filepath.Join(planDir, "gentle-perching-lemon.md")
	content := "# Plan\n\nStep 1: do the thing.\n"
	if err := os.WriteFile(planPath, []byte(content), 0644); err != nil {
		t.Fatalf("WriteFile: %v", err)
	}

	sendJSON(t, conn, map[string]interface{}{
		"cmd":       "get_plan_content",
		"key":       "plan-test",
		"path":      planPath,
		"offset":    0,
		"limit":     0,
		"requestId": "req-gpc-1",
	})

	lines := readLines(t, conn, 4, 2*time.Second)
	evt := findPlanContentEvent(t, lines)
	if evt == nil {
		t.Fatalf("no plan_content event; lines=%v", lines)
	}

	if evt.PlanContentBody != content {
		t.Errorf("content mismatch\n got: %q\nwant: %q", evt.PlanContentBody, content)
	}
	if evt.PlanContentHasMore {
		t.Errorf("HasMore: got true, want false for single-window fetch")
	}
	if evt.PlanContentTotalBytes != len(content) {
		t.Errorf("TotalBytes: got %d, want %d", evt.PlanContentTotalBytes, len(content))
	}
	if evt.PlanContentOffset != 0 {
		t.Errorf("Offset: got %d, want 0", evt.PlanContentOffset)
	}
	if evt.PlanModeFilePath != planPath {
		t.Errorf("PlanFilePath: got %q, want %q", evt.PlanModeFilePath, planPath)
	}
}

// TestGetPlanContent_MultiWindow verifies paging: a file larger than the
// requested limit comes back with hasMore=true on the first page, and
// the second request (offset advanced) returns the rest with hasMore=false.
func TestGetPlanContent_MultiWindow(t *testing.T) {
	workDir := t.TempDir()
	srv, conn, planDir := planContentTestEnv(t, workDir)
	_ = srv

	// Write a 6-byte plan file and use a 4-byte limit to force two pages.
	planPath := filepath.Join(planDir, "multi-page.md")
	fullContent := "ABCDEF"
	if err := os.WriteFile(planPath, []byte(fullContent), 0644); err != nil {
		t.Fatalf("WriteFile: %v", err)
	}

	// Page 1: limit=4 → should return "ABCD", hasMore=true.
	sendJSON(t, conn, map[string]interface{}{
		"cmd":       "get_plan_content",
		"key":       "plan-test",
		"path":      planPath,
		"offset":    0,
		"limit":     4,
		"requestId": "req-page1",
	})
	lines1 := readLines(t, conn, 4, 2*time.Second)
	page1 := findPlanContentEvent(t, lines1)
	if page1 == nil {
		t.Fatalf("no plan_content event for page 1; lines=%v", lines1)
	}
	if page1.PlanContentBody != "ABCD" {
		t.Errorf("page1.Content: got %q, want %q", page1.PlanContentBody, "ABCD")
	}
	if !page1.PlanContentHasMore {
		t.Errorf("page1.HasMore: got false, want true")
	}
	if page1.PlanContentTotalBytes != 6 {
		t.Errorf("page1.TotalBytes: got %d, want 6", page1.PlanContentTotalBytes)
	}

	// Page 2: offset=4, limit=4 → should return "EF", hasMore=false.
	nextOffset := page1.PlanContentOffset + len(page1.PlanContentBody)
	sendJSON(t, conn, map[string]interface{}{
		"cmd":       "get_plan_content",
		"key":       "plan-test",
		"path":      planPath,
		"offset":    nextOffset,
		"limit":     4,
		"requestId": "req-page2",
	})
	lines2 := readLines(t, conn, 4, 2*time.Second)
	page2 := findPlanContentEvent(t, lines2)
	if page2 == nil {
		t.Fatalf("no plan_content event for page 2; lines=%v", lines2)
	}
	if page2.PlanContentBody != "EF" {
		t.Errorf("page2.Content: got %q, want %q", page2.PlanContentBody, "EF")
	}
	if page2.PlanContentHasMore {
		t.Errorf("page2.HasMore: got true, want false")
	}

	// Assembled content matches the original.
	assembled := page1.PlanContentBody + page2.PlanContentBody
	if assembled != fullContent {
		t.Errorf("assembled content: got %q, want %q", assembled, fullContent)
	}
}

// TestGetPlanContent_PathRejection verifies that a path outside the session's
// plan directory is refused. The server must return a result with ok=false.
func TestGetPlanContent_PathRejection(t *testing.T) {
	workDir := t.TempDir()
	srv, conn, _ := planContentTestEnv(t, workDir)
	_ = srv

	// Create a file outside the plan directory.
	outsidePath := filepath.Join(workDir, "secret.txt")
	if err := os.WriteFile(outsidePath, []byte("secret"), 0644); err != nil {
		t.Fatalf("WriteFile: %v", err)
	}

	sendJSON(t, conn, map[string]interface{}{
		"cmd":       "get_plan_content",
		"key":       "plan-test",
		"path":      outsidePath,
		"offset":    0,
		"limit":     0,
		"requestId": "req-reject",
	})

	lines := readLines(t, conn, 3, 2*time.Second)

	// Expect a result with ok=false. Must NOT contain a plan_content event.
	result := findResult(t, lines)
	if result == nil {
		t.Fatalf("no result received; lines=%v", lines)
	}
	if result.OK {
		t.Errorf("expected ok=false for path outside plan dir, got ok=true")
	}
	if !strings.Contains(result.Error, "outside") && !strings.Contains(result.Error, "plan directory") {
		t.Errorf("error message should mention path/plan-directory; got %q", result.Error)
	}

	// Confirm no plan_content event leaked.
	evt := findPlanContentEvent(t, lines)
	if evt != nil {
		t.Errorf("plan_content event must not be emitted for rejected paths; got %+v", evt)
	}
}

// TestGetPlanContent_PastEOF verifies that requesting an offset past the end
// of the file returns an empty content string with hasMore=false.
func TestGetPlanContent_PastEOF(t *testing.T) {
	workDir := t.TempDir()
	srv, conn, planDir := planContentTestEnv(t, workDir)
	_ = srv

	planPath := filepath.Join(planDir, "small.md")
	if err := os.WriteFile(planPath, []byte("hi"), 0644); err != nil {
		t.Fatalf("WriteFile: %v", err)
	}

	// Offset way past EOF.
	sendJSON(t, conn, map[string]interface{}{
		"cmd":       "get_plan_content",
		"key":       "plan-test",
		"path":      planPath,
		"offset":    9999,
		"limit":     0,
		"requestId": "req-eof",
	})

	lines := readLines(t, conn, 4, 2*time.Second)
	evt := findPlanContentEvent(t, lines)
	if evt == nil {
		t.Fatalf("no plan_content event; lines=%v", lines)
	}
	if evt.PlanContentBody != "" {
		t.Errorf("Content past EOF: got %q, want empty string", evt.PlanContentBody)
	}
	if evt.PlanContentHasMore {
		t.Errorf("HasMore past EOF: got true, want false")
	}
	if evt.PlanContentTotalBytes != 2 {
		t.Errorf("TotalBytes past EOF: got %d, want 2", evt.PlanContentTotalBytes)
	}
}

// TestGetPlanContent_PathOutsideAbsolute verifies the path traversal
// variant: a path like /etc/passwd is rejected even if it accidentally
// passes a naive prefix check.
func TestGetPlanContent_AbsolutePathOutsidePlanDir(t *testing.T) {
	workDir := t.TempDir()
	srv, conn, _ := planContentTestEnv(t, workDir)
	_ = srv

	// Create a real file in a separate temp dir that is guaranteed to be
	// outside the session's plan directory tree. Using an independent
	// t.TempDir() (rather than a fixed system path like /etc/hostname that
	// may not exist on all platforms) makes the test cross-platform and
	// eliminates the platform-conditional t.Skip.
	outsideDir := t.TempDir()
	hostPath := filepath.Join(outsideDir, "sensitive.txt")
	if err := os.WriteFile(hostPath, []byte("sensitive data"), 0644); err != nil {
		t.Fatalf("WriteFile: %v", err)
	}

	sendJSON(t, conn, map[string]interface{}{
		"cmd":       "get_plan_content",
		"key":       "plan-test",
		"path":      hostPath,
		"offset":    0,
		"limit":     0,
		"requestId": fmt.Sprintf("req-etc-%d", time.Now().UnixNano()),
	})

	lines := readLines(t, conn, 3, 2*time.Second)
	result := findResult(t, lines)
	if result == nil {
		t.Fatalf("no result received; lines=%v", lines)
	}
	if result.OK {
		t.Errorf("expected ok=false for absolute path outside plan dir, got ok=true")
	}
}

// TestGetPlanContent_DotDotPrefixFilenameAccepted verifies that a plan file
// whose *filename* literally begins with ".." (e.g. "..notes.md") but which
// lives INSIDE a valid plan dir is read successfully. The ".." segment
// boundary is not crossed, so this is a legitimate in-dir file — a naive
// strings.HasPrefix(rel, "..") containment test would wrongly reject it.
// This test fails on the old HasPrefix form and passes on the boundary-correct
// form (rel != ".." && !HasPrefix(rel, ".."+Separator)).
func TestGetPlanContent_DotDotPrefixFilenameAccepted(t *testing.T) {
	workDir := t.TempDir()
	srv, conn, planDir := planContentTestEnv(t, workDir)
	_ = srv

	// A file named "..notes.md" inside the plan dir: rel == "..notes.md",
	// which has a ".." PREFIX but does not cross the ".." segment boundary.
	planPath := filepath.Join(planDir, "..notes.md")
	content := "# Notes\n\nLegit in-dir file with a dotdot-prefixed name.\n"
	if err := os.WriteFile(planPath, []byte(content), 0644); err != nil {
		t.Fatalf("WriteFile: %v", err)
	}

	sendJSON(t, conn, map[string]interface{}{
		"cmd":       "get_plan_content",
		"key":       "plan-test",
		"path":      planPath,
		"offset":    0,
		"limit":     0,
		"requestId": "req-dotdot-name",
	})

	lines := readLines(t, conn, 4, 2*time.Second)
	evt := findPlanContentEvent(t, lines)
	if evt == nil {
		t.Fatalf("a dotdot-prefixed FILENAME inside the plan dir must be accepted; "+
			"got no plan_content event; lines=%v", lines)
	}
	if evt.PlanContentBody != content {
		t.Errorf("content mismatch\n got: %q\nwant: %q", evt.PlanContentBody, content)
	}
}

// TestGetPlanContent_SymlinkEscapeRejected verifies that a symlink placed
// INSIDE a valid plan dir that targets a file OUTSIDE it is rejected. Without
// symlink resolution (filepath.EvalSymlinks) the lexical path of the symlink
// is inside the plan dir and would pass the containment test, turning the
// command into an arbitrary-file-read oracle. This test fails without the
// EvalSymlinks guard and passes with it.
func TestGetPlanContent_SymlinkEscapeRejected(t *testing.T) {
	workDir := t.TempDir()
	srv, conn, planDir := planContentTestEnv(t, workDir)
	_ = srv

	// Secret file OUTSIDE the plan dir (sibling of .ion under workDir).
	secretPath := filepath.Join(workDir, "secret.txt")
	if err := os.WriteFile(secretPath, []byte("top secret"), 0644); err != nil {
		t.Fatalf("WriteFile secret: %v", err)
	}

	// A symlink INSIDE the plan dir pointing at the outside secret.
	linkPath := filepath.Join(planDir, "escape.md")
	if err := os.Symlink(secretPath, linkPath); err != nil {
		t.Skipf("symlink unsupported in this environment: %v", err)
	}

	sendJSON(t, conn, map[string]interface{}{
		"cmd":       "get_plan_content",
		"key":       "plan-test",
		"path":      linkPath,
		"offset":    0,
		"limit":     0,
		"requestId": "req-symlink-escape",
	})

	lines := readLines(t, conn, 3, 2*time.Second)

	// Expect rejection: a result with ok=false and no plan_content event.
	result := findResult(t, lines)
	if result == nil {
		t.Fatalf("no result received; lines=%v", lines)
	}
	if result.OK {
		t.Errorf("expected ok=false for a symlink escaping the plan dir, got ok=true")
	}
	if evt := findPlanContentEvent(t, lines); evt != nil {
		t.Errorf("plan_content event must not be emitted for a symlink escape; got %+v", evt)
	}
}
