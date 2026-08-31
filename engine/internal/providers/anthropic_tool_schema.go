package providers

// anthropicToolInputSchema preserves a generic JSON Schema while moving root
// union combinators below the input_schema root. Anthropic rejects oneOf,
// allOf, and anyOf only when one is a direct input_schema keyword.
//
// Existing if/then/else keywords move with the combinators because the wrapper
// needs those root keyword slots. All other root constraints stay in place, so
// local $defs references still resolve against the same document root.
func anthropicToolInputSchema(schema map[string]any) (map[string]any, bool) {
	if !hasAnthropicUnsupportedRootKeyword(schema) {
		return schema, false
	}

	adapted := make(map[string]any, len(schema)+2)
	nested := make(map[string]any, 6)
	for key, value := range schema {
		switch key {
		case "oneOf", "allOf", "anyOf", "if", "then", "else":
			nested[key] = value
		default:
			adapted[key] = value
		}
	}

	// Tool calls always carry an object. A schema made only from union branches
	// can omit the root type, but Anthropic requires the input root to be an
	// object even after the incompatible keywords move below it.
	if _, ok := adapted["type"]; !ok {
		adapted["type"] = "object"
	}
	adapted["if"] = map[string]any{}
	adapted["then"] = nested
	return adapted, true
}

func hasAnthropicUnsupportedRootKeyword(schema map[string]any) bool {
	for _, keyword := range []string{"oneOf", "allOf", "anyOf"} {
		if _, ok := schema[keyword]; ok {
			return true
		}
	}
	return false
}
