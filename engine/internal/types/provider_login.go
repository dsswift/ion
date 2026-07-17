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
	ProviderLoginCompleted       = "completed"
	ProviderLoginFailed          = "failed"
	ProviderLoginCancelled       = "cancelled"
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
