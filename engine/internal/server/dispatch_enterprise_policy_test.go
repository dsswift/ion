package server

// dispatch_enterprise_policy_test.go — end-to-end tests for the
// get_enterprise_policy command handler. Each test drives the full
// JSON-decode → dispatch → ServerResult path against actual wire input,
// pinning the handler's contractual behaviors:
//
//   1. When the engine has an enterprise NewConversationDefaults policy, the RPC
//      returns it under data.newConversationDefaults with baseDirectory /
//      engineProfileId / locked intact.
//   2. When no enterprise config (or no NewConversationDefaults section) is present,
//      data.newConversationDefaults is null — NOT absent, NOT an error.
//   3. D-004 full-blob passthrough: data.policy carries the complete
//      EnterpriseConfig (allowedModels, toolRestrictions, resourceLimits,
//      conversationRetentionDays, opaque customFields, ...) when enterprise
//      config is loaded, and null otherwise.
//
// This is the contract desktop and iOS rely on to decide whether the
// new-conversation flow is enterprise-locked and to apply every other
// client-side enterprise constraint.

import (
	"encoding/json"
	"testing"
	"time"

	"github.com/dsswift/ion/engine/internal/types"
)

// enterprisePolicyResult decodes the ServerResult.Data of a
// get_enterprise_policy response into its { newConversationDefaults } shape.
// hasField reports whether the "newConversationDefaults" key was present at all
// (so we can distinguish a null value from an omitted one).
func enterprisePolicyResult(t *testing.T, lines []string) (policy *types.NewConversationDefaultsPolicy, hasField bool, ok bool) {
	t.Helper()
	result := findResult(t, lines)
	if result == nil {
		t.Fatalf("no result received; lines=%v", lines)
	}
	// Re-marshal Data to inspect the newConversationDefaults key explicitly.
	raw, err := json.Marshal(result.Data)
	if err != nil {
		t.Fatalf("marshal result.Data: %v", err)
	}
	var probe map[string]json.RawMessage
	if err := json.Unmarshal(raw, &probe); err != nil {
		t.Fatalf("unmarshal result.Data into map: %v", err)
	}
	rawPolicy, present := probe["newConversationDefaults"]
	if !present {
		return nil, false, result.OK
	}
	if string(rawPolicy) == "null" {
		return nil, true, result.OK
	}
	var p types.NewConversationDefaultsPolicy
	if err := json.Unmarshal(rawPolicy, &p); err != nil {
		t.Fatalf("unmarshal newConversationDefaults: %v", err)
	}
	return &p, true, result.OK
}

// TestGetEnterprisePolicy_Present verifies that a configured NewConversationDefaults
// policy is returned verbatim under data.newConversationDefaults.
func TestGetEnterprisePolicy_Present(t *testing.T) {
	mb := newMockBackend()
	srv := newShortPathTestServer(t, mb)

	// Inject an enterprise config carrying a locked new-conversation policy.
	srv.SetConfig(&types.EngineRuntimeConfig{
		Enterprise: &types.EnterpriseConfig{
			NewConversationDefaults: &types.NewConversationDefaultsPolicy{
				BaseDirectory:   "/corp/projects",
				EngineProfileId: "profile-corp",
				Locked:          true,
			},
		},
	})

	conn := dialServer(t, srv)
	t.Cleanup(func() { conn.Close() })

	sendJSON(t, conn, map[string]interface{}{
		"cmd":       "get_enterprise_policy",
		"requestId": "req-ent-present",
	})

	lines := readLines(t, conn, 3, 2*time.Second)
	policy, hasField, ok := enterprisePolicyResult(t, lines)
	if !ok {
		t.Fatalf("expected ok=true, got ok=false")
	}
	if !hasField {
		t.Fatalf("response data must contain newConversationDefaults key")
	}
	if policy == nil {
		t.Fatalf("newConversationDefaults must be the configured policy, got null")
	}
	if policy.BaseDirectory != "/corp/projects" {
		t.Errorf("BaseDirectory: got %q, want %q", policy.BaseDirectory, "/corp/projects")
	}
	if policy.EngineProfileId != "profile-corp" {
		t.Errorf("EngineProfileId: got %q, want %q", policy.EngineProfileId, "profile-corp")
	}
	if !policy.Locked {
		t.Errorf("Locked: got false, want true")
	}
}

