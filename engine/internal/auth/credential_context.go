package auth

import (
	"context"
	"fmt"
	"net/http"
	"strings"
	"sync"

	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

// ErrPrincipalCredentialUnresolved is returned by CredentialContext.Authenticator
// when an attributed principal has no resolvable credential and fall-through
// policy refuses to serve the process-wide levels instead (child 04's refusal
// mode). Wrapped by providers.NewPrincipalCredentialError into the typed,
// non-retryable request-time error (SC-4); this sentinel is what the policy
// layer itself returns before that wrapping happens.
var ErrPrincipalCredentialUnresolved = fmt.Errorf("no credential resolved for the acting principal")

// FallThroughPolicy decides whether resolution may fall through to the
// process-wide resolver levels when no registered PrincipalCredentialSource
// answered for subject. Child 04 supplies the real tenancy-derived policy;
// this child depends only on the interface, so it carries no dependency on
// child 04's implementation.
type FallThroughPolicy interface {
	AllowFallThrough(subject string) bool
}

// allowAllFallThrough is the default policy used until child 04 registers a
// tenancy-derived one: every subject may fall through, which is today's
// single-instance behavior (no partitioning configured means no refusal).
type allowAllFallThrough struct{}

func (allowAllFallThrough) AllowFallThrough(string) bool { return true }

// authHeaderDefaults names the header style each built-in provider's own
// constructor defaults to before any per-principal source or config override
// applies. Consulted only by resolverAuthenticator -- the process-wide
// fallback used for an unattributed run or a fall-through attributed one --
// so that path's outbound header matches its pre-existing behavior byte for
// byte (R-10). A principal source's own authenticator carries its own header
// choice and never consults this map. Populated at ApplyConfig time via
// RegisterProviderAuthHeader (providers package, which cannot be imported
// here without a cycle) so a custom gateway's configured AuthHeader is
// honored on the resolver-fallback path exactly as it is on the request path.
var (
	authHeaderMu       sync.RWMutex
	authHeaderOverride = map[string]string{}
)

// authHeaderBuiltinDefaults are the built-in providers' own hardcoded header
// styles, used when no override was registered for that provider id.
// "urlkey" is Google's native Gemini default: the key rides the `?key=`
// query parameter rather than a header, exactly as googleProvider's own
// constructor defaulted before this program (R-10).
var authHeaderBuiltinDefaults = map[string]string{
	"anthropic": "x-api-key",
	"openai":    "bearer",
	"foundry":   "x-api-key", // constructed via NewAnthropicProvider
	"vertex":    "bearer",
	"google":    "urlkey",
}

// RegisterProviderAuthHeader records the header style a provider was
// constructed with (its configured AuthHeader override, or its own default),
// so authHeaderFor can answer correctly for a custom-baseURL/gateway provider
// on the resolver-fallback path. Called from providers.ApplyConfig and from
// each built-in constructor's init-time registration; an empty header clears
// any prior override for that id.
func RegisterProviderAuthHeader(providerID, header string) {
	authHeaderMu.Lock()
	defer authHeaderMu.Unlock()
	id := strings.ToLower(providerID)
	if header == "" {
		delete(authHeaderOverride, id)
		return
	}
	authHeaderOverride[id] = header
}

// authHeaderFor returns the header style the resolver-fallback authenticator
// should use for providerID: a registered override first, then the built-in
// default, then "bearer" -- the OpenAI-compatible family's own default.
func authHeaderFor(providerID string) string {
	id := strings.ToLower(providerID)
	authHeaderMu.RLock()
	h, ok := authHeaderOverride[id]
	authHeaderMu.RUnlock()
	if ok {
		return h
	}
	if h, ok := authHeaderBuiltinDefaults[id]; ok {
		return h
	}
	return "bearer"
}

// staticKeyAuthenticator wraps one already-resolved key so it can travel as a
// RequestAuthenticator. The key is captured at construction and never
// returned to a caller -- only Authenticate ever touches it, and it applies
// the key to the request via the same setAuthHeader-equivalent logic every
// provider used to run itself.
type staticKeyAuthenticator struct {
	key    string
	header string
}

// NewStaticKeyAuthenticator wraps an already-resolved key + header style as
// a RequestAuthenticator. Exported for external PrincipalCredentialSource
// implementations (e.g. session.clientCredentialSource, child 09's
// engine-asks-client-answers bridge) that resolve a credential value outside
// this package and need to hand back a RequestAuthenticator rather than a
// raw string (R-06: a source's Resolve return type makes a raw-key leak
// structurally impossible).
func NewStaticKeyAuthenticator(key, header string) RequestAuthenticator {
	return staticKeyAuthenticator{key: key, header: header}
}

func (a staticKeyAuthenticator) Authenticate(_ context.Context, req *http.Request, _ []byte) error {
	if a.key == "" {
		utils.LogWithFields(utils.LevelWarn, "auth", "static key authenticator invoked with empty key", map[string]any{"path": req.URL.Host})
	}
	switch strings.ToLower(a.header) {
	case "bearer", "":
		req.Header.Set("Authorization", "Bearer "+a.key)
	case "x-api-key":
		req.Header.Set("x-api-key", a.key)
	case "api-key":
		req.Header.Set("api-key", a.key)
	case "urlkey":
		// Google's native Gemini default: the key rides the ?key= query
		// parameter rather than a header (R-10 byte-for-byte compat with
		// googleProvider's pre-existing key-in-url behavior).
		q := req.URL.Query()
		q.Set("key", a.key)
		req.URL.RawQuery = q.Encode()
	default:
		req.Header.Set(a.header, a.key)
	}
	return nil
}

// resolverAuthenticator wraps the resolver's existing five-level ResolveKey
// chain in a RequestAuthenticator, so the legacy levels produce the same
// return type as a principal source. The key is captured inside the returned
// authenticator and never handed back to the caller (R-06).
func resolverAuthenticator(r *Resolver, providerID, authHeader string) (RequestAuthenticator, error) {
	key, err := r.ResolveKey(providerID)
	if err != nil || key == "" {
		return nil, err
	}
	return staticKeyAuthenticator{key: key, header: authHeader}, nil
}

// CredentialContext is the per-principal value threaded through resolution,
// discovery, and one run (SC-2). It replaces the deleted process-global
// credential state (R-15): it is built per run and passed explicitly, never
// assigned to a package-level variable.
type CredentialContext struct {
	// Principal is the acting principal, or nil for an unattributed run.
	Principal *types.SessionPrincipal
	// Authenticator resolves the acting principal's authenticator for a
	// provider: registered PrincipalCredentialSources first (in registration
	// order), then the resolver's five levels subject to fall-through policy.
	// Never returns a raw credential.
	Authenticator func(ctx context.Context, providerID string) (RequestAuthenticator, error)
	// Entitlement is the principal's discovered model-id set for a provider.
	// nil (the zero value) means "not yet discovered"; child 05 populates
	// this. A non-nil empty set means "entitled to nothing".
	Entitlement func(providerID string) []string
	// requiresPrincipalCredential caches whether this run's fall-through
	// policy would refuse an attributed principal with no resolvable
	// credential -- computed once at construction from the same policy the
	// Authenticator closure captures, so routing (R-40, hybrid_routing.go)
	// can ask "would the API path refuse this principal" without invoking
	// Authenticator and risking a real credential resolution as a side
	// effect of a routing decision.
	requiresPrincipalCredential bool
	// resolver and policy are retained (never exported) so HasCredential can
	// answer the same question Authenticator does -- whether a credential
	// exists, without resolving or returning one -- for capability listing
	// (child 06, R-13) and future callers, with no separate resolver/policy
	// plumbing required at every call site.
	resolver *Resolver
	policy   FallThroughPolicy
}

// RequiresPrincipalCredential reports whether this run's principal would be
// refused (not merely fall through) if no PrincipalCredentialSource answers
// for it -- i.e. whether the acting principal is attributed AND this run's
// fall-through policy requires a resolvable credential for it. Used by
// hybrid routing (R-40) to keep the delegated-CLI back door closed for
// exactly the principals the API path itself would refuse, and by nothing
// else: it never resolves a credential and has no side effects.
func (c *CredentialContext) RequiresPrincipalCredential() bool {
	if c == nil {
		return false
	}
	return c.requiresPrincipalCredential
}

// Subject returns "" for a nil receiver or a nil Principal, which is the
// unattributed partition key used everywhere in this program.
func (c *CredentialContext) Subject() string {
	if c == nil || c.Principal == nil {
		return ""
	}
	return c.Principal.Subject
}

// HasCredential reports whether the acting principal has a credential
// available for providerID right now, and names its source -- the
// principal-aware counterpart to Resolver.HasKey (child 06, R-13). It answers
// the exact same question routing (RequiresPrincipalCredential,
// EffectiveBackendForProvider) and capability listing (buildProviderEntries)
// both need, so a provider entry's HasAuth and the backend the next run picks
// never disagree.
//
// It never resolves a credential merely to answer the question when the
// fall-through policy would refuse: that branch mirrors the Authenticator
// closure's refusal check but stops at "false", producing no request-time
// error and no discovery side effect.
func (c *CredentialContext) HasCredential(ctx context.Context, providerID string) (bool, string) {
	if c == nil {
		return false, ""
	}
	subject := c.Subject()
	policy := c.policy
	if policy == nil {
		policy = allowAllFallThrough{}
	}
	scope := CredentialScope{Subject: subject, Provider: providerID}
	if a, src, err := ResolvePrincipalCredential(ctx, scope); err == nil && a != nil {
		return true, src
	}
	if subject != "" && !policy.AllowFallThrough(subject) {
		utils.LogWithFields(utils.LevelDebug, "auth", "has credential: fall-through refused", map[string]any{
			"subject": subject, "provider": providerID,
		})
		return false, ""
	}
	if c.resolver == nil {
		return false, ""
	}
	return c.resolver.HasKeyForSubject(subject, providerID)
}

// NewCredentialContext builds a CredentialContext for one run. policy decides
// whether an unresolved principal may fall through to the resolver's process-
// wide levels; pass allowAllFallThrough{} (the zero-value default) until
// child 04 supplies the tenancy-derived one.
func NewCredentialContext(principal *types.SessionPrincipal, r *Resolver, policy FallThroughPolicy) *CredentialContext {
	if policy == nil {
		policy = allowAllFallThrough{}
	}
	cc := &CredentialContext{Principal: principal, resolver: r, policy: policy}
	subject := cc.Subject()
	// Computed once, from the same policy the Authenticator closure below
	// captures: an attributed principal (subject != "") whose fall-through
	// policy refuses is exactly the "would be refused with no source" case
	// routing needs to know about (R-40) -- without triggering resolution.
	cc.requiresPrincipalCredential = subject != "" && !policy.AllowFallThrough(subject)

	cc.Authenticator = func(ctx context.Context, providerID string) (RequestAuthenticator, error) {
		scope := CredentialScope{Subject: subject, Provider: providerID}
		if a, _, err := ResolvePrincipalCredential(ctx, scope); err == nil && a != nil {
			return a, nil
		}
		if !policy.AllowFallThrough(subject) {
			utils.LogWithFields(utils.LevelInfo, "auth", "credential context: fall-through refused", map[string]any{
				"subject": subject, "provider": providerID,
			})
			return nil, ErrPrincipalCredentialUnresolved
		}
		return resolverAuthenticator(r, providerID, authHeaderFor(providerID))
	}
	return cc
}
