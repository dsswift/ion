package extcontext

import "github.com/dsswift/ion/engine/internal/extension"

// newChildExtensionHost creates a child host with the same engine build
// identity as its parent session. Both Host and ExtensionConfig carry identity:
// Host validates the child SDK init handshake, while config preserves identity
// for extension code that reads its launch configuration.
func newChildExtensionHost(
	sa SessionAccessor,
	opts *extension.DispatchAgentOpts,
	model string,
	projectPath string,
) (*extension.Host, *extension.ExtensionConfig) {
	buildIdentity := sa.EngineBuildIdentity()
	host := extension.NewHost()
	host.SetEngineBuildIdentity(buildIdentity)
	return host, &extension.ExtensionConfig{
		ExtensionDir:     opts.ExtensionDir,
		Model:            model,
		WorkingDirectory: projectPath,
		BuildIdentity:    buildIdentity,
	}
}
