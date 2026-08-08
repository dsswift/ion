package types

// ModelTierEntry is one named model-selection tier from ~/.ion/models.json.
// The engine emits complete snapshots of these entries in engine_model_tiers.
// Fallbacks is always a list, including for tiers stored in the legacy string
// form, so consumers can replace their local snapshot without null checks.
type ModelTierEntry struct {
	Name      string   `json:"name"`
	Model     string   `json:"model"`
	Fallbacks []string `json:"fallbacks"`
}
