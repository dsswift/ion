package session

import (
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/dsswift/ion/engine/internal/types"
)

func sessionExtensionsManager(t *testing.T, configured []string) *Manager {
	t.Helper()
	mgr := NewManager(newMockBackend())
	t.Cleanup(mgr.Shutdown)
	mgr.SetHeartbeatInterval(time.Hour)
	mgr.SetConfig(&types.EngineRuntimeConfig{SessionExtensions: configured})
	return mgr
}

func TestWithSessionExtensions(t *testing.T) {
	cases := []struct {
		name       string
		configured []string
		own        []string
		want       []string
	}{
		{name: "none configured keeps the session's list", own: []string{"/x/harness"}, want: []string{"/x/harness"}},
		{name: "appended after the session's own", configured: []string{"/x/ledger"}, own: []string{"/x/harness"}, want: []string{"/x/harness", "/x/ledger"}},
		{name: "a session with no extensions gets them", configured: []string{"/x/ledger"}, want: []string{"/x/ledger"}},
		{name: "an entry the session names is not loaded twice", configured: []string{"/x/ledger/"}, own: []string{"/x/ledger"}, want: []string{"/x/ledger"}},
		{name: "duplicates in the configured list collapse", configured: []string{"/x/ledger", "/x/./ledger"}, want: []string{"/x/ledger"}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			mgr := sessionExtensionsManager(t, tc.configured)
			got := mgr.withSessionExtensions("k", tc.own)
			if len(got) == 0 && len(tc.want) == 0 {
				return
			}
			if !reflect.DeepEqual(got, tc.want) {
				t.Fatalf("extensions = %v, want %v", got, tc.want)
			}
		})
	}
}

// A session that names no extensions still loads the configured ones: the
// start fails on the configured path that does not exist, which only
// happens if start_session resolved it into the session's list.
func TestStartSession_LoadsConfiguredSessionExtensions(t *testing.T) {
	missing := t.TempDir() + "/no-such-extension"
	mgr := sessionExtensionsManager(t, []string{missing})
	cfg := defaultConfig()
	cfg.Extensions = nil
	_, err := mgr.StartSession("every", cfg)
	if err == nil || !strings.Contains(err.Error(), "no-such-extension") {
		t.Fatalf("start error = %v, want a failure naming the configured extension", err)
	}
}
