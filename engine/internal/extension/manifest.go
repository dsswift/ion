package extension

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"

	"github.com/dsswift/ion/engine/internal/utils"
)

// Manifest is the optional `extension.json` sibling of an extension's entry
// point. It declares per-extension build/load configuration that the engine
// honors when loading the extension.
//
// Schema is intentionally tight; unknown top-level keys are rejected to keep
// the surface predictable. Each field has well-defined defaults so the
// manifest is optional in practice.
type Manifest struct {
	// Name is the display name used in logs and event source attribution.
	// Empty defaults to the parent directory name.
	Name string `json:"name,omitempty"`

	// Version is an optional semver string (e.g. "1.2.0") identifying this
	// extension release. Used for cost attribution (extension_version in
	// telemetry context) so operators can distinguish spend across releases.
	// Semver is conventional, not enforced. Omit-when-absent: old engines
	// that use DisallowUnknownFields will REJECT manifests carrying this field
	// — extension authors should only add it once their minimum engine version
	// includes this change.
	Version string `json:"version,omitempty"`

	// External lists package names that should NOT be bundled by esbuild.
	// Each entry becomes a `--external:<name>` flag. Use for native modules
	// (`.node` files like keytar) and any package the extension explicitly
	// wants to keep out of the bundle. Externals are resolved at runtime
	// from `<extDir>/node_modules` (the engine sets NODE_PATH accordingly).
	External []string `json:"external,omitempty"`

	// EngineVersion is an optional semver range (e.g. ">=0.5.0"). Reserved
	// for future use; the engine does not currently enforce this constraint.
	EngineVersion string `json:"engineVersion,omitempty"`
}

// LoadManifest reads `<extDir>/extension.json` if present. Returns
// (nil, nil) when the file does not exist (manifest is optional). Returns
// an error for parse failures or unknown top-level keys.
func LoadManifest(extDir string) (*Manifest, error) {
	path := filepath.Join(extDir, "extension.json")
	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, fmt.Errorf("read %s: %w", path, err)
	}

	dec := json.NewDecoder(bytes.NewReader(data))
	dec.DisallowUnknownFields()

	var m Manifest
	if err := dec.Decode(&m); err != nil {
		return nil, fmt.Errorf("parse %s: %w", path, err)
	}

	utils.LogWithFields(utils.LevelInfo, "extension", "loaded manifest from ()", map[string]any{"path": path, "count": len(m.External)})
	return &m, nil
}
