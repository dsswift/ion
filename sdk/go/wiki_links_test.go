package ion

import (
	"context"
	"reflect"
	"testing"
)

func TestScanWikiLinksDecodesReport(t *testing.T) {
	fe := newFakeEngine(t, WithName("wiki-links-test"))
	fe.start()
	fe.doInit(ExtensionConfig{})

	type outcome struct {
		report WikiLinkIntegrityReport
		err    error
	}
	done := make(chan outcome, 1)
	go func() {
		report, err := fe.sdk.newContext(nil).ScanWikiLinks(context.Background())
		done <- outcome{report, err}
	}()
	frame := fe.awaitMethod("ext/scan_wiki_links")
	id, _ := frame["id"].(float64)
	fe.respond(id, map[string]any{
		"root": "/work", "documentsScanned": 3, "linksChecked": 5,
		"broken": []any{map[string]any{
			"path": "index.md", "line": 4, "link": "[[dup]]", "target": "dup",
			"reason": "ambiguous", "candidates": []any{"a/dup.md", "b/dup.md"},
		}},
	})
	got := <-done
	if got.err != nil {
		t.Fatalf("ScanWikiLinks: %v", got.err)
	}
	want := WikiLinkIntegrityReport{
		Root: "/work", DocumentsScanned: 3, LinksChecked: 5,
		Broken: []WikiLinkBrokenLink{{
			Path: "index.md", Line: 4, Link: "[[dup]]", Target: "dup",
			Reason: WikiLinkAmbiguous, Candidates: []string{"a/dup.md", "b/dup.md"},
		}},
	}
	if !reflect.DeepEqual(got.report, want) {
		t.Fatalf("report = %+v, want %+v", got.report, want)
	}
}
