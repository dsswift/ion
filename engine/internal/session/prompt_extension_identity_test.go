package session

import "testing"

func TestNewPerPromptExtensionHost_PropagatesBuildIdentity(t *testing.T) {
	identity := "release-build-id"
	host, config := newPerPromptExtensionHost(identity, "/tmp/example/index.ts", "/tmp/project")

	if got := host.EngineBuildIdentity(); got != identity {
		t.Errorf("host identity = %q, want %q", got, identity)
	}
	if got := config.BuildIdentity; got != identity {
		t.Errorf("config identity = %q, want %q", got, identity)
	}
	if got := config.ExtensionDir; got != "/tmp/example" {
		t.Errorf("extension directory = %q, want /tmp/example", got)
	}
}
