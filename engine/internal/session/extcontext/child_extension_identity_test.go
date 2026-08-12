package extcontext

import (
	"testing"

	"github.com/dsswift/ion/engine/internal/extension"
)

type buildIdentityAccessor struct {
	noopSA
	identity string
}

func (a buildIdentityAccessor) EngineBuildIdentity() string { return a.identity }

func TestNewChildExtensionHost_PropagatesBuildIdentity(t *testing.T) {
	accessor := buildIdentityAccessor{identity: "engine-build-test"}
	host, config := newChildExtensionHost(accessor, &extension.DispatchAgentOpts{
		ExtensionDir: "/tmp/child-extension",
	}, "child-model", "/tmp/project")

	if got := host.EngineBuildIdentity(); got != accessor.identity {
		t.Errorf("host build identity = %q, want %q", got, accessor.identity)
	}
	if got := config.BuildIdentity; got != accessor.identity {
		t.Errorf("config build identity = %q, want %q", got, accessor.identity)
	}
}
