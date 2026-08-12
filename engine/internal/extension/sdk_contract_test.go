package extension

import (
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"strings"
	"testing"
)

var updateSDKContract = flag.Bool("update", false, "update golden testdata/sdk_contract.json")

// The SDK contract manifest describes the engine's *extension-facing* surface:
// hook names with their payload shapes and result categories, the ext/* RPC
// method set, the init-handshake result shape, and the wire constants a client
// SDK must hard-code to frame messages correctly.
//
// It is deliberately separate from internal/types/testdata/contracts.json.
// That golden covers wire types and has three consumers (desktop TS, iOS
// Swift, and the Go source of truth); folding the SDK surface into it would
// mean every hook addition churns a file two clients validate against for
// reasons that have nothing to do with them.
//
// Regenerate with:
//
//	cd engine && go test ./internal/extension/ -run TestSDKContractManifest -update
//
// Consumers: sdk/go/parity_test.go (Go SDK) and
// desktop/src/shared/__tests__/sdk-surface-sync.test.ts (TypeScript SDK).

// sdkContractManifest is the on-disk JSON shape.
type sdkContractManifest struct {
	// Hooks maps hook name to its payload/result contract.
	Hooks map[string]sdkHookContract `json:"hooks"`
	// ExtRequests is the sorted set of ext/* request methods the engine
	// answers. Anything else yields JSON-RPC -32601.
	ExtRequests []string `json:"extRequests"`
	// ExtNotifications is the sorted set of extension-initiated
	// notification methods the engine consumes.
	ExtNotifications []string `json:"extNotifications"`
	// InitResult is the field set the engine parses out of the init
	// handshake response.
	InitResult []string `json:"initResult"`
	// WireConstants are the framing values a client SDK must match exactly.
	WireConstants map[string]any `json:"wireConstants"`
	// ContextEnvelope is the complete `_ctx` object emitted with every hook
	// invocation. SDK runtimes decode it before their handlers run.
	ContextEnvelope sdkJSONSchema `json:"contextEnvelope"`
}

// sdkHookContract is one hook's machine-readable contract.
type sdkHookContract struct {
	// PayloadKind is "none", "string", or "object".
	PayloadKind string `json:"payloadKind"`
	// PayloadFields are the JSON field names of an object payload, sorted.
	// Empty for "none" and "string".
	PayloadFields []string `json:"payloadFields,omitempty"`
	// Result is the result category (see hookResultKind).
	Result string `json:"result"`
	// ResultFields are the JSON field names of a structured result, sorted.
	ResultFields []string `json:"resultFields,omitempty"`
}

// sdkJSONSchema records JSON value kinds recursively. The SDK contract needs
// kinds, not only names: decoding an object into a string rejects the entire
// _ctx envelope and loses every sibling field.
type sdkJSONSchema struct {
	Kind   string                   `json:"kind"`
	Fields map[string]sdkJSONSchema `json:"fields,omitempty"`
}

func schemaFromJSONValue(value any) (sdkJSONSchema, error) {
	switch value := value.(type) {
	case string:
		return sdkJSONSchema{Kind: "string"}, nil
	case bool:
		return sdkJSONSchema{Kind: "boolean"}, nil
	case float64, float32, int, int8, int16, int32, int64, uint, uint8, uint16, uint32, uint64:
		return sdkJSONSchema{Kind: "number"}, nil
	case map[string]interface{}:
		fields := make(map[string]sdkJSONSchema, len(value))
		for name, field := range value {
			schema, err := schemaFromJSONValue(field)
			if err != nil {
				return sdkJSONSchema{}, fmt.Errorf("field %q: %w", name, err)
			}
			fields[name] = schema
		}
		return sdkJSONSchema{Kind: "object", Fields: fields}, nil
	default:
		return sdkJSONSchema{}, fmt.Errorf("unsupported JSON value type %T", value)
	}
}

