package server

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/http/pprof"
	"time"

	"github.com/dsswift/ion/engine/internal/utils"
)

// pprofShutdownGrace bounds how long Stop waits for in-flight profile
// requests before closing the listener anyway.
const pprofShutdownGrace = 2 * time.Second

// errPprofNotLoopback is returned when debug.pprof.listen names a host that
// is not a loopback address. The listener exposes goroutine dumps, heap
// contents, and command lines, so it never binds where another machine could
// reach it.
var errPprofNotLoopback = errors.New("debug.pprof.listen must be a loopback address")

// StartPprofListener serves net/http/pprof on listen, a loopback host:port
// from debug.pprof.listen. An empty listen is off and returns a no-op stop.
// A non-loopback host is refused with errPprofNotLoopback, logged at ERROR;
// the engine runs without the listener. The returned stop closes the
// listener; Stop calls it.
func (s *Server) StartPprofListener(listen string) (func(), error) {
	noop := func() {}
	if listen == "" {
		utils.LogWithFields(utils.LevelDebug, "server.pprof", "pprof listener off: debug.pprof.listen is empty", nil)
		return noop, nil
	}
	host, _, err := net.SplitHostPort(listen)
	if err != nil {
		utils.LogWithFields(utils.LevelError, "server.pprof", "pprof listener refused: address is not host:port", map[string]any{"listen": listen, "error": err.Error()})
		return noop, fmt.Errorf("debug.pprof.listen %q: %w", listen, err)
	}
	if !isLoopbackHost(host) {
		utils.LogWithFields(utils.LevelError, "server.pprof", "pprof listener refused: host is not loopback", map[string]any{"listen": listen, "listen_host": host})
		return noop, fmt.Errorf("%w: got %q", errPprofNotLoopback, listen)
	}
	ln, err := net.Listen("tcp", listen)
	if err != nil {
		utils.LogWithFields(utils.LevelError, "server.pprof", "pprof listener bind failed", map[string]any{"listen": listen, "error": err.Error()})
		return noop, fmt.Errorf("debug.pprof.listen %q: %w", listen, err)
	}
	mux := http.NewServeMux()
	mux.HandleFunc("/debug/pprof/", pprof.Index)
	mux.HandleFunc("/debug/pprof/cmdline", pprof.Cmdline)
	mux.HandleFunc("/debug/pprof/profile", pprof.Profile)
	mux.HandleFunc("/debug/pprof/symbol", pprof.Symbol)
	mux.HandleFunc("/debug/pprof/trace", pprof.Trace)
	srv := &http.Server{Handler: mux, ReadHeaderTimeout: 5 * time.Second}
	go func() {
		if serveErr := srv.Serve(ln); serveErr != nil && !errors.Is(serveErr, http.ErrServerClosed) {
			utils.LogWithFields(utils.LevelError, "server.pprof", "pprof listener stopped unexpectedly", map[string]any{"listen": listen, "error": serveErr.Error()})
		}
	}()
	s.mu.Lock()
	s.pprofStop = func() {
		ctx, cancel := context.WithTimeout(context.Background(), pprofShutdownGrace)
		defer cancel()
		if shutdownErr := srv.Shutdown(ctx); shutdownErr != nil {
			utils.LogWithFields(utils.LevelInfo, "server.pprof", "pprof listener shutdown", map[string]any{"listen": listen, "error": shutdownErr.Error()})
		}
	}
	s.pprofAddr = ln.Addr().String()
	stop := s.pprofStop
	s.mu.Unlock()
	utils.LogWithFields(utils.LevelInfo, "server.pprof", "pprof listener serving", map[string]any{"listen": ln.Addr().String()})
	return stop, nil
}

// PprofAddr returns the address the pprof listener is bound to, or "" when
// none is serving.
func (s *Server) PprofAddr() string {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.pprofAddr
}

// isLoopbackHost reports whether host names this machine only: "localhost"
// or a loopback IP literal.
func isLoopbackHost(host string) bool {
	if host == "localhost" {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}
