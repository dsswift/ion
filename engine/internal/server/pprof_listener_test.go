package server

import (
	"errors"
	"io"
	"net/http"
	"testing"
	"time"
)

func TestPprofListenerOffWhenEmpty(t *testing.T) {
	srv := NewServer(shortSocketPath(t), newMockBackend())
	stop, err := srv.StartPprofListener("")
	if err != nil || stop == nil {
		t.Fatalf("empty listen: stop=%v err=%v", stop != nil, err)
	}
	if srv.PprofAddr() != "" {
		t.Fatalf("PprofAddr = %q, want none serving", srv.PprofAddr())
	}
}

// The listener exposes heap and goroutine contents, so only a loopback
// host is accepted.
func TestPprofListenerRefusesNonLoopback(t *testing.T) {
	srv := NewServer(shortSocketPath(t), newMockBackend())
	for _, listen := range []string{"0.0.0.0:0", "192.168.1.10:6060", ":6060", "example.org:6060"} {
		if _, err := srv.StartPprofListener(listen); !errors.Is(err, errPprofNotLoopback) {
			t.Errorf("listen %q: err = %v, want errPprofNotLoopback", listen, err)
		}
	}
	if _, err := srv.StartPprofListener("no-port"); err == nil {
		t.Error("an address without a port must be refused")
	}
	if srv.PprofAddr() != "" {
		t.Fatalf("a refused listen left an address: %q", srv.PprofAddr())
	}
}

func TestPprofListenerServesOnLoopbackAndStops(t *testing.T) {
	srv := NewServer(shortSocketPath(t), newMockBackend())
	stop, err := srv.StartPprofListener("127.0.0.1:0")
	if err != nil {
		t.Fatalf("StartPprofListener: %v", err)
	}
	addr := srv.PprofAddr()
	if addr == "" {
		t.Fatal("no address after a successful start")
	}
	client := &http.Client{Timeout: 5 * time.Second}
	resp, err := client.Get("http://" + addr + "/debug/pprof/goroutine?debug=1")
	if err != nil {
		t.Fatalf("GET goroutine profile: %v", err)
	}
	body, err := io.ReadAll(resp.Body)
	resp.Body.Close() //nolint:errcheck // test read is complete
	if err != nil || resp.StatusCode != http.StatusOK || len(body) == 0 {
		t.Fatalf("status=%d len=%d err=%v", resp.StatusCode, len(body), err)
	}
	stop()
	if _, err := client.Get("http://" + addr + "/debug/pprof/"); err == nil {
		t.Fatal("the listener still answered after stop")
	}
}
