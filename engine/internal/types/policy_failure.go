package types

// policy_failure.go — Policy Failure identifiers: the stable names of the
// failure states that result from enterprise policy, and the error type that
// carries one.
//
// An identifier is published contract. It is the key of
// EnterpriseConfig.Messages and the value of the policyFailure field on the
// surfaces that report the failure. Never rename or remove one; add new ones
// here and to PolicyFailureIDs.
const (
	// PolicyFailureModelNotAllowed: a prompt was refused because its model is
	// outside allowedModels or inside blockedModels.
	PolicyFailureModelNotAllowed = "model_not_allowed"
	// PolicyFailureProviderNotAuthorized: a run ended because its model names
	// a provider that allowedProviders removed from the configuration.
	PolicyFailureProviderNotAuthorized = "provider_not_authorized"
	// PolicyFailureExtensionBlocked: an extension did not load because the
	// extension allowlist excludes it or its pinned hash did not match.
	PolicyFailureExtensionBlocked = "extension_blocked"
	// PolicyFailureToolBlocked: a tool call was refused by toolRestrictions.
	PolicyFailureToolBlocked = "tool_blocked"
	// PolicyFailureMcpServerBlocked: an MCP server was refused by mcpDenylist
	// or mcpAllowlist when it was added or changed.
	PolicyFailureMcpServerBlocked = "mcp_server_blocked"
	// PolicyFailureProfileLocked: a session was refused because the locked
	// profile that newConversationDefaults names is not configured on the host.
	PolicyFailureProfileLocked = "profile_locked"
	// PolicyFailureManagedPolicyAbsent: a prompt was refused because the
	// installation is marked managed and no machine policy resolved.
	PolicyFailureManagedPolicyAbsent = "managed_policy_absent"
	// PolicyFailureAuthenticationFailed: a sign-in could not start, or a
	// session was refused because the required operator identity is missing.
	PolicyFailureAuthenticationFailed = "authentication_failed"
	// PolicyFailureSubscriptionUnavailable: the Provider Subscription lookup
	// returned no subscription for the signed-in identity.
	PolicyFailureSubscriptionUnavailable = "subscription_unavailable"
	// PolicyFailureSubscriptionLookupFailed: the Provider Subscription lookup
	// failed and no cached key exists.
	PolicyFailureSubscriptionLookupFailed = "subscription_lookup_failed"
)

// PolicyFailureIDs lists every identifier the engine reports. A key of
// EnterpriseConfig.Messages outside this list is not an error: the map is
// passed through to consumers, which may define identifiers of their own.
var PolicyFailureIDs = []string{
	PolicyFailureModelNotAllowed,
	PolicyFailureProviderNotAuthorized,
	PolicyFailureExtensionBlocked,
	PolicyFailureToolBlocked,
	PolicyFailureMcpServerBlocked,
	PolicyFailureProfileLocked,
	PolicyFailureManagedPolicyAbsent,
	PolicyFailureAuthenticationFailed,
	PolicyFailureSubscriptionUnavailable,
	PolicyFailureSubscriptionLookupFailed,
}

// PolicyError is a failure that results from enterprise policy. Message is
// the text to show: the configured replacement when EnterpriseConfig.Messages
// has one for Failure, the engine default otherwise. Cause is the engine's
// own error and stays reachable through errors.Is and errors.As, so the
// replacement text never changes how a caller classifies the failure.
type PolicyError struct {
	Failure string
	Message string
	Cause   error
}

func (e *PolicyError) Error() string { return e.Message }

func (e *PolicyError) Unwrap() error { return e.Cause }
