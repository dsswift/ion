package ion

import (
	"context"
	"testing"
)

func TestProtectedOperationSendsNameAndPayloadOnly(t *testing.T) {
	fe := newFakeEngine(t, WithName("protected-operation"))
	fe.start()
	fe.doInit(ExtensionConfig{})

	ctx := fe.sdk.newContext(nil)
	resultCh := make(chan ProtectedOperationResult, 1)
	errCh := make(chan error, 1)
	go func() {
		result, err := ctx.ProtectedOperation(context.Background(), "publish-metric", map[string]any{"value": 42})
		if err != nil {
			errCh <- err
			return
		}
		resultCh <- result
	}()

	frame := fe.awaitMethod("ext/protected_operation")
	params, ok := frame["params"].(map[string]any)
	if !ok {
		t.Fatalf("params = %#v", frame["params"])
	}
	payload, ok := params["payload"].(map[string]any)
	if len(params) != 2 || params["name"] != "publish-metric" || !ok || payload["value"] != float64(42) {
		t.Fatalf("request must carry only name and payload: %#v", params)
	}
	id, ok := frame["id"].(float64)
	if !ok {
		t.Fatalf("request id = %#v", frame["id"])
	}
	fe.respond(id, map[string]any{"status": 202, "body": `{"accepted":true}`})

	select {
	case err := <-errCh:
		t.Fatalf("ProtectedOperation: %v", err)
	case result := <-resultCh:
		var decoded struct{ Accepted bool }
		if result.Status != 202 || result.JSON(&decoded) != nil || !decoded.Accepted {
			t.Fatalf("result = %#v", result)
		}
	}
}
