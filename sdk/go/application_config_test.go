package ion

import (
	"context"
	"testing"
	"time"
)

func TestApplicationConfigGetDistinguishesNotReadyFromMissing(t *testing.T) {
	fe := newFakeEngine(t, WithName("application-config"))
	fe.start()
	fe.doInit(ExtensionConfig{})
	ctx := fe.sdk.newContext(nil)

	for _, tc := range []struct {
		name   string
		answer map[string]any
		want   ApplicationConfigValue
	}{
		{"not ready", map[string]any{"state": "fetching", "revision": 1, "key": "region", "found": false},
			ApplicationConfigValue{State: ApplicationConfigFetching, Revision: 1, Key: "region"}},
		{"missing", map[string]any{"state": "ready", "revision": 2, "key": "region", "found": false},
			ApplicationConfigValue{State: ApplicationConfigReady, Revision: 2, Key: "region"}},
		{"found", map[string]any{"state": "ready", "revision": 2, "key": "region", "found": true, "value": "east"},
			ApplicationConfigValue{State: ApplicationConfigReady, Revision: 2, Key: "region", Found: true, Value: "east"}},
	} {
		got := make(chan ApplicationConfigValue, 1)
		go func() {
			value, err := ctx.ApplicationConfig().Get(context.Background(), "region")
			if err != nil {
				t.Errorf("%s: %v", tc.name, err)
			}
			got <- value
		}()
		frame := fe.awaitMethod("ext/get_application_config")
		params, _ := frame["params"].(map[string]any) //nolint:errcheck // asserted below
		if params["key"] != "region" {
			t.Fatalf("%s: request params = %v", tc.name, frame["params"])
		}
		fe.respond(frame["id"].(float64), tc.answer) //nolint:errcheck // fake engine ids are float64
		if value := <-got; value != tc.want {
			t.Fatalf("%s: got %+v, want %+v", tc.name, value, tc.want)
		}
		fe.mu.Lock()
		fe.frames = nil
		fe.mu.Unlock()
	}
}

func TestApplicationConfigAwaitSendsTimeoutAndReportsTimedOut(t *testing.T) {
	fe := newFakeEngine(t, WithName("application-config-await"))
	fe.start()
	fe.doInit(ExtensionConfig{})
	ctx := fe.sdk.newContext(nil)

	type result struct {
		snapshot ApplicationConfigSnapshot
		timedOut bool
	}
	got := make(chan result, 1)
	go func() {
		snapshot, timedOut, err := ctx.ApplicationConfig().Await(context.Background(), 1500*time.Millisecond)
		if err != nil {
			t.Errorf("await: %v", err)
		}
		got <- result{snapshot, timedOut}
	}()
	frame := fe.awaitMethod("ext/await_application_config")
	params, _ := frame["params"].(map[string]any) //nolint:errcheck // asserted below
	if params["timeoutMs"] != float64(1500) {
		t.Fatalf("await params = %v", frame["params"])
	}
	fe.respond(frame["id"].(float64), map[string]any{"state": "deferred", "revision": 0, "timedOut": true}) //nolint:errcheck // fake engine ids are float64
	r := <-got
	if r.snapshot.State != ApplicationConfigDeferred || !r.timedOut {
		t.Fatalf("await = %+v", r)
	}
}
