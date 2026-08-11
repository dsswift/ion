// Nested module so the go-canary is excluded from the engine module's build
// and test sweeps: it is a test fixture, not engine code.
//
// The replace directive points at the in-repo SDK so the canary always
// exercises the working tree rather than a published version. An external
// extension author writes the same require line without the replace.
module github.com/dsswift/ion/engine/extensions/go-canary

go 1.25.0

require github.com/dsswift/ion/sdk/go v0.0.0

replace github.com/dsswift/ion/sdk/go => ../../../sdk/go
