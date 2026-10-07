package main

import (
	"context"
	"net/http"
	"testing"
	"time"
)

// TestPprofListenerOffByDefault pins that an empty RELAY_PPROF_LISTEN
// starts nothing, and a loopback address serves the pprof index.
func TestPprofListenerOffByDefault(t *testing.T) {
	srv, err := startPprofListener("")
	if err != nil || srv != nil {
		t.Fatalf("empty address: srv=%v err=%v, want nil, nil", srv, err)
	}

	srv, err = startPprofListener("127.0.0.1:0")
	if err != nil || srv == nil {
		t.Fatalf("loopback: srv=%v err=%v", srv, err)
	}
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), time.Second)
		defer cancel()
		if err := srv.Shutdown(ctx); err != nil {
			t.Errorf("shutdown: %v", err)
		}
	})
	resp, err := http.Get("http://" + srv.Addr + "/debug/pprof/")
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("GET /debug/pprof/ = %d", resp.StatusCode)
	}

	if _, err := startPprofListener("256.0.0.1:1"); err == nil {
		t.Fatal("unbindable address did not error")
	}
}
