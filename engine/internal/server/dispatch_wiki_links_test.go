package server

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// TestScanWikiLinksCommand drives scan_wiki_links over the socket: the result
// data is the integrity report for the session's working directory.
func TestScanWikiLinksCommand(t *testing.T) {
	root := t.TempDir()
	for rel, content := range map[string]string{
		"target.md": "t\n",
		"index.md":  "[[target]] and [[vanished|label]]\n",
	} {
		if err := os.WriteFile(filepath.Join(root, rel), []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	srv := newShortPathTestServer(t, newMockBackend())
	conn := dialServer(t, srv)
	defer conn.Close()

	sendJSON(t, conn, map[string]any{
		"cmd": "start_session", "key": "links", "requestId": "s1",
		"config": map[string]any{"profileId": "test", "workingDirectory": root},
	})
	resultFor(t, readLinesUntil(t, conn, 5*time.Second, untilRequest("s1")), "s1")

	sendJSON(t, conn, map[string]any{"cmd": "scan_wiki_links", "key": "links", "requestId": "w1"})
	data := resultFor(t, readLinesUntil(t, conn, 5*time.Second, untilRequest("w1")), "w1")

	if data["documentsScanned"] != float64(2) || data["linksChecked"] != float64(2) {
		t.Fatalf("report = %v", data)
	}
	broken, ok := data["broken"].([]any)
	if !ok || len(broken) != 1 {
		t.Fatalf("broken = %v", data["broken"])
	}
	entry, _ := broken[0].(map[string]any) //nolint:errcheck // asserted below
	if entry["path"] != "index.md" || entry["target"] != "vanished" || entry["reason"] != "missing" || entry["link"] != "[[vanished|label]]" {
		t.Fatalf("broken[0] = %v", entry)
	}
}

// A scan of a session the engine does not know answers with an error result,
// not an empty report.
func TestScanWikiLinksCommandUnknownSession(t *testing.T) {
	srv := newShortPathTestServer(t, newMockBackend())
	conn := dialServer(t, srv)
	defer conn.Close()

	sendJSON(t, conn, map[string]any{"cmd": "scan_wiki_links", "key": "nope", "requestId": "w2"})
	lines := readLinesUntil(t, conn, 5*time.Second, untilRequest("w2"))
	for _, l := range lines {
		if !strings.Contains(l, `"requestId":"w2"`) {
			continue
		}
		var r struct {
			OK    bool   `json:"ok"`
			Error string `json:"error"`
		}
		if err := json.Unmarshal([]byte(l), &r); err != nil {
			t.Fatal(err)
		}
		if r.OK || r.Error == "" {
			t.Fatalf("unknown session scan = %s", l)
		}
		return
	}
	t.Fatalf("no result for w2 in %v", lines)
}
