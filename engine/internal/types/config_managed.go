package types

// ManagedModeStatus reports how the engine resolved enterprise policy on an
// installation an administrator marked as managed. It is engine-stamped: the
// loader overwrites whatever a policy source carried under this key, so the
// only way to produce one is the managed-mode marker.
//
// A nil status on EnterpriseConfig means the installation is unmanaged.
type ManagedModeStatus struct {
	// Managed is always true on a non-nil status. It is spelled out so a
	// consumer reading the JSON does not have to infer it from presence.
	Managed bool `json:"managed"`
	// PolicyAbsent is true when the marker is present and no machine policy
	// source resolved. The engine refuses every prompt and loads no
	// extensions while this holds.
	PolicyAbsent bool `json:"policyAbsent,omitempty"`
	// OverrideRefused is true when ION_ENTERPRISE_CONFIG was set and ignored
	// because the installation is managed.
	OverrideRefused bool `json:"overrideRefused,omitempty"`
}

// ManagedConfigSource names the managed files an administrator projects over
// the engine and model configuration surfaces. A declared surface is owned in
// full: the managed file is its whole effective configuration, and the user
// and project files contribute nothing to it. An empty path leaves that
// surface to its ordinary layers.
type ManagedConfigSource struct {
	// EnginePath is the absolute path of the managed engine configuration
	// file. It has the engine.json schema.
	EnginePath string `json:"enginePath,omitempty"`
	// ModelsPath is the absolute path of the managed model configuration
	// file. It has the models.json schema.
	ModelsPath string `json:"modelsPath,omitempty"`
	// SchemaVersion is the managed-file schema the files were authored
	// against. The engine refuses a version it does not support.
	SchemaVersion int `json:"schemaVersion"`
	// DisableUserMcpServers turns off the user's own MCP servers on a managed
	// engine surface. By default a user may add servers to a file of their
	// own beside the managed engine file's; with this set, the managed file's
	// servers are the only ones and every MCP server write is refused.
	DisableUserMcpServers bool `json:"disableUserMcpServers,omitempty"`
}

// ManagedConfigStatus reports how the engine resolved a ManagedConfigSource.
// It is engine-stamped: the loader overwrites whatever a policy source
// carried under this key. It never carries configuration content.
//
// A nil status on EnterpriseConfig means no surface is declared.
type ManagedConfigStatus struct {
	// SchemaVersion is the version the source declared.
	SchemaVersion int `json:"schemaVersion"`
	// SupportedSchemaVersion is the version this engine reads.
	SupportedSchemaVersion int `json:"supportedSchemaVersion"`
	// Engine is nil when the source declares no engine file.
	Engine *ManagedSurfaceStatus `json:"engine,omitempty"`
	// Models is nil when the source declares no models file.
	Models *ManagedSurfaceStatus `json:"models,omitempty"`
}

// ManagedSurfaceStatus is one declared surface's outcome. A declared surface
// is owned whether or not its file applied: on an Error the surface resolves
// to built-in defaults, never to the user or project files.
type ManagedSurfaceStatus struct {
	// Projected is true when the managed file was read and applied in full.
	Projected bool `json:"projected"`
	// Checksum is "sha256:<hex>" of the managed file's bytes. Empty when the
	// file could not be read.
	Checksum string `json:"checksum,omitempty"`
	// Error says why the managed file was not applied. Empty when Projected.
	Error string `json:"error,omitempty"`
}