// contextEnvelopeSchema derives the public _ctx contract from the exact map
// Host.buildHookEnvelope sends, rather than keeping a second hand-written list.
func contextEnvelopeSchema() sdkJSONSchema {
	h := NewHost()
	envelope := h.buildHookEnvelope(&Context{
		Cwd:            "/workspace",
		SessionKey:     "session",
		ConversationID: "conversation",
		RunID:          "run",
		TraceID:        "4bf92f3577b34da6a3ce929d0e0e4736",
		Depth:          1,
		DispatchId:     "dispatch",
		Model:          &ModelRef{ID: "model", ContextWindow: 200000},
		Config: &ExtensionConfig{
			ExtensionDir:     "/extension",
			Model:            "model",
			WorkingDirectory: "/workspace",
			McpConfigPath:    "/workspace/mcp.json",
		},
	}, nil)
	ctx, ok := envelope["_ctx"].(map[string]interface{})
	if !ok {
		panic("buildHookEnvelope returned no _ctx object")
	}
	// The producer map holds Config as a Go struct until JSON-RPC marshals it.
	// Round-trip that exact subtree so the manifest describes wire JSON kinds,
	// not implementation-only Go dynamic types.
	encoded, err := json.Marshal(ctx)
	if err != nil {
		panic(fmt.Sprintf("marshal _ctx schema input: %v", err))
	}
	var wireCtx map[string]interface{}
	if err := json.Unmarshal(encoded, &wireCtx); err != nil {
		panic(fmt.Sprintf("decode _ctx schema input: %v", err))
	}
	schema, err := schemaFromJSONValue(wireCtx)
	if err != nil {
		panic(fmt.Sprintf("build _ctx schema: %v", err))
	}
	return schema
}

// sdkJSONFieldNames returns the sorted JSON field names for a struct type,
// skipping untagged fields and `json:"-"`.
func sdkJSONFieldNames(t reflect.Type) []string {
	for t.Kind() == reflect.Ptr {
		t = t.Elem()
	}
	if t.Kind() != reflect.Struct {
		return nil
	}
	var names []string
	for i := range t.NumField() {
		f := t.Field(i)
		tag := f.Tag.Get("json")
		if tag == "" || tag == "-" {
			continue
		}
		name := strings.Split(tag, ",")[0]
		if name == "" {
			continue
		}
		names = append(names, name)
	}
	sort.Strings(names)
	return names
}

// initResultFields is the field set parseInitResult (host_transpile.go) reads
// out of the init handshake response. Hand-declared because the struct is an
// anonymous local in that function; the guard below pins it to reality.
func initResultFields() []string {
	f := []string{"name", "tools", "commands", "webhooks", "schedules", "resources", "buildIdentity"}
	sort.Strings(f)
	return f
}

func buildSDKContractManifest() sdkContractManifest {
	m := sdkContractManifest{
		Hooks:           make(map[string]sdkHookContract),
		ContextEnvelope: contextEnvelopeSchema(),
		WireConstants: map[string]any{
			// Extension request IDs start here so an extension's own
			// outbound ids can never collide with the engine's, which
			// start at 1. A client SDK that starts at 1 will have its
			// responses routed to the wrong pending call.
			"extRequestIdBase": 100000,
			// A hook payload that is not a JSON object is wrapped under
			// this key, because the envelope merges the payload at the
			// top level alongside _ctx.
			"payloadWrapperKey": "_payload",
			// Per-invocation context metadata rides the hook envelope
			// under this key and must be stripped before the payload is
			// handed to a handler.
			"ctxKey": "_ctx",
		},
	}

	for hook, spec := range hookSpecs() {
		c := sdkHookContract{Result: string(spec.Result)}
		switch {
		case spec.Payload == nil:
			c.PayloadKind = "none"
		case reflect.TypeOf(spec.Payload).Kind() == reflect.String:
			c.PayloadKind = "string"
		default:
			c.PayloadKind = "object"
			c.PayloadFields = sdkJSONFieldNames(reflect.TypeOf(spec.Payload))
		}
		if spec.ResultType != nil {
			c.ResultFields = sdkJSONFieldNames(reflect.TypeOf(spec.ResultType))
		}
		m.Hooks[hook] = c
	}

	m.ExtRequests = ExtRequestMethods()
	sort.Strings(m.ExtRequests)
	m.ExtNotifications = ExtNotificationMethods()
	sort.Strings(m.ExtNotifications)
	m.InitResult = initResultFields()

	return m
}

