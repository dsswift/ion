package mcp

// discovery_cache.go — process-lifetime memoization for OAuth metadata
// discovery.
//
// Discovery answers a static question: where does this server's authorization
// live. The documents are deployment configuration, not per-request state, and
// a well-known endpoint that answered a minute ago answers the same now. But
// every caller re-fetched them, so the cost scaled with how often the engine
// happened to ask rather than with how many distinct servers exist.
//
// That mattered because discovery sits on two hot paths at once: the connect
// path resolves metadata to build an authorization request, and
// annotateAuthFailure resolves it AGAIN to name the issuer in a 401's
// remediation. A server with a dead credential therefore paid two well-known
// fetches on every single connect, forever, to re-derive an answer that had not
// changed since the first one.
//
// ── Why failures are cached too ──────────────────────────────────────────────
// A server that publishes no metadata is the case that costs the most: it
// probes every candidate URL and 404s on each before failing. Caching only
// successes would leave exactly that case paying full price every time, which
// is the opposite of the intent. A negative entry is the more valuable one.
//
// ── Why the lifetime is the process ─────────────────────────────────────────
// No TTL. Metadata changes when an operator redeploys an authorization server,
// which is not a thing that happens mid-daemon, and the engine already has a
// remediation for stale credentials (`ion mcp login`) that runs in a fresh
// process. A TTL would add a knob and a staleness window in exchange for
// re-fetching documents that do not move. Invalidation is available for the
// one case that can change within a process: see invalidateDiscovery.

import (
	"sync"

	"github.com/dsswift/ion/engine/internal/utils"
)

// protectedResourceResult is one memoized DiscoverProtectedResource outcome.
// Both fields are meaningful: err non-nil is a cached failure, and the caller
// gets the original error rather than a synthesized one.
type protectedResourceResult struct {
	meta *ProtectedResourceMetadata
	err  error
}

// authServerResult is one memoized DiscoverAuthServer outcome.
type authServerResult struct {
	meta *ServerMetadata
	err  error
}

// forServerResult is one memoized DiscoverForServer outcome, including the
// resolved scope string so a cache hit reproduces the full return tuple.
type forServerResult struct {
	meta  *ServerMetadata
	scope string
	err   error
}

// Caches are keyed by the URL being discovered, NOT by server name. The URL is
// what determines the answer: two `mcpServers` entries pointing at one host
// share a result, and renaming a server does not invalidate a still-correct
// document. Server name stays a log field only.
var (
	protectedResourceCache sync.Map // resourceURL -> *protectedResourceResult
	authServerCache        sync.Map // issuer      -> *authServerResult
	forServerCache         sync.Map // resourceURL -> *forServerResult
)

// cachedProtectedResource returns the memoized DiscoverProtectedResource result
// for a URL, fetching on the first ask.
func cachedProtectedResource(serverName, resourceURL string, fetch func() (*ProtectedResourceMetadata, error)) (*ProtectedResourceMetadata, error) {
	if v, ok := protectedResourceCache.Load(resourceURL); ok {
		if res, ok := v.(*protectedResourceResult); ok {
			logDiscoveryCacheHit(serverName, "protected-resource", resourceURL, res.err)
			return res.meta, res.err
		}
	}
	meta, err := fetch()
	protectedResourceCache.Store(resourceURL, &protectedResourceResult{meta: meta, err: err})
	return meta, err
}

// cachedAuthServer returns the memoized DiscoverAuthServer result for an
// issuer, fetching on the first ask.
func cachedAuthServer(serverName, issuer string, fetch func() (*ServerMetadata, error)) (*ServerMetadata, error) {
	if v, ok := authServerCache.Load(issuer); ok {
		if res, ok := v.(*authServerResult); ok {
			logDiscoveryCacheHit(serverName, "authorization-server", issuer, res.err)
			return res.meta, res.err
		}
	}
	meta, err := fetch()
	authServerCache.Store(issuer, &authServerResult{meta: meta, err: err})
	return meta, err
}

// cachedForServer returns the memoized DiscoverForServer result for a URL,
// running the two-hop discovery on the first ask.
//
// Memoized at this level as well as at its two constituent hops because the
// composite has its own cost even on inner hits: it re-walks the authorization
// server list and re-joins the scope set. The inner caches stay because login.go
// calls the individual hops directly.
func cachedForServer(serverName, resourceURL string, fetch func() (*ServerMetadata, string, error)) (*ServerMetadata, string, error) {
	if v, ok := forServerCache.Load(resourceURL); ok {
		if res, ok := v.(*forServerResult); ok {
			logDiscoveryCacheHit(serverName, "two-hop", resourceURL, res.err)
			return res.meta, res.scope, res.err
		}
	}
	meta, scope, err := fetch()
	forServerCache.Store(resourceURL, &forServerResult{meta: meta, scope: scope, err: err})
	return meta, scope, err
}

// logDiscoveryCacheHit records that a fetch was avoided. Debug level: on a busy
// daemon this fires on every MCP request, and the operationally interesting
// lines are the misses, which the discovery functions themselves log at Info.
//
// The cached outcome is included because "served a cached FAILURE" is the case
// an operator debugging a broken server needs to see — otherwise a server that
// failed discovery once looks silent rather than known-bad.
func logDiscoveryCacheHit(serverName, hop, key string, cachedErr error) {
	fields := map[string]any{
		"serverName": serverName, "hop": hop, "url": key, "outcome": "success",
	}
	if cachedErr != nil {
		fields["outcome"] = "failure"
		fields["error"] = utils.ErrStr(cachedErr)
	}
	utils.LogWithFields(utils.LevelDebug, "mcp.discovery", "discovery served from cache; no fetch issued", fields)
}

// invalidateDiscovery drops every cached document for a server's URL and
// issuer.
//
// Called from BeginLogin: an interactive login is the moment a previously
// undiscoverable server can become discoverable (a proxy fixed, a URL
// corrected), and it is the one place within a process where re-probing is
// warranted. Without it, a server whose first discovery failed would keep
// serving that failure for the daemon's life and `ion mcp login` could never
// recover it.
//
// Logout deliberately does NOT invalidate: it only removes credentials, and the
// login that follows is what re-probes. Logout also has no server URL to key on.
//
// issuer may be empty when unknown; the URL entry is dropped either way.
func invalidateDiscovery(resourceURL, issuer string) {
	if resourceURL != "" {
		protectedResourceCache.Delete(resourceURL)
		forServerCache.Delete(resourceURL)
	}
	if issuer != "" {
		authServerCache.Delete(issuer)
	}
}

// resetDiscoveryCaches clears every memoized document. Test-only helper: the
// caches are process-global, so a test that leaves entries behind would leak a
// stubbed fixture's answer into the next test.
func resetDiscoveryCaches() {
	protectedResourceCache = sync.Map{}
	authServerCache = sync.Map{}
	forServerCache = sync.Map{}
}
