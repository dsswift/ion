package ion

import (
	"encoding/json"
	"flag"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"testing"
)

// surface_test.go — the Go SDK's public surface, as a golden.
//
// The engine's manifest covers hooks and RPC methods. It does not and cannot
// cover the *shape a client SDK gives them*: whether a capability is a method
// on Context, whether it is grouped under a namespace, what it is called. Two
// SDKs can both implement ext/get_plan_mode and still diverge, one exposing
// ctx.GetPlanMode and the other ctx.PlanMode().Get().
//
// This golden is the canonical cross-SDK surface. The TypeScript side reads it
// (desktop/src/shared/__tests__/sdk-surface-sync.test.ts) and asserts its own
// IonContext and IonSDK members match, camelCase-normalised. That is what makes
// "a context method added to one SDK but absent from the other" a test failure
// rather than a code-review catch.
//
// Regenerate after changing the public surface:
//
//	cd sdk/go && go test -run TestGoSDKSurfaceManifest -update

var updateSurface = flag.Bool("update", false, "update golden testdata/sdk_surface.json")

// surfaceManifest is the on-disk shape.
type surfaceManifest struct {
	// Context is the exported method set on *Context.
	Context []string `json:"context"`
	// ContextFields is the exported field set on Context — session identity
	// a handler reads directly rather than through a call.
	ContextFields []string `json:"contextFields"`
	// SDK is the exported method set on *SDK.
	SDK []string `json:"sdk"`
	// Namespaces maps each namespace type to its exported methods. These are
	// the surfaces reached through a Context or SDK accessor.
	Namespaces map[string][]string `json:"namespaces"`
	// Hooks is every hook name this SDK models, sorted.
	Hooks []string `json:"hooks"`
	// DispatchTypes maps each dispatch request/result struct to the JSON field
	// names it puts on the wire, sorted.
	//
	// Method-level parity is not enough for dispatch. Both SDKs expose
	// DispatchAgent, so the method check passes while one side silently lacks
	// a field the other sends — and a dispatch option that never reaches the
	// engine fails open: the child simply runs without the declared behavior,
	// with no error anywhere. RequireToolUse is exactly that shape (an absent
	// field means "no expectation declared"), so its loss on one SDK would be
	// invisible until an agent answered a task instead of doing it.
	//
	// Only serialised fields appear here. Callback fields are `json:"-"`
	// because they are local function values, never wire members.
	DispatchTypes map[string][]string `json:"dispatchTypes"`
}

func buildSurfaceManifest() surfaceManifest {
	m := surfaceManifest{Namespaces: map[string][]string{}}

	m.Context = exportedMethods(reflect.TypeOf(&Context{}))
	m.ContextFields = exportedFields(reflect.TypeOf(Context{}))
	m.SDK = exportedMethods(reflect.TypeOf(&SDK{}))

	// The namespaces a handler reaches through an accessor. Named explicitly
	// rather than discovered, so adding one is a deliberate act that shows up
	// in the golden diff.
	namespaces := map[string]reflect.Type{
		"HTTPAPI":         reflect.TypeOf(&HTTPAPI{}),
		"SessionsAPI":     reflect.TypeOf(&SessionsAPI{}),
		"WebhooksAPI":     reflect.TypeOf(&WebhooksAPI{}),
		"ScheduleAPI":     reflect.TypeOf(&ScheduleAPI{}),
		"ResourcesAPI":    reflect.TypeOf(&ResourcesAPI{}),
		"Logger":          reflect.TypeOf(&Logger{}),
		"WebhookHandle":   reflect.TypeOf(WebhookHandle{}),
		"ScheduleHandle":  reflect.TypeOf(ScheduleHandle{}),
		"ScheduleControl": reflect.TypeOf(ScheduleControl{}),
		"ResourceHandle":  reflect.TypeOf(ResourceHandle{}),
	}
	for name, rt := range namespaces {
		m.Namespaces[name] = exportedMethods(rt)
	}

	for _, d := range allHookDescriptors() {
		m.Hooks = append(m.Hooks, d.Name)
	}
	sort.Strings(m.Hooks)

	// The dispatch wire shapes both SDKs must agree on. Named explicitly, like
	// the namespaces above, so adding one is a deliberate act visible in the
	// golden diff.
	m.DispatchTypes = map[string][]string{
		"DispatchAgentOpts":   jsonFieldNamesOf(reflect.TypeOf(DispatchAgentOpts{})),
		"DispatchAgentResult": jsonFieldNamesOf(reflect.TypeOf(DispatchAgentResult{})),
		"ContextPolicy":       jsonFieldNamesOf(reflect.TypeOf(ContextPolicy{})),
		"SendPromptOpts":      jsonFieldNamesOf(reflect.TypeOf(SendPromptOpts{})),
	}

	return m
}

// exportedMethods returns a type's exported method names, sorted.
func exportedMethods(rt reflect.Type) []string {
	var names []string
	for i := range rt.NumMethod() {
		names = append(names, rt.Method(i).Name)
	}
	sort.Strings(names)
	return names
}

// exportedFields returns a struct's exported field names, sorted.
func exportedFields(rt reflect.Type) []string {
	var names []string
	for i := range rt.NumField() {
		f := rt.Field(i)
		if f.PkgPath != "" {
			continue // unexported
		}
		names = append(names, f.Name)
	}
	sort.Strings(names)
	return names
}