// TestGetEnterprisePolicy_NoConfig verifies that when the server has no
// engine config at all, data.newConversationDefaults is present and null (the
// "no enterprise policy" signal), and the result is still ok=true.
func TestGetEnterprisePolicy_NoConfig(t *testing.T) {
	mb := newMockBackend()
	srv := newShortPathTestServer(t, mb)
	// Deliberately do NOT call SetConfig: s.config stays nil.

	conn := dialServer(t, srv)
	t.Cleanup(func() { conn.Close() })

	sendJSON(t, conn, map[string]interface{}{
		"cmd":       "get_enterprise_policy",
		"requestId": "req-ent-none",
	})

	lines := readLines(t, conn, 3, 2*time.Second)
	policy, hasField, ok := enterprisePolicyResult(t, lines)
	if !ok {
		t.Fatalf("expected ok=true even with no config, got ok=false")
	}
	if !hasField {
		t.Fatalf("response data must contain the newConversationDefaults key (as null), not omit it")
	}
	if policy != nil {
		t.Errorf("newConversationDefaults must be null when no config is loaded, got %+v", policy)
	}
}

// TestGetEnterprisePolicy_ConfigWithoutSection verifies that an enterprise
// config that has no NewConversationDefaults section still yields a null policy
// (not an error, not a zero-value struct).
func TestGetEnterprisePolicy_ConfigWithoutSection(t *testing.T) {
	mb := newMockBackend()
	srv := newShortPathTestServer(t, mb)

	// Enterprise config present, but NewConversationDefaults intentionally nil.
	srv.SetConfig(&types.EngineRuntimeConfig{
		Enterprise: &types.EnterpriseConfig{},
	})

	conn := dialServer(t, srv)
	t.Cleanup(func() { conn.Close() })

	sendJSON(t, conn, map[string]interface{}{
		"cmd":       "get_enterprise_policy",
		"requestId": "req-ent-empty",
	})

	lines := readLines(t, conn, 3, 2*time.Second)
	policy, hasField, ok := enterprisePolicyResult(t, lines)
	if !ok {
		t.Fatalf("expected ok=true, got ok=false")
	}
	if !hasField {
		t.Fatalf("response data must contain the newConversationDefaults key (as null)")
	}
	if policy != nil {
		t.Errorf("newConversationDefaults must be null when the section is absent, got %+v", policy)
	}
}

// fullPolicyResult decodes the ServerResult.Data of a get_enterprise_policy
// response and returns the raw "policy" key (the D-004 full-blob passthrough)
// alongside whether the key was present.
func fullPolicyResult(t *testing.T, lines []string) (policy json.RawMessage, hasField bool, ok bool) {
	t.Helper()
	result := findResult(t, lines)
	if result == nil {
		t.Fatalf("no result received; lines=%v", lines)
	}
	raw, err := json.Marshal(result.Data)
	if err != nil {
		t.Fatalf("marshal result.Data: %v", err)
	}
	var probe map[string]json.RawMessage
	if err := json.Unmarshal(raw, &probe); err != nil {
		t.Fatalf("unmarshal result.Data into map: %v", err)
	}
	rawPolicy, present := probe["policy"]
	return rawPolicy, present, result.OK
}

