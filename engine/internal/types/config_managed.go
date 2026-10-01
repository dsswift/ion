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
