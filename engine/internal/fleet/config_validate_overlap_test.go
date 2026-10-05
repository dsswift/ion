package fleet

import "testing"

// A host that moved into the server list but still owes the revoke of its
// old pairing is in both lists. That is one host, not a duplicate.
func TestValidate_AllowsAHostStillOwedItsRevoke(t *testing.T) {
	moved := Host{Name: "win", SSH: "user@win.example.org", Kind: KindDesktop}
	if err := (Config{Hosts: []Host{moved}, LegacyHosts: []Host{moved}}).Validate(); err != nil {
		t.Fatalf("a host in both lists was refused: %v", err)
	}
	if err := (Config{Hosts: []Host{moved, moved}}).Validate(); err == nil {
		t.Error("the same name twice in one list was accepted")
	}
}
