package appconfig

import (
	"errors"
	"testing"
)

func secretSnapshot() Snapshot {
	return Snapshot{State: StateReady, Subject: "subject-a", Document: &Document{
		Common: Section{
			Values:  map[string]any{"endpoint": "https://erm.example.com"},
			Secrets: map[string]string{"gatewayKey": "common-key", "shadowed": "common-secret"},
		},
		Extensions: map[string]Section{
			"orion":  {Secrets: map[string]string{"gatewayKey": "orion-key", "ownOnly": "orion-only"}},
			"shadow": {Values: map[string]any{"shadowed": "now-plain"}},
		},
	}}
}

// TestSnapshotSecretFollowsViewScoping pins that the engine-internal read
// resolves a secret exactly as View scopes it: own section over common,
// another extension's section never, a plain value never.
func TestSnapshotSecretFollowsViewScoping(t *testing.T) {
	snap := secretSnapshot()
	cases := []struct {
		name, subject, extension, key, want string
		err                                 error
	}{
		{"common secret", "", "", "gatewayKey", "common-key", nil},
		{"own section wins", "subject-a", "orion", "gatewayKey", "orion-key", nil},
		{"own-only secret", "subject-a", "orion", "ownOnly", "orion-only", nil},
		{"another extension's secret", "subject-a", "shadow", "ownOnly", "", ErrNotFound},
		{"no trusted id sees common only", "subject-a", "", "ownOnly", "", ErrNotFound},
		{"plain value refused", "", "", "endpoint", "", ErrNotSecret},
		{"own plain value shadows a common secret", "", "shadow", "shadowed", "", ErrNotSecret},
	}
	for _, tc := range cases {
		got, err := snap.Secret(tc.subject, tc.extension, tc.key)
		if got != tc.want || !errors.Is(err, tc.err) {
			t.Fatalf("%s: got %q, %v", tc.name, got, err)
		}
	}

	var notReady NotReadyError
	if _, err := snap.Secret("subject-b", "", "gatewayKey"); !errors.As(err, &notReady) || notReady.State != StateDeferred {
		t.Fatalf("another principal must read deferred: %v", err)
	}
	if _, err := (Snapshot{State: StateFetching}).Secret("", "", "gatewayKey"); !errors.As(err, &notReady) || notReady.State != StateFetching {
		t.Fatalf("fetching: %v", err)
	}
}

func TestReadSecretWithNoStore(t *testing.T) {
	Install(nil)
	if _, err := ReadSecret("", "", "gatewayKey"); !errors.Is(err, ErrDisabled) {
		t.Fatalf("no store: %v", err)
	}
}
