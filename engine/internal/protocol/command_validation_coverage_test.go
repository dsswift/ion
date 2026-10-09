package protocol

import (
	"go/ast"
	"go/parser"
	"go/token"
	"strconv"
	"testing"
)

// Every command in validCommands needs its own case in validateRaw. A
// command without one falls through to `return false`, so ParseClientCommand
// refuses every request for it as "invalid command" while handler-level
// tests, which skip the parser, still pass.
func TestValidateRawCoversEveryValidCommand(t *testing.T) {
	file, err := parser.ParseFile(token.NewFileSet(), "command_validation.go", nil, 0)
	if err != nil {
		t.Fatalf("parse command_validation.go: %v", err)
	}
	cased := map[string]bool{}
	ast.Inspect(file, func(n ast.Node) bool {
		fn, ok := n.(*ast.FuncDecl)
		if !ok || fn.Name.Name != "validateRaw" {
			return true
		}
		ast.Inspect(fn.Body, func(n ast.Node) bool {
			clause, ok := n.(*ast.CaseClause)
			if !ok {
				return true
			}
			for _, expr := range clause.List {
				if lit, ok := expr.(*ast.BasicLit); ok && lit.Kind == token.STRING {
					if v, err := strconv.Unquote(lit.Value); err == nil {
						cased[v] = true
					}
				}
			}
			return true
		})
		return false
	})
	for cmd := range validCommands {
		if !cased[cmd] {
			t.Errorf("command %q is in validCommands but has no validateRaw case, so every request for it is refused", cmd)
		}
	}
}

func TestParseClientCommandAcceptsDebugProfile(t *testing.T) {
	cmd := ParseClientCommand(`{"cmd":"debug_profile","profileKind":"heap","seconds":5}`)
	if cmd == nil {
		t.Fatal("debug_profile with a profileKind was refused")
	}
	if cmd.ProfileKind != "heap" || cmd.Seconds != 5 {
		t.Fatalf("parsed %+v, want profileKind heap and seconds 5", cmd)
	}
	if ParseClientCommand(`{"cmd":"debug_profile"}`) != nil {
		t.Fatal("debug_profile without a profileKind was accepted")
	}
}
