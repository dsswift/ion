package tools

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/dsswift/ion/engine/internal/types"
)

// A file-writing tool streams its arguments in the order the model emits them,
// and a consumer cannot name the target until the path key arrives. When the
// content value precedes it, the row stays anonymous for the whole write — the
// operator watches a long file-write with no indication of which file it hits.
// Ordering is a model behavior the engine cannot force, so the schema states the
// requirement explicitly rather than relying on Go's alphabetical map ordering.
func TestFileToolSchemasRequestPathBeforeContent(t *testing.T) {
	cases := []struct {
		def       func() *types.ToolDef
		pathKey   string
		bodyKey   string
		toolLabel string
	}{
		{WriteTool, "file_path", "content", "Write"},
		{EditTool, "file_path", "new_string", "Edit"},
		{NotebookTool, "path", "content", "NotebookEdit"},
	}

	for _, tc := range cases {
		def := tc.def()
		props, ok := def.InputSchema["properties"].(map[string]any)
		if !ok {
			t.Fatalf("%s: schema has no properties map", tc.toolLabel)
		}

		pathProp, ok := props[tc.pathKey].(map[string]any)
		if !ok {
			t.Fatalf("%s: missing %q property", tc.toolLabel, tc.pathKey)
		}
		pathDesc, _ := pathProp["description"].(string)
		if !strings.Contains(strings.ToLower(pathDesc), "emit this argument") {
			t.Errorf("%s: %q description must state its emission order, got %q",
				tc.toolLabel, tc.pathKey, pathDesc)
		}

		bodyProp, ok := props[tc.bodyKey].(map[string]any)
		if !ok {
			t.Fatalf("%s: missing %q property", tc.toolLabel, tc.bodyKey)
		}
		bodyDesc, _ := bodyProp["description"].(string)
		if tc.bodyKey == "content" && !strings.Contains(strings.ToLower(bodyDesc), "last") {
			t.Errorf("%s: %q description must mark it as emitted last, got %q",
				tc.toolLabel, tc.bodyKey, bodyDesc)
		}

		if !strings.Contains(def.Description, tc.pathKey) {
			t.Errorf("%s: tool description must name %q so the ordering requirement survives schema serialization",
				tc.toolLabel, tc.pathKey)
		}

		// The schema must still serialize as valid JSON for every provider.
		if _, err := json.Marshal(def.InputSchema); err != nil {
			t.Fatalf("%s: schema does not serialize: %v", tc.toolLabel, err)
		}
	}
}
