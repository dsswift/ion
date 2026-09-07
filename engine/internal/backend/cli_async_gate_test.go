package backend

import (
	"strings"
	"testing"

	"github.com/dsswift/ion/engine/internal/permissions"
)

// TestAsyncModeDenial_ForegroundPassesUntouched is the arm that keeps the native
// tools usable. Foreground Bash is the most-used tool there is and nothing about
// it is broken; a gate that caught it would recreate the outage the removal
// approach caused.
func TestAsyncModeDenial_ForegroundPassesUntouched(t *testing.T) {
	cases := []struct {
		tool  string
		input map[string]any
	}{
		{"Bash", map[string]any{"command": "make build"}},
		{"Bash", map[string]any{"command": "make build", "run_in_background": false}},
		{"bash", map[string]any{"command": "ls"}},
		{"Agent", map[string]any{"prompt": "do a thing"}},
		{"Read", map[string]any{"file_path": "/tmp/x"}},
		{"Write", map[string]any{"file_path": "/tmp/x", "run_in_background": true}},
	}
	for _, c := range cases {
		if reason, denied := asyncModeDenial(c.tool, c.input); denied {
			t.Errorf("%s%v was denied: %s", c.tool, c.input, reason)
		}
	}
}

// TestAsyncModeDenial_BackgroundBashNamesEngineShell pins the refusal that
// replaces the old blunt removal. The reason must carry the exact tool name the
// model should call: a refusal the model cannot act on is one it can only retry,
// which is what the CLI's own "Bash is disabled for this session" produced.
func TestAsyncModeDenial_BackgroundBashNamesEngineShell(t *testing.T) {
	reason, denied := asyncModeDenial("Bash", map[string]any{"command": "make build", "run_in_background": true})
	if !denied {
		t.Fatal("background Bash was allowed; its task cannot survive the turn")
	}
	want := permissions.EngineMcpToolPrefix + "Bash"
	if !strings.Contains(reason, want) {
		t.Errorf("reason does not name %q: %s", want, reason)
	}
	for _, arg := range []string{"run_in_background", "notify_on_complete"} {
		if !strings.Contains(reason, arg) {
			t.Errorf("reason does not tell the model to pass %s: %s", arg, reason)
		}
	}
	// The model must not conclude the shell is gone. That conclusion is exactly
	// what made the removal approach read as an outage.
	if !strings.Contains(reason, "Foreground Bash is unaffected") {
		t.Errorf("reason does not say foreground Bash still works: %s", reason)
	}
}

// TestAsyncModeDenial_BackgroundAgentNamesIonAgent pins the same shape for
// subagents: the CLI's background Agent cannot deliver a result after the turn,
// and ion_agent can.
func TestAsyncModeDenial_BackgroundAgentNamesIonAgent(t *testing.T) {
	reason, denied := asyncModeDenial("Agent", map[string]any{"prompt": "x", "run_in_background": true})
	if !denied {
		t.Fatal("background Agent was allowed; its result cannot be delivered after the turn")
	}
	if want := permissions.EngineMcpToolPrefix + "ion_agent"; !strings.Contains(reason, want) {
		t.Errorf("reason does not name %q: %s", want, reason)
	}
}

// TestAsyncModeDenial_MonitorHasNoSurvivingMode pins that Monitor is refused
// outright rather than by argument. Reporting events as they happen IS delivery
// after the turn ends, so there is no synchronous mode of it to preserve.
func TestAsyncModeDenial_MonitorHasNoSurvivingMode(t *testing.T) {
	reason, denied := asyncModeDenial("Monitor", map[string]any{"command": "tail -f x.log"})
	if !denied {
		t.Fatal("Monitor was allowed; it cannot deliver events after the turn ends")
	}
	for _, want := range []string{permissions.EngineMcpToolPrefix + "Bash", permissions.EngineMcpToolPrefix + "Poll"} {
		if !strings.Contains(reason, want) {
			t.Errorf("reason does not offer %q as a replacement: %s", want, reason)
		}
	}
}

// TestAsyncModeDenial_BridgedNamesAreNotGated is the loop-closing case. The
// engine's own shell arrives as mcp__ion-extensions__Bash and its whole purpose
// is background work; gating it by the normalized name would refuse the very
// tool the refusal points at.
func TestAsyncModeDenial_BridgedNamesAreNotGated(t *testing.T) {
	// Normalization maps the bridged name to "Bash", so this case proves the
	// gate keys on the name as the CLI sent it for its OWN tools only.
	if _, denied := asyncModeDenial(permissions.EngineMcpToolPrefix+"Bash", map[string]any{
		"command": "make build", "run_in_background": true, "notify_on_complete": true,
	}); denied {
		t.Fatal("the engine's own bridged Bash was refused background mode — it is the replacement")
	}
}

// TestTruthy pins the tolerant read. A model that emits the flag as a string
// must still be caught: allowing it through is a silent return to the broken
// mode this gate closes.
func TestTruthy(t *testing.T) {
	for _, v := range []any{true, "true", "True"} {
		if !truthy(v) {
			t.Errorf("truthy(%#v) = false, want true", v)
		}
	}
	for _, v := range []any{false, "false", "", nil, 0, 1} {
		if truthy(v) {
			t.Errorf("truthy(%#v) = true, want false", v)
		}
	}
}
