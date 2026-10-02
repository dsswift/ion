package config

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"sync"
	"testing"

	"github.com/dsswift/ion/engine/internal/types"
)

// useOSAccount stands in for the operating-system account the engine runs as.
func useOSAccount(t *testing.T, account osAccount) {
	t.Helper()
	orig := currentOSAccount
	currentOSAccount = func() osAccount { return account }
	t.Cleanup(func() { currentOSAccount = orig })
}

func principal(subject string, groups ...string) *types.SessionPrincipal {
	claims := map[string]any{}
	if len(groups) > 0 {
		list := make([]any, len(groups))
		for i, g := range groups {
			list[i] = g
		}
		claims["groups"] = list
	}
	return &types.SessionPrincipal{Subject: subject, Provider: "entra", Kind: "operator", Claims: claims}
}

// TestComposeAccountPolicy_Precedence pins the rule each field class follows
// when an account policy composes under the machine policy.
func TestComposeAccountPolicy_Precedence(t *testing.T) {
	machine := &types.EnterpriseConfig{
		AllowedModels:    []string{"model-a", "model-b"},
		BlockedModels:    []string{"model-x"},
		McpAllowlist:     []string{"*.corp.example", "tools"},
		McpDenylist:      []string{"bad"},
		ToolRestrictions: &types.ToolRestrictions{Allow: []string{"Read", "Grep", "Bash"}, Deny: []string{"WebFetch"}},
		Permissions:      &types.PermissionPolicy{Mode: "ask", Rules: []types.PermissionRule{{Tool: "Bash", Decision: "allow", CommandPatterns: []string{"git *"}}}},
		Sandbox:          &types.SandboxEnterpriseConfig{Required: false, AllowDisable: true, AdditionalDenyPaths: []string{"/secrets"}},
		ResourceLimits:   &types.ResourceLimits{MaxAgentsPerSession: intPtr(8)},
		Limits:           &types.EnterpriseLimits{PlanModeAllowedBashCommands: []string{"git", "ls"}},
		Telemetry:        &types.TelemetryConfig{Enabled: true, HttpEndpoint: "https://machine.example/t"},
		NewConversationDefaults: &types.NewConversationDefaultsPolicy{
			BaseDirectory: "/machine", Locked: true,
		},
		CustomFields: map[string]any{"ion-desktop": map[string]any{"disableAutoUpdate": true, "themePolicy": map[string]any{"themeId": "machine"}}},
	}
	account := &types.EnterpriseConfig{
		AllowedModels:    []string{"model-b"},
		BlockedModels:    []string{"model-y"},
		McpAllowlist:     []string{"git.corp.example"},
		McpDenylist:      []string{"worse"},
		ToolRestrictions: &types.ToolRestrictions{Allow: []string{"Read"}, Deny: []string{"Bash"}},
		Permissions: &types.PermissionPolicy{Mode: "deny", Rules: []types.PermissionRule{
			{Tool: "Write", Decision: "deny"},
		}},
		Sandbox:        &types.SandboxEnterpriseConfig{Required: true, AllowDisable: false, AdditionalDenyPaths: []string{"/more"}},
		ResourceLimits: &types.ResourceLimits{MaxAgentsPerSession: intPtr(2)},
		Limits:         &types.EnterpriseLimits{PlanModeAllowedBashCommands: []string{"git log"}},
		Telemetry:      &types.TelemetryConfig{Enabled: false, HttpEndpoint: "https://account.example/t"},
		NewConversationDefaults: &types.NewConversationDefaultsPolicy{
			BaseDirectory: "/account",
		},
		CustomFields: map[string]any{"ion-desktop": map[string]any{"themePolicy": map[string]any{"themeId": "account"}}},
	}
	before, _ := json.Marshal(machine)

	var notes []composeNote
	got := composeAccountPolicy(machine, account, "team", &notes)

	check := func(name string, got, want any) {
		t.Helper()
		if !reflect.DeepEqual(got, want) {
			t.Errorf("%s = %#v, want %#v", name, got, want)
		}
	}
	// Allowlists narrow.
	check("allowedModels", got.AllowedModels, []string{"model-b"})
	check("mcpAllowlist", got.McpAllowlist, []string{"git.corp.example"})
	check("toolRestrictions.allow", got.ToolRestrictions.Allow, []string{"Read"})
	check("planModeAllowedBashCommands", got.Limits.PlanModeAllowedBashCommands, []string{"git log"})
	// Deny and additive lists union.
	check("blockedModels", got.BlockedModels, []string{"model-x", "model-y"})
	check("mcpDenylist", got.McpDenylist, []string{"bad", "worse"})
	check("toolRestrictions.deny", got.ToolRestrictions.Deny, []string{"WebFetch", "Bash"})
	check("sandbox.additionalDenyPaths", got.Sandbox.AdditionalDenyPaths, []string{"/secrets", "/more"})
	// One-way switches and bounds take the stricter value.
	check("permissions.mode", got.Permissions.Mode, "deny")
	check("sandbox.required", got.Sandbox.Required, true)
	check("sandbox.allowDisable", got.Sandbox.AllowDisable, false)
	check("maxAgentsPerSession", *got.ResourceLimits.MaxAgentsPerSession, 2)
	check("telemetry.enabled", got.Telemetry.Enabled, true)
	check("newConversationDefaults.locked", got.NewConversationDefaults.Locked, true)
	// An account deny rule is evaluated ahead of the machine rules.
	check("permissions.rules[0]", got.Permissions.Rules[0], types.PermissionRule{Tool: "Write", Decision: "deny"})
	check("permissions.rules count", len(got.Permissions.Rules), 2)
	// Managed values: the account value wins.
	check("telemetry.httpEndpoint", got.Telemetry.HttpEndpoint, "https://account.example/t")
	check("newConversationDefaults.baseDirectory", got.NewConversationDefaults.BaseDirectory, "/account")
	desktop := got.CustomFields["ion-desktop"].(map[string]any) //nolint:errcheck // shape built above
	check("customFields merge keeps machine key", desktop["disableAutoUpdate"], true)
	check("customFields merge takes account key", desktop["themePolicy"], map[string]any{"themeId": "account"})

	if len(notes) != 0 {
		t.Errorf("unexpected ignored values: %+v", notes)
	}
	after, _ := json.Marshal(machine)
	if string(before) != string(after) {
		t.Error("composeAccountPolicy mutated the machine policy")
	}
}

