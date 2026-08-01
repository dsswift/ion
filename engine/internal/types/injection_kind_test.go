package types

import (
	"encoding/json"
	"testing"
)

// TestIsMachineToMachineIsExhaustive is the structural guard that this whole
// type exists to provide.
//
// The recurring defect it prevents: a new injection kind is added, some but not
// all of the places that care about kinds are updated, and the miss is silent.
// Every kind in AllInjectionKinds must appear in an explicit arm of the
// IsMachineToMachine switch. Adding a const without classifying it lands in the
// default arm, which this test detects and fails.
//
// The detection works by construction: the switch's explicit arms are
// enumerated here as data, and any kind in AllInjectionKinds missing from that
// enumeration fails. There is no way to add a kind and keep this green without
// making a deliberate classification decision.
func TestIsMachineToMachineIsExhaustive(t *testing.T) {
	// Every kind that appears in an EXPLICIT arm of the switch, with the value
	// that arm returns. Mirrors IsMachineToMachine's arms deliberately: this is
	// the assertion, not a re-implementation to be kept in sync silently.
	classified := map[InjectionKind]bool{
		InjectionKindNone:                     false,
		InjectionKindAgentCompletion:          true,
		InjectionKindSlashCommand:             true,
		InjectionKindBackgroundTaskCompletion: true,
		InjectionKindCheckIn:                  true,
		InjectionKindRevive:                   true,
		InjectionKindSteer:                    false,
	}

	for _, k := range AllInjectionKinds {
		want, ok := classified[k]
		if !ok {
			t.Errorf("injection kind %q is in AllInjectionKinds but has no explicit arm in "+
				"IsMachineToMachine. Classify it in the switch AND add it to this test's "+
				"`classified` map — falling through to the default arm silently treats a "+
				"machine-authored turn as user-authored.", k)
			continue
		}
		if got := k.IsMachineToMachine(); got != want {
			t.Errorf("InjectionKind(%q).IsMachineToMachine() = %v, want %v", k, got, want)
		}
	}

	// The inverse direction: a kind classified here but dropped from the const
	// set would leave this test asserting on something that no longer exists.
	inAll := make(map[InjectionKind]bool, len(AllInjectionKinds))
	for _, k := range AllInjectionKinds {
		inAll[k] = true
	}
	for k := range classified {
		if !inAll[k] {
			t.Errorf("injection kind %q is classified in this test but missing from "+
				"AllInjectionKinds", k)
		}
	}
}

// TestUnknownInjectionKindIsNotMachineAuthored pins the default arm's choice.
//
// A consumer-defined kind the engine does not recognize must NOT be reported as
// machine authored. Defaulting the other way would let an unrecognized string
// silently hide content in every client that trusts the flag, which is strictly
// worse than showing a turn the consumer did not expect.
func TestUnknownInjectionKindIsNotMachineAuthored(t *testing.T) {
	for _, k := range []InjectionKind{"totally_made_up", "AGENT_COMPLETION", "agent completion"} {
		if k.IsMachineToMachine() {
			t.Errorf("unknown InjectionKind(%q) reported machine-authored; unknown kinds "+
				"must default to user-authored so an unrecognized string cannot hide content", k)
		}
	}
}

// TestInjectionKindRoundTrips verifies each kind survives a JSON round trip
// with its wire string intact. The kind crosses the socket as a bare string, so
// a Go-side rename that did not intend to change the wire value would break
// every consumer matching on it.
func TestInjectionKindRoundTrips(t *testing.T) {
	for _, k := range AllInjectionKinds {
		encoded, err := json.Marshal(k)
		if err != nil {
			t.Fatalf("marshal InjectionKind(%q): %v", k, err)
		}
		var decoded InjectionKind
		if err := json.Unmarshal(encoded, &decoded); err != nil {
			t.Fatalf("unmarshal %s: %v", encoded, err)
		}
		if decoded != k {
			t.Errorf("round trip changed InjectionKind: %q -> %s -> %q", k, encoded, decoded)
		}
		if decoded.String() != string(k) {
			t.Errorf("String() = %q, want %q", decoded.String(), string(k))
		}
	}
}

// TestInjectionKindWireValues pins the exact strings on the wire.
//
// These values are matched by external consumers and by persisted conversation
// rows already on disk. Changing one is a breaking change to the engine wire
// contract, not a refactor — this test makes that explicit rather than letting
// a rename slip through as a green build.
func TestInjectionKindWireValues(t *testing.T) {
	want := map[InjectionKind]string{
		InjectionKindNone:                     "",
		InjectionKindAgentCompletion:          "agent_completion",
		InjectionKindSlashCommand:             "slash_command",
		InjectionKindBackgroundTaskCompletion: "background_task_completion",
		InjectionKindCheckIn:                  "checkin",
		InjectionKindRevive:                   "revive",
		InjectionKindSteer:                    "steer",
	}
	for k, s := range want {
		if string(k) != s {
			t.Errorf("wire value for kind changed: got %q, want %q", string(k), s)
		}
	}
}
