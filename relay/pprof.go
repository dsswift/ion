package main

// pprof.go — the opt-in profiling listener. RELAY_PPROF_LISTEN names a
// loopback address (such as 127.0.0.1:6060); unset leaves profiling off.
// It is a separate listener so the public port never serves /debug/pprof.

import (
	"errors"
	"net"
	"net/http"
	"net/http/pprof"
	"time"
)

// startPprofListener serves net/http/pprof on addr and returns the server,
// or nil when addr is empty (the default). The caller closes the server at
// shutdown. The returned error is a failure to bind addr.
func startPprofListener(addr string) (*http.Server, error) {
	if addr == "" {
		logger.Info("pprof listener off (RELAY_PPROF_LISTEN unset)", "tag", "relay.pprof")
		return nil, nil
	}
	ln, err := net.Listen("tcp", addr)
	if err != nil {
		return nil, err
	}
	mux := http.NewServeMux()
	mux.HandleFunc("/debug/pprof/", pprof.Index)
	mux.HandleFunc("/debug/pprof/cmdline", pprof.Cmdline)
	mux.HandleFunc("/debug/pprof/profile", pprof.Profile)
	mux.HandleFunc("/debug/pprof/symbol", pprof.Symbol)
	mux.HandleFunc("/debug/pprof/trace", pprof.Trace)
	srv := &http.Server{
		Addr:              ln.Addr().String(),
		Handler:           mux,
		ReadHeaderTimeout: 10 * time.Second,
	}
	go func() {
		if err := srv.Serve(ln); err != nil && !errors.Is(err, http.ErrServerClosed) {
			logger.Error("pprof listener stopped", "tag", "relay.pprof", "addr", srv.Addr, "err", err)
		}
	}()
	logger.Info("pprof listening", "tag", "relay.pprof", "addr", srv.Addr)
	return srv, nil
}