// TestComposeAccountPolicy_WeakeningIgnored pins that an account value which
// would relax a machine constraint is ignored and the machine value stands.
func TestComposeAccountPolicy_WeakeningIgnored(t *testing.T) {
	machine := &types.EnterpriseConfig{
		AllowedModels:      []string{"model-a", "model-b"},
		AllowedProviders:   []string{"gateway"},
		PluginAllowlist:    []string{"corp/*"},
		ExtensionAllowlist: []types.ExtensionAllowlistEntry{{ID: "sync", SHA256: "aa"}, {ID: "review"}},
		ToolRestrictions:   &types.ToolRestrictions{Allow: []string{"Read"}},
		Permissions:        &types.PermissionPolicy{Mode: "deny", TierRules: map[string]string{"HIGH": "deny"}},
		Sandbox:            &types.SandboxEnterpriseConfig{Required: true},
		ResourceLimits:     &types.ResourceLimits{MaxAgentsPerSession: intPtr(2)},
		Limits:             &types.EnterpriseLimits{PlanModeAllowedBashCommands: []string{"gh pr view"}},
		Security:           &types.EnterpriseSecurityConfig{RequirePrincipalPartitioning: true, MinEnforcement: types.EnforcementStrict},
		Thinking:           &types.ThinkingPolicyConfig{Disabled: true},
		Git:                &types.EnterpriseGitConfig{Required: true},
		ProtectedOperations: map[string]types.ProtectedOperationConfig{
			"publish": {Method: "POST", URL: "https://machine.example/publish"},
		},
	}
	account := &types.EnterpriseConfig{
		AllowedModels:      []string{"model-b", "model-z"},
		AllowedProviders:   []string{"elsewhere"},
		PluginAllowlist:    []string{"*"},
		ExtensionAllowlist: []types.ExtensionAllowlistEntry{{ID: "sync", SHA256: "bb"}, {ID: "review", SHA256: "cc"}, {ID: "rogue"}},
		ToolRestrictions:   &types.ToolRestrictions{Allow: []string{"Read", "Bash"}},
		Permissions: &types.PermissionPolicy{
			Mode:      "allow",
			Rules:     []types.PermissionRule{{Tool: "Bash", Decision: "allow"}, {Tool: "Write", Decision: "ask"}},
			TierRules: map[string]string{"HIGH": "allow", "LOW": "allow"},
		},
		Sandbox:        &types.SandboxEnterpriseConfig{Required: false, AllowDisable: true},
		ResourceLimits: &types.ResourceLimits{MaxAgentsPerSession: intPtr(50)},
		Limits:         &types.EnterpriseLimits{PlanModeAllowedBashCommands: []string{"gh"}},
		Security:       &types.EnterpriseSecurityConfig{MinEnforcement: types.EnforcementReadOnly},
		Thinking:       &types.ThinkingPolicyConfig{Disabled: false},
		Git:            &types.EnterpriseGitConfig{Required: false},
		Providers:      map[string]types.ProviderConfig{"elsewhere": {BaseURL: "https://elsewhere.example"}},
		ProtectedOperations: map[string]types.ProtectedOperationConfig{
			"publish": {Method: "POST", URL: "https://account.example/publish"},
		},
	}

	var notes []composeNote
	got := composeAccountPolicy(machine, account, "team", &notes)

	check := func(name string, got, want any) {
		t.Helper()
		if !reflect.DeepEqual(got, want) {
			t.Errorf("%s = %#v, want %#v", name, got, want)
		}
	}
	check("allowedModels drops the outside entry", got.AllowedModels, []string{"model-b"})
	check("allowedProviders disjoint: machine stands", got.AllowedProviders, []string{"gateway"})
	check("pluginAllowlist glob cannot widen", got.PluginAllowlist, []string{"corp/*"})
	check("extensionAllowlist", got.ExtensionAllowlist, []types.ExtensionAllowlistEntry{{ID: "review", SHA256: "cc"}})
	check("toolRestrictions.allow", got.ToolRestrictions.Allow, []string{"Read"})
	check("permissions.mode", got.Permissions.Mode, "deny")
	check("permissions.rules: allow dropped, ask dropped under deny", len(got.Permissions.Rules), 0)
	check("permissions.tierRules", got.Permissions.TierRules, map[string]string{"HIGH": "deny"})
	check("sandbox.required", got.Sandbox.Required, true)
	check("sandbox.allowDisable", got.Sandbox.AllowDisable, false)
	check("maxAgentsPerSession", *got.ResourceLimits.MaxAgentsPerSession, 2)
	check("planModeAllowedBashCommands cannot generalise", got.Limits.PlanModeAllowedBashCommands, []string{})
	check("security.minEnforcement", got.Security.MinEnforcement, types.EnforcementStrict)
	check("security.requirePrincipalPartitioning", got.Security.RequirePrincipalPartitioning, true)
	check("thinking.disabled", got.Thinking.Disabled, true)
	check("git.required", got.Git.Required, true)
	check("providers outside allowedProviders", len(got.Providers), 0)
	check("protectedOperations: machine wins the name", got.ProtectedOperations["publish"].URL, "https://machine.example/publish")

	ignored := map[string]bool{}
	for _, n := range notes {
		ignored[n.Field] = true
	}
	for _, field := range []string{"allowedModels", "allowedProviders", "pluginAllowlist", "extensionAllowlist", "toolRestrictions.allow", "permissions.rules", "permissions.tierRules", "providers", "protectedOperations"} {
		if !ignored[field] {
			t.Errorf("no ignored-value note for %s; notes=%+v", field, notes)
		}
	}
}

