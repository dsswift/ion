package subscription

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

// TestPublishedSchemaExamplesDecode keeps the published v1 schema and the
// engine's decoder in agreement: every example the schema publishes must
// decode, and the fields the schema requires must be the ones the decoder
// requires.
func TestPublishedSchemaExamplesDecode(t *testing.T) {
	raw, err := os.ReadFile(filepath.Join("..", "..", "..", "docs", "configuration", "schemas", "subscription-lookup-v1.response.schema.json"))
	if err != nil {
		t.Fatalf("read published schema: %v", err)
	}
	var schema struct {
		Items struct {
			Required []string `json:"required"`
		} `json:"items"`
		Examples []json.RawMessage `json:"examples"`
	}
	if err := json.Unmarshal(raw, &schema); err != nil {
		t.Fatalf("parse published schema: %v", err)
	}
	if len(schema.Examples) == 0 {
		t.Fatal("published schema has no examples")
	}
	for i, example := range schema.Examples {
		if _, err := DecodeResponse(example); err != nil {
			t.Errorf("example %d does not decode: %v", i, err)
		}
	}
	required := map[string]bool{}
	for _, field := range schema.Items.Required {
		required[field] = true
	}
	for _, field := range []string{"id", "label", "key"} {
		if !required[field] {
			t.Errorf("schema does not require %q, but the decoder does", field)
		}
		body, err := json.Marshal([]map[string]string{withoutField(field)})
		if err != nil {
			t.Fatal(err)
		}
		if _, err := DecodeResponse(body); err == nil {
			t.Errorf("decoder accepted an entry without %q", field)
		}
	}
	if len(required) != 3 {
		t.Errorf("schema requires %v; the decoder requires exactly id, label, key", schema.Items.Required)
	}
}

func withoutField(field string) map[string]string {
	entry := map[string]string{"id": "a", "label": "A", "key": "k"}
	delete(entry, field)
	return entry
}
