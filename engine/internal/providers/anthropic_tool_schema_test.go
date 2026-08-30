package providers

import (
	"encoding/json"
	"reflect"
	"testing"

	"github.com/google/jsonschema-go/jsonschema"

	"github.com/dsswift/ion/engine/internal/types"
)

func TestAnthropicToolInputSchemaLeavesCompatibleRootUnchanged(t *testing.T) {
	schema := map[string]any{
		"type":       "object",
		"properties": map[string]any{"name": map[string]any{"type": "string"}},
	}

	got, adapted := anthropicToolInputSchema(schema)
	if adapted {
		t.Fatal("compatible schema reported as adapted")
	}
	if !reflect.DeepEqual(got, schema) {
		t.Fatalf("schema changed: got %#v, want %#v", got, schema)
	}
}

func TestAnthropicToolInputSchemaMovesRootCombinatorsBelowRoot(t *testing.T) {
	schema := map[string]any{
		"type":       "object",
		"required":   []any{"kind"},
		"properties": map[string]any{"kind": map[string]any{"type": "string"}},
		"allOf": []any{
			map[string]any{
				"if":   map[string]any{"properties": map[string]any{"kind": map[string]any{"const": "currency"}}},
				"then": map[string]any{"required": []any{"currency"}},
			},
		},
	}

	got, adapted := anthropicToolInputSchema(schema)
	if !adapted {
		t.Fatal("incompatible schema was not adapted")
	}
	for _, keyword := range []string{"oneOf", "allOf", "anyOf"} {
		if _, ok := got[keyword]; ok {
			t.Fatalf("root still contains %q: %#v", keyword, got)
		}
	}
	if _, ok := got["then"].(map[string]any)["allOf"]; !ok {
		t.Fatalf("allOf was not preserved below the root: %#v", got)
	}
}

func TestAnthropicToolInputSchemaPreservesExistingConditionals(t *testing.T) {
	schema := map[string]any{
		"type":  "object",
		"if":    map[string]any{"required": []any{"mode"}},
		"then":  map[string]any{"required": []any{"enabled"}},
		"else":  map[string]any{"required": []any{"disabled"}},
		"anyOf": []any{map[string]any{"required": []any{"name"}}},
	}

	adapted, _ := anthropicToolInputSchema(schema)
	nested := adapted["then"].(map[string]any)
	for _, keyword := range []string{"if", "then", "else", "anyOf"} {
		if _, ok := nested[keyword]; !ok {
			t.Fatalf("nested schema lost %q: %#v", keyword, adapted)
		}
	}
}

func TestAnthropicToolInputSchemaDoesNotMutateOriginal(t *testing.T) {
	schema := map[string]any{
		"type":  "object",
		"allOf": []any{map[string]any{"required": []any{"value"}}},
	}
	before, err := json.Marshal(schema)
	if err != nil {
		t.Fatal(err)
	}

	_, _ = anthropicToolInputSchema(schema)
	after, err := json.Marshal(schema)
	if err != nil {
		t.Fatal(err)
	}
	if string(after) != string(before) {
		t.Fatalf("source schema mutated: before=%s after=%s", before, after)
	}
}

func TestAnthropicToolInputSchemaPreservesValidation(t *testing.T) {
	schema := map[string]any{
		"type": "object",
		"oneOf": []any{
			map[string]any{
				"required":   []any{"name"},
				"properties": map[string]any{"name": map[string]any{"type": "string"}},
			},
			map[string]any{
				"required":   []any{"count"},
				"properties": map[string]any{"count": map[string]any{"type": "number"}},
			},
		},
	}
	adapted, _ := anthropicToolInputSchema(schema)

	originalValidator := compileToolInputValidator(t, schema)
	adaptedValidator := compileToolInputValidator(t, adapted)
	cases := []map[string]any{
		{"name": "ok"},
		{"count": 2.0},
		{"name": "both", "count": 2.0},
		{},
	}
	for _, input := range cases {
		originalValid := originalValidator(input) == nil
		adaptedValid := adaptedValidator(input) == nil
		if originalValid != adaptedValid {
			t.Fatalf("validation changed for %#v: original=%v adapted=%v", input, originalValid, adaptedValid)
		}
	}
}

func TestAnthropicBuildRequestBodyUsesCompatibleToolSchema(t *testing.T) {
	p := &anthropicProvider{}
	body := p.buildRequestBody(types.LlmStreamOptions{
		Model: "unknown-test-model",
		Tools: []types.LlmToolDef{{
			Name:        "ConditionalTool",
			InputSchema: map[string]any{"type": "object", "allOf": []any{map[string]any{"required": []any{"value"}}}},
		}},
	})

	tools := body["tools"].([]map[string]any)
	inputSchema := tools[0]["input_schema"].(map[string]any)
	if _, ok := inputSchema["allOf"]; ok {
		t.Fatalf("Anthropic request contains root allOf: %#v", inputSchema)
	}
	if _, ok := inputSchema["then"].(map[string]any)["allOf"]; !ok {
		t.Fatalf("Anthropic request lost allOf: %#v", inputSchema)
	}
}

func compileToolInputValidator(t *testing.T, schemaMap map[string]any) func(map[string]any) error {
	t.Helper()
	schema := new(jsonschema.Schema)
	data, err := json.Marshal(schemaMap)
	if err != nil {
		t.Fatal(err)
	}
	if err := schema.UnmarshalJSON(data); err != nil {
		t.Fatal(err)
	}
	resolved, err := schema.Resolve(nil)
	if err != nil {
		t.Fatal(err)
	}
	return func(input map[string]any) error { return resolved.Validate(input) }
}
