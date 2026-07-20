package main

import (
	"encoding/json"

	"github.com/dsswift/ion/engine/internal/utils"
)

// mustMarshalCLI renders a CLI result struct as indented JSON for printing to
// stdout. A marshal failure means the command produced nothing printable, which
// an operator debugging a broken CLI invocation wants surfaced rather than
// silently swallowed — so the error is logged at Warn and a JSON error object is
// returned in its place so the command still emits well-formed JSON on stdout.
func mustMarshalCLI(v interface{}) []byte {
	data, err := json.MarshalIndent(v, "", "  ")
	if err != nil {
		utils.LogWithFields(utils.LevelWarn, "cli", "CLI output marshal failed", map[string]any{
			"error": utils.ErrStr(err),
		})
		return []byte(`{"error":"failed to marshal CLI output"}`)
	}
	return data
}
