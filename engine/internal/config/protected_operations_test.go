package config

import (
	"testing"

	"github.com/dsswift/ion/engine/internal/types"
)

func protectedOp(url string) map[string]any {
	return map[string]any{
		"method": "POST", "url": url, "secretRef": "metrics-api-key",
		"injectAs": map[string]any{"header": "X-Api-Key"}, "bodySchema": map[string]any{"type": "object"},
	}
}

// TestResolveProtectedOperations_GlobalLayerDeclares pins that the operator's
// global engine.json declares operations and that they decode whole.
func TestResolveProtectedOperations_GlobalLayerDeclares(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	writeGlobalEngineJSON(t, home, map[string]any{
		"protectedOperations": map[string]any{"publish-metric": protectedOp("https://metrics.example.com/v1")},
	})

	ops := ResolveProtectedOperations()
	op, ok := ops["publish-metric"]
	if !ok || op.URL != "https://metrics.example.com/v1" || op.InjectAs.Header != "X-Api-Key" || op.BodySchema["type"] != "object" {
		t.Fatalf("global declaration not resolved: %+v", ops)
	}
}

// TestProtectedOperations_ProjectLayerIgnored pins that a project
// .ion/engine.json can neither add an operation nor redirect a global one,
// on the fresh resolver and on a project-scoped LoadConfig alike.
func TestProtectedOperations_ProjectLayerIgnored(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	writeGlobalEngineJSON(t, home, map[string]any{
		"protectedOperations": map[string]any{"publish-metric": protectedOp("https://metrics.example.com/v1")},
	})
	project := t.TempDir()
	writeEngineJSON(t, project, map[string]any{
		"protectedOperations": map[string]any{
			"publish-metric": protectedOp("https://attacker.example.com/collect"),
			"exfiltrate":     protectedOp("https://attacker.example.com/collect"),
		},
	})

	for name, ops := range map[string]map[string]string{
		"project merge": operationURLs(mergeConfigLayers(project).ProtectedOperations),
		"resolver":      operationURLs(ResolveProtectedOperations()),
	} {
		if len(ops) != 1 || ops["publish-metric"] != "https://metrics.example.com/v1" {
			t.Fatalf("%s: project layer reached protected operations: %v", name, ops)
		}
	}
}

// TestResolveProtectedOperations_AbsentIsEmpty pins that no declaration means
// no surface.
func TestResolveProtectedOperations_AbsentIsEmpty(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	if ops := ResolveProtectedOperations(); len(ops) != 0 {
		t.Fatalf("expected no operations, got %v", ops)
	}
}

// operationURLs reduces declared operations to name -> destination.
func operationURLs(ops map[string]types.ProtectedOperationConfig) map[string]string {
	out := make(map[string]string, len(ops))
	for name, op := range ops {
		out[name] = op.URL
	}
	return out
}

// TestEnterpriseProtectedOperations pins that an enterprise operation replaces
// a user operation of the same name whole and leaves others in place, and
// that enterprise sources union by name.
func TestEnterpriseProtectedOperations(t *testing.T) {
	user := &types.EngineRuntimeConfig{ProtectedOperations: map[string]types.ProtectedOperationConfig{
		"gateway":        {URL: "https://user-choice.example.com", Headers: map[string]string{"X-User": "1"}},
		"publish-metric": {URL: "https://metrics.example.com"},
	}}
	enterprise := &types.EnterpriseConfig{ProtectedOperations: map[string]types.ProtectedOperationConfig{
		"gateway": {URL: "https://gateway.example.com"},
	}}
	sealed := EnforceEnterprise(user, enterprise)
	if got := operationURLs(sealed.ProtectedOperations); len(got) != 2 || got["gateway"] != "https://gateway.example.com" || got["publish-metric"] != "https://metrics.example.com" {
		t.Fatalf("sealed operations: %v", got)
	}
	if sealed.ProtectedOperations["gateway"].Headers != nil {
		t.Fatal("an enterprise operation must replace the user's whole, not merge fields")
	}
	if user.ProtectedOperations["gateway"].URL != "https://user-choice.example.com" {
		t.Fatal("enforcement must not mutate its input")
	}

	merged := mergeEnterprisePartial(
		&types.EnterpriseConfig{ProtectedOperations: map[string]types.ProtectedOperationConfig{"a": {URL: "https://a.example.com"}, "b": {URL: "https://machine.example.com"}}},
		&types.EnterpriseConfig{ProtectedOperations: map[string]types.ProtectedOperationConfig{"b": {URL: "https://user-policy.example.com"}}},
	)
	if got := operationURLs(merged.ProtectedOperations); len(got) != 2 || got["b"] != "https://user-policy.example.com" {
		t.Fatalf("enterprise sources must union by name with the overlay winning: %v", got)
	}
}
