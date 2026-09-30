package protocol

import "testing"

func TestParseClientCommand_ProviderSubscription(t *testing.T) {
	for _, name := range []string{"provider_subscription_status", "provider_subscription_refresh"} {
		if cmd := ParseClientCommand(`{"cmd":"` + name + `","requestId":"r"}`); cmd == nil || cmd.Cmd != name {
			t.Fatalf("%s did not parse: %+v", name, cmd)
		}
	}
	cmd := ParseClientCommand(`{"cmd":"provider_subscription_select","requestId":"r","subscriptionId":"prem"}`)
	if cmd == nil || cmd.SubscriptionID != "prem" {
		t.Fatalf("select did not decode subscriptionId: %+v", cmd)
	}
	if cmd := ParseClientCommand(`{"cmd":"provider_subscription_select","requestId":"r"}`); cmd != nil {
		t.Fatal("select without subscriptionId accepted")
	}
}