// TestGoSDKSurfaceManifest generates and verifies testdata/sdk_surface.json.
func TestGoSDKSurfaceManifest(t *testing.T) {
	golden := filepath.Join("testdata", "sdk_surface.json")
	manifest := buildSurfaceManifest()

	data, err := json.MarshalIndent(manifest, "", "  ")
	if err != nil {
		t.Fatalf("marshal surface manifest: %v", err)
	}
	data = append(data, '\n')

	if *updateSurface {
		if err := os.MkdirAll("testdata", 0o755); err != nil {
			t.Fatalf("mkdir testdata: %v", err)
		}
		if err := os.WriteFile(golden, data, 0o644); err != nil {
			t.Fatalf("write golden: %v", err)
		}
		t.Logf("updated %s", golden)
		return
	}

	want, err := os.ReadFile(golden)
	if err != nil {
		t.Fatalf("read golden (run with -update to create): %v", err)
	}

	if string(data) != string(want) {
		t.Errorf("Go SDK surface has drifted from %s\n"+
			"Run: cd sdk/go && go test -run TestGoSDKSurfaceManifest -update\n"+
			"Then check whether the TypeScript SDK needs the same member "+
			"(desktop/src/shared/__tests__/sdk-surface-sync.test.ts reads this file).",
			golden)
		t.Logf("got:\n%s", data)
	}
}

// TestDispatchWorkContractFieldsSurvive pins the three dispatch fields whose
// loss fails OPEN rather than loud.
//
// The golden above catches drift, but a golden is regenerated by the same
// command that would record a removal, so it accepts a deletion as readily as
// an addition. These three cannot afford that:
//
//   - requireToolUse absent means "no expectation declared", so dropping it
//     silently stops the engine gating a dispatch the caller asked it to gate.
//   - toolCount absent decodes as 0, which is the exact value that means "this
//     child did no work" — a missing field and a promising child are
//     indistinguishable to a consumer.
//   - maxContextBytes absent means "no cap", so dropping it silently restores
//     the unbounded per-dispatch context injection the cap exists to bound.
func TestDispatchWorkContractFieldsSurvive(t *testing.T) {
	manifest := buildSurfaceManifest()

	required := map[string]string{
		"DispatchAgentOpts":   "requireToolUse",
		"DispatchAgentResult": "toolCount",
		"ContextPolicy":       "maxContextBytes",
	}
	for typeName, field := range required {
		fields, ok := manifest.DispatchTypes[typeName]
		if !ok {
			t.Errorf("dispatch type %q is missing from the surface manifest", typeName)
			continue
		}
		found := false
		for _, name := range fields {
			if name == field {
				found = true
				break
			}
		}
		if !found {
			t.Errorf("%s no longer serialises %q; its absence is indistinguishable "+
				"from the default, so the behavior would be lost silently: %v",
				typeName, field, fields)
		}
	}
}

// TestSurfaceCoversEveryClaimedMethod pins that each ext/* method the SDK
// claims is reachable from the public surface. A method issued only by
// unexported code would satisfy the engine-parity test while being useless to
// an extension author.
func TestSurfaceCoversEveryClaimedMethod(t *testing.T) {
	manifest := buildSurfaceManifest()

	// Everything callable, flattened.
	reachable := map[string]bool{}
	for _, name := range manifest.Context {
		reachable[name] = true
	}
	for _, name := range manifest.SDK {
		reachable[name] = true
	}
	for _, methods := range manifest.Namespaces {
		for _, name := range methods {
			reachable[name] = true
		}
	}

	// Each claimed method names its Go symbol as "Type.Method" or a
	// slash-separated list of them. Check the method half is public surface.
	for method, symbol := range sdkClaimedMethods() {
		for _, part := range splitSymbols(symbol) {
			name := methodNameOf(part)
			if name == "" {
				continue // a prose description, not a symbol
			}
			if !reachable[name] {
				t.Errorf("ext method %q claims %q, but %q is not on the public surface",
					method, symbol, name)
			}
		}
	}
}

// splitSymbols breaks "A.B / C.D" into its parts.
func splitSymbols(s string) []string {
	var out []string
	cur := ""
	for _, r := range s {
		if r == '/' {
			out = append(out, trimSpace(cur))
			cur = ""
			continue
		}
		cur += string(r)
	}
	out = append(out, trimSpace(cur))
	return out
}

// methodNameOf pulls "Method" out of "Type.Method". Returns "" for anything
// that is not in that form, which is how the prose entries are skipped.
func methodNameOf(symbol string) string {
	// Anything with a space is prose, e.g. "Context.Emit (post-hook path)".
	base := symbol
	for i, r := range symbol {
		if r == ' ' {
			base = symbol[:i]
			break
		}
	}
	dot := -1
	for i, r := range base {
		if r == '.' {
			dot = i
		}
	}
	if dot < 0 || dot == len(base)-1 {
		return ""
	}
	return base[dot+1:]
}

func trimSpace(s string) string {
	start, end := 0, len(s)
	for start < end && (s[start] == ' ' || s[start] == '\t') {
		start++
	}
	for end > start && (s[end-1] == ' ' || s[end-1] == '\t') {
		end--
	}
	return s[start:end]
}
