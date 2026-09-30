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
	// SecretRef names the credential-store entry holding the secret, the same
	// store the store_credential command writes. Required.
	SecretRef string `json:"secretRef"`
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
