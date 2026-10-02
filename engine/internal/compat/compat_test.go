package compat

import (
	"go/ast"
	"go/parser"
	"go/token"
	"io/fs"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

// notFormats are version constants that are not a format two Ion builds
// exchange or store, so they stay out of the registry. Each carries why.
var notFormats = map[string]string{
	// A marker that a one-time repair sweep ran over a conversation file; the
	// file's schema is conversation.CurrentVersion.
	"conversation.recoveryRepairVersion": "repair-sweep marker",
	// The version inside an opaque transcript page cursor. The engine both
	// mints and reads it, and refuses one it does not recognize, so the caller
	// restarts paging; nothing is stored and no peer decodes it.
	"conversation.transcriptCursorVersion": "opaque page token the engine mints and reads back",
	// The version the engine reports for itself as an MCP client; no peer
	// accepts or refuses on it.
	"mcp.clientImplementationVersion": "self-identification",
	// The Go relay client's copies of the Studio server's formats. They are
	// the server's versions, not the engine's, and
	// studioclient/vectors_test.go pins each to the server's value.
	"studioclient.E2EKeyDerivationVersion": "copy of a server format, pinned by vectors_test.go",
	"studioclient.RelayEnvelopeVersion":    "copy of a server format, pinned by vectors_test.go",
	"studioclient.studioProtocolVersion":   "copy of a server format, pinned by vectors_test.go",
}

var versionConst = regexp.MustCompile(`(?i)version$`)

// TestEveryVersionConstantIsRegistered fails when the engine gains a version
// constant that is neither in Formats() nor in notFormats, so a new format
// cannot ship without `ion fleet` knowing about it.
func TestEveryVersionConstantIsRegistered(t *testing.T) {
	registered := map[string]bool{}
	for _, f := range Formats() {
		registered[f.Constant] = true
	}
	root := filepath.Join("..", "..")
	fset := token.NewFileSet()
	var found []string
	err := filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() {
			if name := d.Name(); name == "vendor" || name == "node_modules" || name == "testdata" || strings.HasPrefix(name, ".") && path != root {
				return filepath.SkipDir
			}
			return nil
		}
		if !strings.HasSuffix(path, ".go") || strings.HasSuffix(path, "_test.go") {
			return nil
		}
		file, err := parser.ParseFile(fset, path, nil, parser.SkipObjectResolution)
		if err != nil {
			return err
		}
		for _, decl := range file.Decls {
			gen, ok := decl.(*ast.GenDecl)
			if !ok || gen.Tok != token.CONST {
				continue
			}
			for _, spec := range gen.Specs {
				for _, name := range spec.(*ast.ValueSpec).Names {
					if versionConst.MatchString(name.Name) {
						found = append(found, file.Name.Name+"."+name.Name)
					}
				}
			}
		}
		return nil
	})
	if err != nil {
		t.Fatalf("walk engine source: %v", err)
	}
	if len(found) == 0 {
		t.Fatal("found no version constants; the walk is broken")
	}
	for _, c := range found {
		if !registered[c] && notFormats[c] == "" {
			t.Errorf("%s is a version constant with no Format entry: register it in Formats() or give notFormats a reason", c)
		}
	}
	for c := range notFormats {
		if !contains(found, c) {
			t.Errorf("notFormats names %s, which is not a version constant in the engine source", c)
		}
	}
	for c := range registered {
		if !contains(found, c) {
			t.Errorf("Formats() names %s, which is not a version constant in the engine source", c)
		}
	}
}

func contains(list []string, s string) bool {
	for _, v := range list {
		if v == s {
			return true
		}
	}
	return false
}

func TestFormatsAreWellFormed(t *testing.T) {
	seen := map[string]bool{}
	valid := map[Rule]bool{RuleExact: true, RuleAcceptsPrevious: true, RuleReaderAtLeast: true, RuleHostStorage: true, RuleExternal: true}
	for _, f := range Formats() {
		if f.ID == "" || f.Version == "" || f.Meaning == "" || f.Owner != OwnerEngine {
			t.Errorf("incomplete entry: %+v", f)
		}
		if !valid[f.Rule] {
			t.Errorf("%s: unknown rule %q", f.ID, f.Rule)
		}
		if seen[f.ID] {
			t.Errorf("duplicate id %s", f.ID)
		}
		seen[f.ID] = true
	}
}
