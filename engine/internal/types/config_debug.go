package types

// DebugConfig holds the engine's operator-facing diagnostics switches. Every
// one is off unless engine.json names it; none changes what the engine does
// for a client.
//
//	{ "debug": { "pprof": { "listen": "127.0.0.1:6060" } } }
type DebugConfig struct {
	// Pprof configures the net/http/pprof listener. Nil is off.
	Pprof *PprofConfig `json:"pprof,omitempty"`
}

// PprofConfig configures the live profiling endpoint.
type PprofConfig struct {
	// Listen is the host:port the pprof HTTP server binds. Empty (the
	// default) serves nothing. The host must be a loopback address: a value
	// that would expose the endpoint beyond this machine is refused at start
	// and logged, and the engine runs without it. The one-shot alternative
	// that needs no listener is the debug_profile command (`ion debug
	// profile`).
	Listen string `json:"listen,omitempty"`
}

// PprofListen returns the configured pprof listen address, or "" when
// profiling over HTTP is off. Nil-safe at every level.
func (c *DebugConfig) PprofListen() string {
	if c == nil || c.Pprof == nil {
		return ""
	}
	return c.Pprof.Listen
}

// MergeDebug layers src over dst: a later layer that names a listen address
// replaces the earlier one, and an empty value leaves the earlier one. Nil
// src returns dst unchanged.
func MergeDebug(dst, src *DebugConfig) *DebugConfig {
	if src == nil {
		return dst
	}
	if dst == nil {
		cp := *src
		if src.Pprof != nil {
			p := *src.Pprof
			cp.Pprof = &p
		}
		return &cp
	}
	out := *dst
	if dst.Pprof != nil {
		p := *dst.Pprof
		out.Pprof = &p
	}
	if src.Pprof != nil {
		if out.Pprof == nil {
			out.Pprof = &PprofConfig{}
		}
		if src.Pprof.Listen != "" {
			out.Pprof.Listen = src.Pprof.Listen
		}
	}
	return &out
}