// TestSDKContractManifest generates and verifies testdata/sdk_contract.json.
func TestSDKContractManifest(t *testing.T) {
	golden := filepath.Join("testdata", "sdk_contract.json")
	manifest := buildSDKContractManifest()

	data, err := json.MarshalIndent(manifest, "", "  ")
	if err != nil {
		t.Fatalf("marshal manifest: %v", err)
	}
	data = append(data, '\n')

	if *updateSDKContract {
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
		t.Fatalf("read golden file (run with -update to create): %v", err)
	}

	if string(data) != string(want) {
		t.Errorf("SDK contract manifest has drifted from %s\n"+
			"Run: cd engine && go test ./internal/extension/ -run TestSDKContractManifest -update\n"+
			"Then update the client SDKs: sdk/go (Go descriptors in hooks.go) and\n"+
			"engine/extensions/sdk/ion-sdk/types.ts (HookPayloadMap).",
			golden)
		t.Logf("got:\n%s", data)
	}
}

// TestInitResultFieldsMatchParser pins initResultFields() to the struct
// parseInitResult actually decodes. The struct is an anonymous local, so it
// cannot be reflected from here; this parses its JSON tags out of the source
// instead. Without it the manifest could advertise an init field the engine
// ignores, and every client SDK would faithfully send something into a void.
func TestInitResultFieldsMatchParser(t *testing.T) {
	src, err := os.ReadFile("host_transpile.go")
	if err != nil {
		t.Fatalf("read host_transpile.go: %v", err)
	}
	body := string(src)
	start := strings.Index(body, "func (h *Host) parseInitResult(")
	if start < 0 {
		t.Fatal("parseInitResult not found in host_transpile.go")
	}
	// The decoded struct is the first `var result struct {` in the function;
	// scan to its closing brace by tracking depth.
	declIdx := strings.Index(body[start:], "var result struct {")
	if declIdx < 0 {
		t.Fatal("init result struct declaration not found in parseInitResult")
	}
	from := start + declIdx
	depth := 0
	end := from
	for i := from; i < len(body); i++ {
		switch body[i] {
		case '{':
			depth++
		case '}':
			depth--
			if depth == 0 {
				end = i
				i = len(body)
			}
		}
	}
	decl := body[from:end]

	// Only top-level fields count: nested struct literals (the tool and
	// command shapes) describe sub-objects, not init-result keys. A field is
	// top level when its json tag sits at one tab of indentation inside the
	// declaration.
	var found []string
	for _, line := range strings.Split(decl, "\n") {
		if !strings.HasPrefix(line, "\t\t") || strings.HasPrefix(line, "\t\t\t") {
			continue
		}
		tagIdx := strings.Index(line, "`json:\"")
		if tagIdx < 0 {
			continue
		}
		rest := line[tagIdx+len("`json:\""):]
		name := strings.Split(strings.Split(rest, "\"")[0], ",")[0]
		if name == "" || name == "-" {
			continue
		}
		found = append(found, name)
	}
	sort.Strings(found)

	want := initResultFields()
	if strings.Join(found, ",") != strings.Join(want, ",") {
		t.Errorf("initResultFields() = %v, but parseInitResult decodes %v\n"+
			"Update initResultFields() in sdk_contract_test.go and regenerate the manifest.",
			want, found)
	}
}
