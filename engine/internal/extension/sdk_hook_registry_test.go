package extension

import (
	"go/ast"
	"go/parser"
	"go/token"
	"reflect"
	"sort"
	"strconv"
	"testing"
)

// TestHookRegistryCoversAllConstants pins the hook registry to the hook
// constants themselves. Go constants are not reflectable, so the check parses
// the Hook* const block in sdk.go and asserts set-equality with hookSpecs().
//
// Without this, a new hook constant could land with no registry entry, the
// SDK contract manifest would silently omit it, and every client SDK would
// pass its parity test while missing a hook the engine fires.
func TestHookRegistryCoversAllConstants(t *testing.T) {
	constants := parseHookConstants(t, "sdk.go")
	if len(constants) == 0 {
		t.Fatal("parsed zero Hook* constants from sdk.go — the parser is broken, not the registry")
	}

	specs := hookSpecs()

	var missing []string
	for name, value := range constants {
		if _, ok := specs[value]; !ok {
			missing = append(missing, name+" ("+value+")")
		}
	}
	sort.Strings(missing)
	if len(missing) > 0 {
		t.Errorf("hook constants with no hookSpecs() entry: %v\n"+
			"Add an entry to sdk_hook_registry.go, then regenerate the manifest:\n"+
			"  cd engine && go test ./internal/extension/ -run TestSDKContractManifest -update", missing)
	}

	values := make(map[string]bool, len(constants))
	for _, v := range constants {
		values[v] = true
	}
	var extra []string
	for hook := range specs {
		if !values[hook] {
			extra = append(extra, hook)
		}
	}
	sort.Strings(extra)
	if len(extra) > 0 {
		t.Errorf("hookSpecs() entries with no Hook* constant in sdk.go: %v\n"+
			"Either the constant was removed (delete the registry entry) or the key is misspelled.", extra)
	}
}

// TestHookRegistryMatchesForwarders asserts the result category each hook
// declares equals the category the forwarder actually installs. The registry
// is data and the forwarders are code; this is what keeps them the same
// statement.
//
// Hooks with no subprocess forwarder are exempt: they fire into in-process
// handlers only (the engine calls SDK.Fire* and any registered handler runs
// in-engine), so there is no forwarder to compare against. They still carry
// registry entries because an external SDK reaches them through the untyped
// on(name) path and needs the payload shape.
func TestHookRegistryMatchesForwarders(t *testing.T) {
	h := NewHost()
	t.Cleanup(func() { h.Dispose() })
	h.registerHookForwarders()

	installed := h.installedForwarders()
	if len(installed) == 0 {
		t.Fatal("registerHookForwarders installed nothing — the audit wiring is broken")
	}

	specs := hookSpecs()
	for hook, kind := range installed {
		spec, ok := specs[hook]
		if !ok {
			t.Errorf("forwarder registered for %q but hookSpecs() has no entry", hook)
			continue
		}
		if spec.Result != kind {
			t.Errorf("hook %q: registry declares result %q, forwarder installs %q",
				hook, spec.Result, kind)
		}
	}

	// Every hook without a forwarder must be one the engine fires
	// in-process only. Record them so the set is visible and a change to it
	// is a deliberate edit rather than an accident.
	inProcessOnly := map[string]bool{
		HookCompactSummaryRequest:   true,
		HookBeforeEarlyStopDecision: true,
		HookEarlyStopContinued:      true,
		HookBackgroundTaskCompleted: true,
		HookWorkspaceFileChanged:    true,
	}
	for hook := range specs {
		if _, forwarded := installed[hook]; forwarded {
			continue
		}
		if !inProcessOnly[hook] {
			t.Errorf("hook %q has a registry entry but no subprocess forwarder and is not in the in-process-only set.\n"+
				"Either add a forwarder in hook_forwarders.go (so subprocess extensions can receive it) "+
				"or add it to inProcessOnly here with the reason.", hook)
		}
	}
}

// TestHookRegistryPayloadsAreStructsOrNil guards the manifest generator's
// assumption: a spec payload is either nil (no payload), a string (bare value
// the transport wraps under _payload), or a struct whose JSON tags describe
// the wire shape. A pointer or map exemplar would silently produce an empty
// field list in the manifest.
func TestHookRegistryPayloadsAreStructsOrNil(t *testing.T) {
	for hook, spec := range hookSpecs() {
		if spec.Payload == nil {
			continue
		}
		k := reflect.TypeOf(spec.Payload).Kind()
		if k != reflect.Struct && k != reflect.String {
			t.Errorf("hook %q payload exemplar is %s; use a struct value, a string, or nil", hook, k)
		}
		if spec.Result == hookResultStructured && spec.ResultType == nil {
			t.Errorf("hook %q declares a structured result but has no ResultType exemplar", hook)
		}
		if spec.Result != hookResultStructured && spec.ResultType != nil {
			t.Errorf("hook %q has a ResultType exemplar but result category %q", hook, spec.Result)
		}
	}
}

// parseHookConstants reads the Hook* identifiers and their string values out
// of a source file's const declarations.
func parseHookConstants(t *testing.T, filename string) map[string]string {
	t.Helper()
	fset := token.NewFileSet()
	file, err := parser.ParseFile(fset, filename, nil, 0)
	if err != nil {
		t.Fatalf("parse %s: %v", filename, err)
	}

	out := map[string]string{}
	for _, decl := range file.Decls {
		gen, ok := decl.(*ast.GenDecl)
		if !ok || gen.Tok != token.CONST {
			continue
		}
		for _, spec := range gen.Specs {
			vs, ok := spec.(*ast.ValueSpec)
			if !ok || len(vs.Names) != 1 || len(vs.Values) != 1 {
				continue
			}
			name := vs.Names[0].Name
			if len(name) < 5 || name[:4] != "Hook" {
				continue
			}
			lit, ok := vs.Values[0].(*ast.BasicLit)
			if !ok || lit.Kind != token.STRING {
				continue
			}
			value, err := strconv.Unquote(lit.Value)
			if err != nil {
				t.Fatalf("unquote %s value %s: %v", name, lit.Value, err)
			}
			out[name] = value
		}
	}
	return out
}
