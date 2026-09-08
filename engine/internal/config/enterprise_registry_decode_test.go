package config

import (
	"testing"
)

// TestDecodeRegistryValues exercises the C5 decoding table plus the
// ConfigJson/explicit-override precedence and the unknown/malformed
// handling rules.
func TestDecodeRegistryValues(t *testing.T) {
	t.Run("string slice field as REG_SZ JSON array", func(t *testing.T) {
		cfg, unknown, warnings := decodeRegistryValues([]registryValue{
			{Name: "AllowedModels", Kind: RegString, Str: `["a","b"]`},
		})
		mustNoWarnings(t, unknown, warnings)
		mustStringSlice(t, cfg.AllowedModels, []string{"a", "b"})
	})

	t.Run("string slice field as REG_MULTI_SZ lines", func(t *testing.T) {
		cfg, unknown, warnings := decodeRegistryValues([]registryValue{
			{Name: "AllowedModels", Kind: RegMultiString, Strs: []string{"a", "b"}},
		})
		mustNoWarnings(t, unknown, warnings)
		mustStringSlice(t, cfg.AllowedModels, []string{"a", "b"})
	})

	t.Run("object field as REG_SZ JSON object", func(t *testing.T) {
		cfg, unknown, warnings := decodeRegistryValues([]registryValue{
			{Name: "Permissions", Kind: RegString, Str: `{"mode":"ask"}`},
		})
		mustNoWarnings(t, unknown, warnings)
		if cfg.Permissions == nil || cfg.Permissions.Mode != "ask" {
			t.Fatalf("Permissions = %+v, want mode=ask", cfg.Permissions)
		}
	})

	t.Run("ConfigJson as REG_MULTI_SZ split across lines", func(t *testing.T) {
		cfg, unknown, warnings := decodeRegistryValues([]registryValue{
			{Name: "ConfigJson", Kind: RegMultiString, Strs: []string{
				`{"allowedModels":["from-json"],`,
				`"blockedModels":["blocked-one"]}`,
			}},
		})
		mustNoWarnings(t, unknown, warnings)
		mustStringSlice(t, cfg.AllowedModels, []string{"from-json"})
		mustStringSlice(t, cfg.BlockedModels, []string{"blocked-one"})
	})

	t.Run("ConfigJson overridden by explicit AllowedModels", func(t *testing.T) {
		cfg, unknown, warnings := decodeRegistryValues([]registryValue{
			{Name: "ConfigJson", Kind: RegString, Str: `{"allowedModels":["from-json"]}`},
			{Name: "AllowedModels", Kind: RegString, Str: `["explicit"]`},
		})
		mustNoWarnings(t, unknown, warnings)
		mustStringSlice(t, cfg.AllowedModels, []string{"explicit"})
	})

	t.Run("Config alias behaves like ConfigJson", func(t *testing.T) {
		cfg, unknown, warnings := decodeRegistryValues([]registryValue{
			{Name: "Config", Kind: RegString, Str: `{"allowedModels":["via-config-alias"]}`},
		})
		mustNoWarnings(t, unknown, warnings)
		mustStringSlice(t, cfg.AllowedModels, []string{"via-config-alias"})
	})

	t.Run("value name matched case-insensitively", func(t *testing.T) {
		cfg, unknown, warnings := decodeRegistryValues([]registryValue{
			{Name: "allowedmodels", Kind: RegString, Str: `["lower"]`},
		})
		mustNoWarnings(t, unknown, warnings)
		mustStringSlice(t, cfg.AllowedModels, []string{"lower"})
	})

	t.Run("number field as REG_DWORD", func(t *testing.T) {
		cfg, unknown, warnings := decodeRegistryValues([]registryValue{
			{Name: "ConversationRetentionDays", Kind: RegInteger, Num: 30},
		})
		mustNoWarnings(t, unknown, warnings)
		if cfg.ConversationRetentionDays == nil || *cfg.ConversationRetentionDays != 30 {
			t.Fatalf("ConversationRetentionDays = %v, want 30", cfg.ConversationRetentionDays)
		}
	})

	t.Run("nested object field auth.requireOperatorIdentity", func(t *testing.T) {
		cfg, unknown, warnings := decodeRegistryValues([]registryValue{
			{Name: "auth", Kind: RegString, Str: `{"requireOperatorIdentity":true}`},
		})
		mustNoWarnings(t, unknown, warnings)
		if cfg.Auth == nil || !cfg.Auth.RequireOperatorIdentity {
			t.Fatalf("Auth = %+v, want RequireOperatorIdentity=true", cfg.Auth)
		}
	})

	t.Run("unknown value name reported", func(t *testing.T) {
		_, unknown, warnings := decodeRegistryValues([]registryValue{
			{Name: "Foo", Kind: RegString, Str: "bar"},
		})
		if len(warnings) != 0 {
			t.Fatalf("unexpected warnings: %+v", warnings)
		}
		if len(unknown) != 1 || unknown[0] != "Foo" {
			t.Fatalf("unknown = %v, want [Foo]", unknown)
		}
	})

	t.Run("reserved metadata names not reported as unknown", func(t *testing.T) {
		_, unknown, warnings := decodeRegistryValues([]registryValue{
			{Name: "MDMDeviceID", Kind: RegString, Str: "device-123"},
			{Name: "MDMSerialNumber", Kind: RegString, Str: "serial-456"},
		})
		if len(warnings) != 0 {
			t.Fatalf("unexpected warnings: %+v", warnings)
		}
		if len(unknown) != 0 {
			t.Fatalf("unknown = %v, want none (reserved metadata)", unknown)
		}
	})

	t.Run("malformed value skipped, sibling still decodes", func(t *testing.T) {
		cfg, unknown, warnings := decodeRegistryValues([]registryValue{
			{Name: "Network", Kind: RegString, Str: `not-json`},
			{Name: "AllowedModels", Kind: RegString, Str: `["still-here"]`},
		})
		if len(unknown) != 0 {
			t.Fatalf("unexpected unknown: %v", unknown)
		}
		if len(warnings) != 1 || warnings[0].Name != "Network" {
			t.Fatalf("warnings = %+v, want one Network warning", warnings)
		}
		mustStringSlice(t, cfg.AllowedModels, []string{"still-here"})
	})
}

func mustNoWarnings(t *testing.T, unknown []string, warnings []decodeWarning) {
	t.Helper()
	if len(unknown) != 0 {
		t.Fatalf("unexpected unknown names: %v", unknown)
	}
	if len(warnings) != 0 {
		t.Fatalf("unexpected warnings: %+v", warnings)
	}
}

func mustStringSlice(t *testing.T, got, want []string) {
	t.Helper()
	if len(got) != len(want) {
		t.Fatalf("got %v, want %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("got %v, want %v", got, want)
		}
	}
}
