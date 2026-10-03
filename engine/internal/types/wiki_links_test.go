package types

import (
	"encoding/json"
	"reflect"
	"testing"
)

func TestWikiLinksConfigDefaultsAreOn(t *testing.T) {
	var cfg *WikiLinksConfig
	if !cfg.IsEnabled() || !cfg.PropagationEnabled() || !cfg.IntegrityScanEnabled() {
		t.Fatal("nil config must enable everything")
	}
	if got := cfg.DocumentExtensions(); !reflect.DeepEqual(got, []string{".md"}) {
		t.Fatalf("default extensions = %v", got)
	}
}

func TestWikiLinksConfigMasterSwitchDisablesBothHalves(t *testing.T) {
	cfg := &WikiLinksConfig{Enabled: boolPtr(false), PropagateOnRename: boolPtr(true), IntegrityScan: boolPtr(true)}
	if cfg.IsEnabled() || cfg.PropagationEnabled() || cfg.IntegrityScanEnabled() {
		t.Fatal("master switch off must disable propagation and the scan")
	}
}

func TestWikiLinksConfigHalvesAreIndependent(t *testing.T) {
	noPropagation := &WikiLinksConfig{PropagateOnRename: boolPtr(false)}
	if noPropagation.PropagationEnabled() || !noPropagation.IntegrityScanEnabled() || !noPropagation.IsEnabled() {
		t.Fatalf("propagation off: %+v", noPropagation)
	}
	noScan := &WikiLinksConfig{IntegrityScan: boolPtr(false)}
	if !noScan.PropagationEnabled() || noScan.IntegrityScanEnabled() {
		t.Fatalf("scan off: %+v", noScan)
	}
}

func TestWikiLinksConfigNormalizesExtensions(t *testing.T) {
	cfg := &WikiLinksConfig{Extensions: []string{"MD", ".markdown", " md ", "", "."}}
	if got := cfg.DocumentExtensions(); !reflect.DeepEqual(got, []string{".md", ".markdown"}) {
		t.Fatalf("extensions = %v", got)
	}
}

// A later config layer that sets one switch must not reset the others, and an
// explicit false must survive the merge.
func TestMergeWikiLinksKeepsUnsetFields(t *testing.T) {
	var base, overlay WikiLinksConfig
	if err := json.Unmarshal([]byte(`{"propagateOnRename":false,"extensions":[".md",".mdx"]}`), &base); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal([]byte(`{"integrityScan":false}`), &overlay); err != nil {
		t.Fatal(err)
	}
	merged := MergeWikiLinks(&base, &overlay)
	if merged.PropagationEnabled() || merged.IntegrityScanEnabled() || !merged.IsEnabled() {
		t.Fatalf("merged = %+v", merged)
	}
	if got := merged.DocumentExtensions(); !reflect.DeepEqual(got, []string{".md", ".mdx"}) {
		t.Fatalf("extensions = %v", got)
	}
	if MergeWikiLinks(nil, nil) != nil {
		t.Fatal("nil merge must stay nil")
	}
}

// The propagation report crosses the wire inside EngineEvent. This pins its
// JSON shape, and that an empty pass still serializes its lists as arrays.
func TestWikiLinksPropagatedEventWireShape(t *testing.T) {
	event := EngineEvent{
		Type: "engine_wiki_links_propagated",
		WikiLinksPropagated: &WikiLinkPropagationReport{
			Root:    "/work",
			Renames: []WikiLinkRename{{OldPath: "a.md", NewPath: "b.md"}},
			Files: []WikiLinkFileRewrites{{
				Path: "index.md",
				Rewrites: []WikiLinkRewrite{{
					Line: 3, OldLink: "[[a|label]]", NewLink: "[[b|label]]", OldTarget: "a.md", NewTarget: "b.md",
				}},
			}},
			RewriteCount: 1,
		},
	}
	raw, err := json.Marshal(event)
	if err != nil {
		t.Fatal(err)
	}
	var envelope map[string]json.RawMessage
	if err := json.Unmarshal(raw, &envelope); err != nil {
		t.Fatal(err)
	}
	want := `{"root":"/work",` +
		`"renames":[{"oldPath":"a.md","newPath":"b.md"}],` +
		`"files":[{"path":"index.md","rewrites":[{"line":3,"oldLink":"[[a|label]]","newLink":"[[b|label]]","oldTarget":"a.md","newTarget":"b.md"}]}],` +
		`"rewriteCount":1}`
	if got := string(envelope["wikiLinksPropagated"]); got != want {
		t.Fatalf("wire shape\n have %s\n want %s", got, want)
	}

	var back EngineEvent
	if err := json.Unmarshal(raw, &back); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(back.WikiLinksPropagated, event.WikiLinksPropagated) {
		t.Fatalf("round trip = %+v", back.WikiLinksPropagated)
	}
}

func TestWikiLinkIntegrityReportWireShape(t *testing.T) {
	raw, err := json.Marshal(WikiLinkIntegrityReport{
		Root: "/work", DocumentsScanned: 2, LinksChecked: 1,
		Broken: []WikiLinkBrokenLink{{
			Path: "index.md", Line: 1, Link: "[[dup]]", Target: "dup", Reason: WikiLinkAmbiguous, Candidates: []string{"a/dup.md", "b/dup.md"},
		}},
	})
	if err != nil {
		t.Fatal(err)
	}
	want := `{"root":"/work","documentsScanned":2,"linksChecked":1,` +
		`"broken":[{"path":"index.md","line":1,"link":"[[dup]]","target":"dup","reason":"ambiguous","candidates":["a/dup.md","b/dup.md"]}]}`
	if string(raw) != want {
		t.Fatalf("wire shape\n have %s\n want %s", raw, want)
	}
}
