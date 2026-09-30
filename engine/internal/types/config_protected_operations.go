package types

// ProtectedOperationConfig declares one named outbound HTTP operation whose
// credential the engine injects at call time. An extension invokes it by name
// with a payload only: the method, destination, injection slot, and secret
// reference all come from here, so the credential can never be redirected to
// a destination the extension chooses.
type ProtectedOperationConfig struct {
	// Method is the HTTP method. Required.
	Method string `json:"method"`
	// URL is the absolute http(s) destination. Required.
	URL string `json:"url"`
	// SecretReference names the secret and where the engine reads it.
	SecretReference
	// InjectAs is the request slot that receives the secret. Required.
	InjectAs ProtectedOperationInjection `json:"injectAs"`
	// BodySchema is the JSON Schema the extension's payload must satisfy
	// before dispatch. Required; `{}` accepts any payload.
	BodySchema map[string]any `json:"bodySchema"`
	// Headers are fixed request headers sent on every call. The injected
	// header wins over an entry of the same name.
	Headers map[string]string `json:"headers,omitempty"`
	// TimeoutMs bounds the request; <= 0 selects the 30 s default.
	TimeoutMs int64 `json:"timeoutMs,omitempty"`
	// MaxBytes caps the response body; <= 0 selects the 5 MB default.
	MaxBytes int64 `json:"maxBytes,omitempty"`
	// AllowPrivateNetwork permits a private or reserved destination address.
	// Default false.
	AllowPrivateNetwork bool `json:"allowPrivateNetwork,omitempty"`
}

// ProtectedOperationInjection names exactly one request slot for the secret.
type ProtectedOperationInjection struct {
	// Header is the request header name that carries the secret.
	Header string `json:"header,omitempty"`
	// Query is the query parameter name that carries the secret.
	Query string `json:"query,omitempty"`
	// Prefix is prepended to the secret in the slot (e.g. "Bearer ").
	Prefix string `json:"prefix,omitempty"`
}

// Secret sources a SecretReference may name.
const (
	// SecretSourceCredentialStore reads the engine's encrypted credential
	// store, the store the store_credential command writes. The default.
	SecretSourceCredentialStore = "credentialStore"
	// SecretSourceApplicationConfig reads a secret from the in-memory
	// application config: the common section's secrets, overlaid by the
	// calling extension's own section.
	SecretSourceApplicationConfig = "applicationConfig"
)

// SecretReference names a secret by reference, never by value. The engine
// resolves it at the moment of use, so a rotated value takes effect on the
// next call.
type SecretReference struct {
	// SecretRef is the credential-store entry name or application config
	// key. Required.
	SecretRef string `json:"secretRef"`
	// SecretSource selects where SecretRef is read: "credentialStore"
	// (default) or "applicationConfig".
	SecretSource string `json:"secretSource,omitempty"`
}