// TestResolveProcessAccountScope pins OS-account matching and that a host
// with no account policies resolves exactly the machine policy.
func TestResolveProcessAccountScope(t *testing.T) {
	useOSAccount(t, osAccount{Users: []string{`CORP\Dana`, "Dana", "S-1-5-21-1"}, Groups: []string{"S-1-12-1-7", "Contractors"}})

	t.Run("no account policies returns the machine policy itself", func(t *testing.T) {
		machine := &types.EnterpriseConfig{AllowedModels: []string{"model-a"}}
		if got := resolveProcessAccountScope(machine); got != machine {
			t.Error("a policy with no account policies must be returned unchanged")
		}
		if got := resolveProcessAccountScope(nil); got != nil {
			t.Error("nil policy must stay nil")
		}
	})

	t.Run("matches by user and by group, in order", func(t *testing.T) {
		machine := &types.EnterpriseConfig{
			AllowedModels: []string{"model-a", "model-b", "model-c"},
			AssetScopes:   []string{"forged"},
			AccountPolicies: []types.AccountPolicy{
				{Name: "contractors", Match: types.AccountMatch{OSGroups: []string{"s-1-12-1-7"}}, AssetScope: "contractors",
					Policy: &types.EnterpriseConfig{AllowedModels: []string{"model-a", "model-b"}}},
				{Name: "someone-else", Match: types.AccountMatch{OSUsers: []string{"lee"}},
					Policy: &types.EnterpriseConfig{AllowedModels: []string{"model-c"}}},
				{Name: "dana", Match: types.AccountMatch{OSUsers: []string{"dana"}}, AssetScope: "Bad Scope",
					Policy: &types.EnterpriseConfig{AllowedModels: []string{"model-b"}}},
			},
		}
		got := resolveProcessAccountScope(machine)
		if !reflect.DeepEqual(got.AllowedModels, []string{"model-b"}) {
			t.Errorf("allowedModels = %v, want [model-b]", got.AllowedModels)
		}
		if !reflect.DeepEqual(got.AssetScopes, []string{"contractors"}) {
			t.Errorf("assetScopes = %v, want [contractors]: a source cannot set them and an invalid name is dropped", got.AssetScopes)
		}
		if len(got.AccountPolicies) != 0 {
			t.Errorf("resolved policy still carries account policies: %+v", got.AccountPolicies)
		}
		if len(machine.AccountPolicies) != 3 || len(machine.AllowedModels) != 3 {
			t.Error("resolveProcessAccountScope mutated its input")
		}
	})

	t.Run("an account that matches nothing gets the machine policy", func(t *testing.T) {
		machine := &types.EnterpriseConfig{
			AllowedModels: []string{"model-a"},
			AccountPolicies: []types.AccountPolicy{
				{Match: types.AccountMatch{OSGroups: []string{"Admins"}}, Policy: &types.EnterpriseConfig{BlockedModels: []string{"model-a"}}},
			},
		}
		got := resolveProcessAccountScope(machine)
		if len(got.BlockedModels) != 0 || !reflect.DeepEqual(got.AllowedModels, []string{"model-a"}) {
			t.Errorf("unmatched account policy was applied: %+v", got)
		}
	})
}

