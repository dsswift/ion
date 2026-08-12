package session

import (
	"path/filepath"

	"github.com/dsswift/ion/engine/internal/extension"
)

// newPerPromptExtensionHost applies the same engine identity to per-prompt
// hosts as startup-loaded and dispatched-child hosts. Keeping this construction
// at one seam prevents a new host mode from silently bypassing init validation.
func newPerPromptExtensionHost(buildIdentity, extensionPath, workingDirectory string) (*extension.Host, *extension.ExtensionConfig) {
	host := extension.NewHost()
	host.SetEngineBuildIdentity(buildIdentity)
	return host, &extension.ExtensionConfig{
		ExtensionDir:     filepath.Dir(extensionPath),
		WorkingDirectory: workingDirectory,
		BuildIdentity:    buildIdentity,
	}
}
