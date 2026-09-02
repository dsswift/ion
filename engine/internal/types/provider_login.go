package types

// EventProviderLogin is the engine wire event for provider CLI login lifecycle.
// It is incremental: each emission is one stage transition (see
// ProviderLoginUpdate.Stage). Delivered to the client that issued
// provider_login and broadcast on completion so every client refreshes.
const EventProviderLogin = "engine_provider_login"

// Provider login stages.
const (
	ProviderLoginStarted         = "started"
	ProviderLoginAwaitBrowser    = "await_browser"
	ProviderLoginAwaitDeviceCode = "await_device_code"
	// ProviderLoginAwaitAuthCode means the CLI can accept an authorization code
	// the user obtained in the browser. Unlike await_device_code (where the user
	// types a code the CLI generated into a verification page), here the code
	// flows the other direction: the provider issues it to the user, who can
	// return it to the engine via the provider_login_code command.
	//
	// Emitted by flows that offer a CLI's manual-paste fallback
	// (claude-code): the CLI has already opened a loopback-callback tab and
	// also prints a fallback URL. The engine observes the child process, so
	// either the loopback callback can finish the login or the user can return
	// the fallback code through provider_login_code.
	ProviderLoginAwaitAuthCode = "await_auth_code"
	ProviderLoginCompleted     = "completed"
	ProviderLoginFailed        = "failed"
	ProviderLoginCancelled     = "cancelled"
)

// ProviderLoginUpdate is the payload of an engine_provider_login event. It
// carries one stage transition of a delegated-CLI login. Tracked by contract
// sync.
type ProviderLoginUpdate struct {
	// Provider is the provider whose CLI is authenticating (e.g. "openai").
	Provider string `json:"provider"`
	// Backend is the CLI backend kind driving the login (e.g. "codex").
	Backend string `json:"backend"`
	// Stage is the lifecycle stage: one of the ProviderLogin* constants.
	Stage string `json:"stage"`
	// AuthURL is the browser URL to open (await_browser).
	AuthURL string `json:"authUrl,omitempty"`
	// UserCode is the device code the user enters (await_device_code).
	UserCode string `json:"userCode,omitempty"`
	// VerificationURL is where the user enters the device code
	// (await_device_code).
	VerificationURL string `json:"verificationUrl,omitempty"`
	// LoginError is the failure reason (failed).
	LoginError string `json:"loginError,omitempty"`
	// LoginID is the CLI's login handle, usable to cancel the flow.
	LoginID string `json:"loginId,omitempty"`
}