func sessionScopedMachinePolicy() *types.EnterpriseConfig {
	return &types.EnterpriseConfig{
		AllowedModels: []string{"model-a", "model-b", "model-c"},
		AccountPolicies: []types.AccountPolicy{
			{Name: "contractors", AssetScope: "contractors",
				Match:  types.AccountMatch{Claims: map[string][]string{"groups": {"contractors"}}},
				Policy: &types.EnterpriseConfig{AllowedModels: []string{"model-a"}, Telemetry: &types.TelemetryConfig{Enabled: true}, ResourceLimits: &types.ResourceLimits{MaxSessions: intPtr(1), MaxAgentsPerSession: intPtr(1)}}},
			{Name: "qa", AssetScope: "qa",
				Match:  types.AccountMatch{Subjects: []string{"qa@example.com"}},
				Policy: &types.EnterpriseConfig{AllowedModels: []string{"model-b"}, ToolRestrictions: &types.ToolRestrictions{Deny: []string{"Bash"}}}},
		},
	}
}

// TestResolveEnterpriseForPrincipal pins per-session resolution: each
// principal gets its own policy, process-wide fields are dropped from a
// principal-scoped entry, and the result never carries the account list.
func TestResolveEnterpriseForPrincipal(t *testing.T) {
	useOSAccount(t, osAccount{Users: []string{"svc"}})
	process := resolveProcessAccountScope(sessionScopedMachinePolicy())
	if !HasSessionScopedPolicies(process) {
		t.Fatal("principal-scoped entries must stay pending on the process policy")
	}
	if !reflect.DeepEqual(process.AllowedModels, []string{"model-a", "model-b", "model-c"}) {
		t.Fatalf("a principal-scoped entry was applied to the process: %v", process.AllowedModels)
	}

	contractor := ResolveEnterpriseForPrincipal(process, principal("c@example.com", "contractors"))
	if !reflect.DeepEqual(contractor.AllowedModels, []string{"model-a"}) {
		t.Errorf("contractor allowedModels = %v", contractor.AllowedModels)
	}
	if contractor.Telemetry != nil {
		t.Error("telemetry is process-wide and must be dropped from a principal-scoped entry")
	}
	if contractor.ResourceLimits == nil || contractor.ResourceLimits.MaxSessions != nil || *contractor.ResourceLimits.MaxAgentsPerSession != 1 {
		t.Errorf("resourceLimits = %+v, want maxAgentsPerSession 1 and no maxSessions", contractor.ResourceLimits)
	}
	if !reflect.DeepEqual(contractor.AssetScopes, []string{"contractors"}) {
		t.Errorf("contractor assetScopes = %v", contractor.AssetScopes)
	}

	qa := ResolveEnterpriseForPrincipal(process, principal("qa@example.com"))
	if !reflect.DeepEqual(qa.AllowedModels, []string{"model-b"}) || qa.ToolRestrictions == nil {
		t.Errorf("qa policy = %+v", qa)
	}

	for name, p := range map[string]*types.SessionPrincipal{"unmatched": principal("it@example.com"), "unattributed": nil} {
		got := ResolveEnterpriseForPrincipal(process, p)
		if !reflect.DeepEqual(got.AllowedModels, []string{"model-a", "model-b", "model-c"}) || got.ToolRestrictions != nil || len(got.AssetScopes) != 0 {
			t.Errorf("%s principal got another account's policy: %+v", name, got)
		}
	}

	for name, got := range map[string]*types.EnterpriseConfig{"contractor": contractor, "qa": qa} {
		if len(got.AccountPolicies) != 0 {
			t.Errorf("%s policy carries the account policy list", name)
		}
	}
	if len(process.AccountPolicies) != 2 {
		t.Error("ResolveEnterpriseForPrincipal mutated the process policy")
	}
}