// TestGetEnterprisePolicy_FullBlobPassthrough pins the D-004 contract: the
// response's "policy" key carries the complete EnterpriseConfig, including
// allowedModels, toolRestrictions, resourceLimits, conversationRetentionDays,
// and — critically — the opaque customFields map the engine does not
// interpret (client config rides it by convention, e.g.
// customFields["ion-desktop"]).
func TestGetEnterprisePolicy_FullBlobPassthrough(t *testing.T) {
	mb := newMockBackend()
	srv := newShortPathTestServer(t, mb)

	retention := 90
	maxSessions := 3
	srv.SetConfig(&types.EngineRuntimeConfig{
		Enterprise: &types.EnterpriseConfig{
			AllowedModels: []string{"claude-sonnet-4-6", "gpt-4o"},
			ToolRestrictions: &types.ToolRestrictions{
				Allow: []string{"Read", "Grep"},
			},
			ResourceLimits:            &types.ResourceLimits{MaxSessions: &maxSessions},
			ConversationRetentionDays: &retention,
			CustomFields: map[string]any{
				"ion-desktop": map[string]any{
					"disableAutoUpdate": true,
					"mode":              "operator",
				},
			},
			NewConversationDefaults: &types.NewConversationDefaultsPolicy{
				EngineProfileId: "corp-profile",
				Locked:          true,
			},
		},
	})

	conn := dialServer(t, srv)
	t.Cleanup(func() { conn.Close() })

	sendJSON(t, conn, map[string]interface{}{
		"cmd":       "get_enterprise_policy",
		"requestId": "req-ent-blob",
	})

	lines := readLines(t, conn, 3, 2*time.Second)
	rawPolicy, hasField, ok := fullPolicyResult(t, lines)
	if !ok {
		t.Fatalf("expected ok=true, got ok=false")
	}
	if !hasField {
		t.Fatalf("response data must contain the policy key (D-004 full-blob passthrough)")
	}
	if string(rawPolicy) == "null" {
		t.Fatalf("policy must be the full enterprise config, got null")
	}

	var decoded types.EnterpriseConfig
	if err := json.Unmarshal(rawPolicy, &decoded); err != nil {
		t.Fatalf("policy blob must decode as EnterpriseConfig: %v", err)
	}
	if len(decoded.AllowedModels) != 2 || decoded.AllowedModels[0] != "claude-sonnet-4-6" {
		t.Errorf("allowedModels not carried: %v", decoded.AllowedModels)
	}
	if decoded.ToolRestrictions == nil || len(decoded.ToolRestrictions.Allow) != 2 {
		t.Errorf("toolRestrictions not carried: %+v", decoded.ToolRestrictions)
	}
	if decoded.ResourceLimits == nil || decoded.ResourceLimits.MaxSessions == nil || *decoded.ResourceLimits.MaxSessions != 3 {
		t.Errorf("resourceLimits not carried: %+v", decoded.ResourceLimits)
	}
	if decoded.ConversationRetentionDays == nil || *decoded.ConversationRetentionDays != 90 {
		t.Errorf("conversationRetentionDays not carried: %v", decoded.ConversationRetentionDays)
	}
	ionDesktop, isMap := decoded.CustomFields["ion-desktop"].(map[string]any)
	if !isMap {
		t.Fatalf("customFields[\"ion-desktop\"] must survive the passthrough opaquely, got %T", decoded.CustomFields["ion-desktop"])
	}
	if ionDesktop["disableAutoUpdate"] != true {
		t.Errorf("customFields values not carried verbatim: %v", ionDesktop)
	}

	// Backward compat: the original top-level newConversationDefaults key
	// must still be present and populated alongside the new policy blob.
	policy, hasNcd, _ := enterprisePolicyResult(t, lines)
	if !hasNcd || policy == nil || policy.EngineProfileId != "corp-profile" {
		t.Errorf("top-level newConversationDefaults must remain populated for existing consumers, got %+v (present=%v)", policy, hasNcd)
	}
}

// TestGetEnterprisePolicy_FullBlobNullWhenNoConfig pins the no-enterprise
// case for the D-004 blob: the policy key is present and null.
func TestGetEnterprisePolicy_FullBlobNullWhenNoConfig(t *testing.T) {
	mb := newMockBackend()
	srv := newShortPathTestServer(t, mb)
	// No SetConfig: s.config stays nil.

	conn := dialServer(t, srv)
	t.Cleanup(func() { conn.Close() })

	sendJSON(t, conn, map[string]interface{}{
		"cmd":       "get_enterprise_policy",
		"requestId": "req-ent-blob-none",
	})

	lines := readLines(t, conn, 3, 2*time.Second)
	rawPolicy, hasField, ok := fullPolicyResult(t, lines)
	if !ok {
		t.Fatalf("expected ok=true, got ok=false")
	}
	if !hasField {
		t.Fatalf("response data must contain the policy key even without enterprise config")
	}
	if string(rawPolicy) != "null" {
		t.Errorf("policy must be null when no enterprise config is loaded, got %s", rawPolicy)
	}
}
