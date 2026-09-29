package ion

// BuildIdentity is stamped into a compiled Go extension with:
//
//	-X github.com/dsswift/ion/sdk/go.BuildIdentity=<engine-identity>
//
// The init handshake reports it to the engine as provenance. A mismatch is NOT
// fatal: the engine logs one warning and runs the extension anyway, resolving
// compatibility per RPC by whether a method actually exists rather than by
// commit equality (Host.observeBuildIdentity,
// engine/internal/extension/host_transpile.go). An independently deployed
// extension compiled against an older or newer SDK is an expected, supported
// state — which is what makes an engine upgrade alone no reason to rebuild an
// extension.
//
// Empty is equally fine, and is what a development build or older build tooling
// reports; it warns and proceeds on the same per-RPC basis.
var BuildIdentity string

// Version is the extension's own version, stamped into a compiled Go
// extension with:
//
//	-X github.com/dsswift/ion/sdk/go.Version=<extension-version>
//
// A compiled Go extension has no extension.json for the engine to read at
// load time, so the init handshake is its only way to report a version.
// The engine prefers this over any manifest value
// (Host.applyHandshakeVersion, engine/internal/extension/host_transpile.go).
//
// Empty is fine and is what an unstamped build reports; the engine falls back
// to the manifest version, or leaves the extension unversioned in telemetry.
var Version string