// TestResolveEnterpriseForPrincipal_ConcurrentIsolation resolves two
// accounts' policies from many goroutines at once. Run under -race.
func TestResolveEnterpriseForPrincipal_ConcurrentIsolation(t *testing.T) {
	useOSAccount(t, osAccount{Users: []string{"svc"}})
	process := resolveProcessAccountScope(sessionScopedMachinePolicy())
	want := map[string][]string{"c@example.com": {"model-a"}, "qa@example.com": {"model-b"}}

	var wg sync.WaitGroup
	for i := 0; i < 64; i++ {
		for subject, models := range want {
			wg.Add(1)
			go func(subject string, models []string) {
				defer wg.Done()
				p := principal(subject)
				if subject == "c@example.com" {
					p = principal(subject, "contractors")
				}
				got := ResolveEnterpriseForPrincipal(process, p)
				if !reflect.DeepEqual(got.AllowedModels, models) {
					t.Errorf("%s resolved %v, want %v", subject, got.AllowedModels, models)
				}
			}(subject, models)
		}
	}
	wg.Wait()
}

// TestAccountPolicies_UserWritableSourceRejected pins that account policies
// are read from the machine source only: a per-user source that carries them
// changes nothing.
func TestAccountPolicies_UserWritableSourceRejected(t *testing.T) {
	useOSAccount(t, osAccount{Users: []string{"dana"}})
	useManagedMarker(t, "")
	t.Setenv("ION_ENTERPRISE_CONFIG", "")
	useMachinePolicy(t, types.EnterpriseConfig{AllowedModels: []string{"model-a"}, BlockedModels: []string{"model-x"}})

	home := t.TempDir()
	t.Setenv("HOME", home)
	dir := filepath.Join(home, ".config", "ion")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	selfAuthored := `{
		"allowedModels": ["model-z"],
		"accountPolicies": [{"match": {"osUsers": ["dana"]}, "assetScope": "mine",
			"policy": {"allowedModels": ["model-z"], "customFields": {"ion-desktop": {"themePolicy": {"themeId": "mine"}}}}}],
		"assetScopes": ["mine"]
	}`
	if err := os.WriteFile(filepath.Join(dir, "enterprise-user.json"), []byte(selfAuthored), 0o644); err != nil {
		t.Fatal(err)
	}

	got := loadEnterpriseConfig("linux")
	if got == nil {
		t.Fatal("machine policy did not load")
	}
	if !reflect.DeepEqual(got.AllowedModels, []string{"model-a"}) || !reflect.DeepEqual(got.BlockedModels, []string{"model-x"}) {
		t.Errorf("a user-writable source changed policy: %+v", got)
	}
	if len(got.AccountPolicies) != 0 || len(got.AssetScopes) != 0 || got.CustomFields != nil {
		t.Errorf("a user-writable source supplied account policy: %+v", got)
	}
}

