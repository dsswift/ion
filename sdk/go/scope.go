// scope.go — which half of an extension this process is.
//
// An extension whose manifest declares scope "engine" or "both" runs as two
// kinds of process: session hosts, one per conversation, and one engine host
// that belongs to the engine itself. The engine tells a subprocess which it is
// through ION_EXTENSION_SCOPE before init, so registrations made ahead of
// [SDK.Run] can already branch on it; the init handshake repeats the value in
// [ExtensionConfig.Scope].
package ion

import "os"

// Scope is the role of an extension process.
type Scope string

const (
	// ScopeSession is a host bound to one conversation. Hooks, tools, and
	// commands register here.
	ScopeSession Scope = "session"
	// ScopeEngine is the engine-scoped host. Schedules, webhooks, and resource
	// producers register here; its fires run in headless sessions.
	ScopeEngine Scope = "engine"
)

// ScopeEnv is the environment variable the engine sets at spawn.
const ScopeEnv = "ION_EXTENSION_SCOPE"

// ScopeFromEnv reads the scope the engine exported. An engine that predates
// scopes exports nothing, which is a session host.
func ScopeFromEnv() Scope {
	switch Scope(os.Getenv(ScopeEnv)) {
	case ScopeEngine:
		return ScopeEngine
	default:
		return ScopeSession
	}
}

// Scope reports the role of this process. It is known from construction, so an
// extension can decide what to register before [SDK.Run].
func (s *SDK) Scope() Scope { return s.scope }

// IsEngineScope reports whether this process is the engine-scoped host.
func (s *SDK) IsEngineScope() bool { return s.scope == ScopeEngine }
