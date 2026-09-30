package extension

import (
	"testing"
	"time"
)

// TestProtectedOperationRPCStampsTrustedID pins that the host, not the
// caller, sets the extension identity a protected operation reads secrets
// for: a forged identity in the request is ignored.
func TestProtectedOperationRPCStampsTrustedID(t *testing.T) {
	h := &Host{name: "orion-extension"}
	h.SetTrustedIDForTest("orion")
	got := make(chan ProtectedOperationParams, 1)
	ctx := &Context{ProtectedOperation: func(params ProtectedOperationParams) (*ProtectedOperationResult, error) {
		got <- params
		return &ProtectedOperationResult{Status: 200}, nil
	}}

	h.rpcProtectedOperation(ctx, 1, []byte(`{"params":{"name":"gateway","payload":{"v":1},"extensionID":"other","ExtensionID":"other"}}`))

	select {
	case params := <-got:
		if params.ExtensionID != "orion" || params.Name != "gateway" || string(params.Payload) != `{"v":1}` {
			t.Fatalf("params = %+v", params)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("protected operation never ran")
	}
}
