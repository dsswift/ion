package appconfig

import (
	"encoding/json"
	"strings"
	"testing"
)

func scopedSnapshot() Snapshot {
	return Snapshot{
		State: StateReady, Revision: 4, Subject: "subject-a",
		Document: &Document{
			Common: Section{
				Values:  map[string]any{"region": "east", "shared": "common"},
				Secrets: map[string]string{"gatewayKey": "common-secret"},
			},
			Extensions: map[string]Section{
				"ext-a": {
					Values:  map[string]any{"shared": "a", "onlyA": true},
					Secrets: map[string]string{"aKey": "a-secret"},
				},
				"ext-b": {Values: map[string]any{"onlyB": true}},
			},
		},
	}
}

func TestViewScopesToTrustedExtension(t *testing.T) {
	snap := scopedSnapshot()

	a := snap.View("", "ext-a")
	if a.Values["region"] != "east" || a.Values["shared"] != "a" || a.Values["onlyA"] != true {
		t.Fatalf("an extension must see common plus its own section, its own winning: %+v", a.Values)
	}
	if _, found, _ := a.Lookup("onlyB"); found {
		t.Fatal("an extension must never see another extension's section")
	}
	if strings.Join(a.SecretKeys, ",") != "aKey,gatewayKey" {
		t.Fatalf("secret names = %v", a.SecretKeys)
	}

	untrusted := snap.View("", "")
	if untrusted.Values["shared"] != "common" || len(untrusted.Values) != 2 {
		t.Fatalf("an extension with no trusted identity must see only common: %+v", untrusted.Values)
	}
	if unknown := snap.View("", "ext-unknown"); len(unknown.Values) != 2 {
		t.Fatalf("an extension with no section must see only common: %+v", unknown.Values)
	}
}

func TestViewNeverCarriesSecretValues(t *testing.T) {
	view := scopedSnapshot().View("", "ext-a")
	encoded, err := json.Marshal(view)
	if err != nil {
		t.Fatal(err)
	}
	for _, secret := range []string{"common-secret", "a-secret"} {
		if strings.Contains(string(encoded), secret) {
			t.Fatalf("a view must never carry a secret value: %s", encoded)
		}
	}
	value, found, secret := view.Lookup("gatewayKey")
	if value != nil || found || !secret {
		t.Fatalf("a secret key must read as withheld, not found: %v %v %v", value, found, secret)
	}
}

func TestViewExtensionSectionOverridesKind(t *testing.T) {
	snap := Snapshot{State: StateReady, Document: &Document{
		Common:     Section{Values: map[string]any{"k": "plain"}, Secrets: map[string]string{"s": "hidden"}},
		Extensions: map[string]Section{"ext-a": {Values: map[string]any{"s": "plain"}, Secrets: map[string]string{"k": "hidden"}}},
	}}
	view := snap.View("", "ext-a")
	if _, found, secret := view.Lookup("k"); found || !secret {
		t.Fatal("an extension secret must replace a common value of the same name")
	}
	if value, found, _ := view.Lookup("s"); !found || value != "plain" {
		t.Fatal("an extension value must replace a common secret of the same name")
	}
}

func TestViewForOtherPrincipalIsDeferred(t *testing.T) {
	snap := scopedSnapshot()
	if view := snap.View("subject-b", "ext-a"); view.State != StateDeferred || view.Values != nil || view.SecretKeys != nil || view.Revision != 4 {
		t.Fatalf("another principal must read deferred: %+v", view)
	}
	view := snap.View("subject-a", "ext-a")
	view.Values["region"] = "mutated"
	if snap.Document.Common.Values["region"] != "east" {
		t.Fatal("a reader's view must not alias the snapshot's values")
	}
}

func TestDecodeDocument(t *testing.T) {
	doc, err := DecodeDocument([]byte(`{"common":{"values":{"k":1},"secrets":{"s":"x"}},"extensions":{"ext-a":{"values":{"a":true}}}}`))
	if err != nil || doc.Common.Values["k"] != 1.0 || doc.Common.Secrets["s"] != "x" || doc.Extensions["ext-a"].Values["a"] != true {
		t.Fatalf("decode: %+v %v", doc, err)
	}
	for _, tc := range []struct{ name, body, want string }{
		{"flat legacy object", `{"region":"east"}`, "unknown field"},
		{"array", `[1]`, "not an application config document"},
		{"null", `null`, "got null"},
		{"non-string secret", `{"common":{"secrets":{"s":1}}}`, "not an application config document"},
		{"value and secret", `{"common":{"values":{"k":1},"secrets":{"k":"x"}}}`, "both a value and a secret"},
		{"empty extension id", `{"extensions":{"":{}}}`, "empty id"},
	} {
		if _, err := DecodeDocument([]byte(tc.body)); err == nil || !strings.Contains(err.Error(), tc.want) {
			t.Fatalf("%s: err=%v, want %q", tc.name, err, tc.want)
		}
	}
}
