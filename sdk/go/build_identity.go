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