// TestAccountPolicies_MachineSourceDecodes pins the JSON shape an
// administrator writes, and that drop-ins accumulate account policies.
func TestAccountPolicies_MachineSourceDecodes(t *testing.T) {
	var base, dropIn types.EnterpriseConfig
	if err := json.Unmarshal([]byte(`{
		"allowedModels": ["model-a", "model-b"],
		"accountPolicies": [{
			"name": "contractors",
			"match": {"osGroups": ["Contractors"], "claims": {"groups": ["contractors"]}},
			"assetScope": "contractors",
			"policy": {"allowedModels": ["model-a"], "permissions": {"mode": "ask"}}
		}]
	}`), &base); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal([]byte(`{"accountPolicies": [{"match": {"osUsers": ["dana"]}, "policy": {"blockedModels": ["model-b"]}}]}`), &dropIn); err != nil {
		t.Fatal(err)
	}
	merged := mergeEnterprisePartial(&base, &dropIn)
	if len(merged.AccountPolicies) != 2 {
		t.Fatalf("drop-in account policies must accumulate, got %d", len(merged.AccountPolicies))
	}
	first := merged.AccountPolicies[0]
	if first.Name != "contractors" || first.AssetScope != "contractors" || !first.Match.SessionScoped() ||
		first.Policy == nil || first.Policy.Permissions.Mode != "ask" {
		t.Errorf("decoded account policy = %+v", first)
	}
	if merged.AccountPolicies[1].Match.SessionScoped() {
		t.Error("an OS-only match must not be session scoped")
	}
}
