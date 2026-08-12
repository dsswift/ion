package ion

// BuildIdentity is stamped into a compiled Go extension with:
//
//	-X github.com/dsswift/ion/sdk/go.BuildIdentity=<engine-identity>
//
// The init handshake reports it to the engine, which rejects a binary compiled
// against a different engine release. Empty is intentional for development
// builds and older build tooling; the engine allows it with a compatibility
// warning rather than breaking existing extensions.
var BuildIdentity string
