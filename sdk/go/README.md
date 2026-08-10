# Ion Go SDK

Build Ion Engine extensions as compiled single-binary executables.

```bash
go get github.com/dsswift/ion/sdk/go
```

Full authoring guide: [`docs/extensions/sdk-go.md`](../../docs/extensions/sdk-go.md).

## Running the tests from this directory

The parity tests read the engine's generated contract manifest at
`../../engine/internal/extension/testdata/sdk_contract.json`, so this module is
tested from a full Ion checkout rather than from a bare copy of `sdk/go`. That
is deliberate: the alternative is a vendored copy of the manifest, which can
drift from the original and would defeat the point of the check.

```bash
go test -race ./...
```

Regenerating the goldens:

```bash
cd engine && go test ./internal/extension/ -run TestSDKContractManifest -update
cd sdk/go && go test -run TestGoSDKSurfaceManifest -update
```

## What is not here

The engine's `install-assets` step never copies this module anywhere. Unlike
the TypeScript SDK, which is installed to `~/.ion/extensions/sdk/ion-sdk/`, the
Go SDK is consumed as a normal Go module resolved by `go get`.
