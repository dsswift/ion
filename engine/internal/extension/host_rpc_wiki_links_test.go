package extension

import (
	"errors"
	"testing"
	"time"

	"github.com/dsswift/ion/engine/internal/types"
)

// TestExtScanWikiLinks_ReturnsReport pins the wire shape of the integrity
// scan RPC: the result is the report itself.
func TestExtScanWikiLinks_ReturnsReport(t *testing.T) {
	h := NewHost()
	ch := attachStdout(h)
	h.ctxStack.Push(&Context{
		Cwd: "/tmp",
		ScanWikiLinks: func() (types.WikiLinkIntegrityReport, error) {
			return types.WikiLinkIntegrityReport{
				Root: "/work", DocumentsScanned: 3, LinksChecked: 5,
				Broken: []types.WikiLinkBrokenLink{{
					Path: "index.md", Line: 4, Link: "[[gone|label]]", Target: "gone", Reason: types.WikiLinkMissing,
				}},
			}, nil
		},
	})
	h.handleExtRequest("ext/scan_wiki_links", 1, []byte(`{"jsonrpc":"2.0","id":1,"method":"ext/scan_wiki_links","params":{}}`))

	resp := readResponse(t, ch, time.Second)
	result, ok := resp["result"].(map[string]interface{})
	if !ok {
		t.Fatalf("expected object result, got %#v", resp)
	}
	if result["root"] != "/work" || result["documentsScanned"] != float64(3) || result["linksChecked"] != float64(5) {
		t.Fatalf("report header = %#v", result)
	}
	broken, ok := result["broken"].([]interface{})
	if !ok || len(broken) != 1 {
		t.Fatalf("broken = %#v, want one entry", result["broken"])
	}
	entry, _ := broken[0].(map[string]interface{}) //nolint:errcheck // fields asserted below
	for key, want := range map[string]interface{}{
		"path": "index.md", "line": float64(4), "link": "[[gone|label]]", "target": "gone", "reason": "missing",
	} {
		if entry[key] != want {
			t.Errorf("broken[0][%q] = %#v, want %#v", key, entry[key], want)
		}
	}
}

// TestExtScanWikiLinks_ErrorIsNotAnEmptyReport pins that a refused scan
// answers with an error, so "nothing broken" and "nothing scanned" differ.
func TestExtScanWikiLinks_ErrorIsNotAnEmptyReport(t *testing.T) {
	h := NewHost()
	ch := attachStdout(h)
	h.ctxStack.Push(&Context{
		Cwd: "/tmp",
		ScanWikiLinks: func() (types.WikiLinkIntegrityReport, error) {
			return types.WikiLinkIntegrityReport{}, errors.New("wiki link integrity scan is disabled")
		},
	})
	h.handleExtRequest("ext/scan_wiki_links", 1, []byte(`{"jsonrpc":"2.0","id":1,"method":"ext/scan_wiki_links","params":{}}`))

	resp := readResponse(t, ch, time.Second)
	if _, hasResult := resp["result"]; hasResult {
		t.Fatalf("refused scan returned a result: %#v", resp)
	}
	rpcErr, ok := resp["error"].(map[string]interface{})
	if !ok || rpcErr["message"] != "wiki link integrity scan is disabled" {
		t.Fatalf("error = %#v", resp["error"])
	}
}
