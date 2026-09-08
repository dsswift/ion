package tools

import (
	"runtime"
	"strings"
	"testing"
)

// A Windows diagnostic run reported "Bash tool is actually PowerShell, not
// POSIX bash" as its top finding, after spending tool calls discovering that
// uname/which/&& do not work. ShellConfig.Resolve had always run PowerShell
// there; the description simply never said so.
func TestBashDescriptionNamesTheRealInterpreter(t *testing.T) {
	desc := bashToolDescription()
	param := bashCommandDescription()

	if runtime.GOOS == "windows" {
		if !strings.Contains(desc, "PowerShell") {
			t.Errorf("description does not name PowerShell:\n%s", desc)
		}
		// The version is load-bearing. Bare `powershell` is always Windows
		// PowerShell 5.1, never pwsh 7 -- even on a machine carrying both
		// (measured: 5.1.26100 and 7.6.5 side by side). A model that assumes 7
		// writes a ternary and gets "Unexpected token '?'", which reads as a
		// broken tool rather than a version mismatch.
		if !strings.Contains(desc, "5.1") {
			t.Errorf("description does not pin the PowerShell version:\n%s", desc)
		}
		if !strings.Contains(desc, "pwsh") {
			t.Errorf("description does not distinguish pwsh 7:\n%s", desc)
		}
		// Naming the constructs is what makes the version actionable; "use 5.1
		// syntax" alone does not tell a model which of its habits are illegal.
		for _, construct := range []string{"ternary", "?.", "-AsHashtable"} {
			if !strings.Contains(desc, construct) {
				t.Errorf("description does not name the 7-only construct %q:\n%s", construct, desc)
			}
		}
		if strings.Contains(desc, "Execute a bash command") {
			t.Errorf("description still claims bash:\n%s", desc)
		}
		if !strings.Contains(param, "PowerShell") {
			t.Errorf("command parameter does not name PowerShell: %s", param)
		}
		if !strings.Contains(param, "5.1") {
			t.Errorf("command parameter does not pin the version: %s", param)
		}
		return
	}

	if !strings.Contains(desc, "bash") {
		t.Errorf("description does not name bash:\n%s", desc)
	}
	if strings.Contains(desc, "PowerShell") {
		t.Errorf("non-Windows description mentions PowerShell:\n%s", desc)
	}
}

// The contract prose that is platform-independent must survive on both, or
// fixing the shell name would silently drop the sleep/background guidance.
func TestBashDescriptionKeepsSharedContract(t *testing.T) {
	desc := bashToolDescription()
	for _, want := range []string{
		"Bare sleep commands",
		"run_in_background with notify_on_complete",
		"Poll only for inference-driven",
	} {
		if !strings.Contains(desc, want) {
			t.Errorf("shared contract prose lost %q:\n%s", want, desc)
		}
	}
}

// A Windows diagnostic reported "Read returns stale content after Edit" twice
// and diagnosed it as a cache both times. It is not: Read calls os.ReadFile on
// every invocation, and the transcript showed the Edit and the Read carrying
// the SAME assistant-block timestamp -- executeTools runs a block's calls in
// parallel via errgroup, so the Read never ran "after" the Edit at all.
//
// The engine behaved correctly; the tool description did not say enough for a
// caller to avoid the race. This pins the warning, because losing it invites
// the same misdiagnosis.
func TestReadDescriptionWarnsAboutParallelBatching(t *testing.T) {
	desc := ReadTool().Description

	if !strings.Contains(desc, "no cache") {
		t.Errorf("description does not rule out a cache:\n%s", desc)
	}
	if !strings.Contains(desc, "PARALLEL") {
		t.Errorf("description does not say tool calls in one block run in parallel:\n%s", desc)
	}
	if !strings.Contains(desc, "LATER block") {
		t.Errorf("description does not give the remedy:\n%s", desc)
	}
}
