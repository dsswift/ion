package ion

import (
	"context"
	"testing"
)

func TestSendPromptCarriesSlashModelTierOverride(t *testing.T) {
	fe := newFakeEngine(t, WithName("send-prompt-boundary-test"))
	fe.start()
	fe.doInit(ExtensionConfig{})

	allow := true
	errCh := make(chan error, 1)
	go func() {
		errCh <- fe.sdk.newContext(nil).SendPrompt(context.Background(), "/review", SendPromptOpts{
			SlashModelTierApplyMidConversation: &allow,
		})
	}()

	frame := fe.awaitMethod("ext/send_prompt")
	params, ok := frame["params"].(map[string]any)
	if !ok {
		t.Fatalf("params = %#v", frame["params"])
	}
	if got, ok := params["slashModelTierApplyMidConversation"].(bool); !ok || !got {
		t.Fatalf("slashModelTierApplyMidConversation = %#v, want true", params["slashModelTierApplyMidConversation"])
	}
	id, ok := frame["id"].(float64)
	if !ok {
		t.Fatalf("request id = %#v", frame["id"])
	}
	fe.respond(id, map[string]any{"ok": true})
	if err := <-errCh; err != nil {
		t.Fatalf("SendPrompt: %v", err)
	}
}
