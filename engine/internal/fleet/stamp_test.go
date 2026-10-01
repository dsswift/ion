package fleet

import (
	"bytes"
	"context"
	"errors"
	"os/exec"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestStampWriter_StampsEachLineAndWritesPromptsThrough(t *testing.T) {
	var out bytes.Buffer
	sw := newStampWriter(&out)
	sw.now = func() time.Time { return time.Date(2026, 10, 1, 15, 33, 38, 0, time.UTC) }
	sw.start = sw.now().Add(-90 * time.Second)
	sw.Write([]byte("one\ntwo\n\nPassword: ")) //nolint:errcheck // test capture
	sw.Write([]byte("typed\n"))                //nolint:errcheck // test capture
	want := "[15:33:38 +1m30s] one\n[15:33:38 +1m30s] two\n\n[15:33:38 +1m30s] Password: typed\n"
	if out.String() != want {
		t.Errorf("got %q want %q", out.String(), want)
	}
}

func TestStampWriter_NotesDoNotCountAsOutput(t *testing.T) {
	var out bytes.Buffer
	sw := newStampWriter(&out)
	now := time.Now()
	sw.now = func() time.Time { return now }
	sw.last = now.Add(-2 * time.Minute)
	sw.note("still running")
	if got := sw.sinceOutput(); got != 2*time.Minute {
		t.Errorf("a heartbeat note reset the quiet clock: %s", got)
	}
	sw.Write([]byte("real output\n")) //nolint:errcheck // test capture
	if got := sw.sinceOutput(); got != 0 {
		t.Errorf("output must reset the quiet clock: %s", got)
	}
}

func TestHeartbeat_ReportsAHungStepUntilStopped(t *testing.T) {
	old := heartbeatEvery
	heartbeatEvery = 10 * time.Millisecond
	defer func() { heartbeatEvery = old }()
	var out bytes.Buffer
	sw := newStampWriter(&out)
	var mu sync.Mutex
	var reports []string
	stop := heartbeat("build-desktop", "", sw, true, func(d string) {
		mu.Lock()
		reports = append(reports, d)
		mu.Unlock()
	})
	time.Sleep(60 * time.Millisecond)
	stop()
	stop()                            // a second stop is harmless
	time.Sleep(20 * time.Millisecond) // a tick already in flight may still report
	mu.Lock()
	n := len(reports)
	mu.Unlock()
	if n == 0 || !strings.Contains(reports[0], "build-desktop: still running after") || !strings.Contains(reports[0], "no output for") {
		t.Fatalf("reports = %v", reports)
	}
	if !strings.Contains(out.String(), "still running after") {
		t.Errorf("the step's log must hold the heartbeat: %q", out.String())
	}
	time.Sleep(40 * time.Millisecond)
	mu.Lock()
	after := len(reports)
	mu.Unlock()
	if after != n {
		t.Errorf("heartbeats continued after stop: %d -> %d", n, after)
	}
}

func TestTerminalCommand_KeepsAnIdlePasswordPromptAlive(t *testing.T) {
	spec := terminalCommand(Host{Name: "m", SSH: "user@m"}, "sudo true")
	args := strings.Join(spec.Args, " ")
	if !strings.Contains(args, "-t") || !strings.Contains(args, "ServerAliveInterval=15") || !strings.Contains(args, "ServerAliveCountMax=3") {
		t.Errorf("a terminal ssh must send keepalives so an idle tunnel does not drop it: %v", spec.Args)
	}
	if spec.Args[len(spec.Args)-2] != "user@m" || spec.Args[len(spec.Args)-1] != "sudo true" {
		t.Errorf("the host and script come last: %v", spec.Args)
	}
}

func exitError(t *testing.T, code string) error {
	t.Helper()
	err := exec.Command("sh", "-c", "exit "+code).Run()
	var ee *exec.ExitError
	if !errors.As(err, &ee) {
		t.Fatalf("no exit error: %v", err)
	}
	return err
}

func TestInstallMacDesktop_DroppedConnectionIsNamedAndTimed(t *testing.T) {
	m := &macHost{arch: "arm64", installedArchs: "arm64"}
	r := m.runner()
	inner := r.answer
	r.answer = func(h Host, script, stdin string) ([]byte, []byte, error) {
		if strings.HasPrefix(script, terminalScript) {
			return nil, nil, exitError(t, "255")
		}
		return inner(h, script, stdin)
	}
	_, err := InstallMacDesktop(context.Background(), r, mac, "/p.pkg", "", InstallOptions{AskSudo: true, Interactive: true}, &bytes.Buffer{})
	if err == nil || !strings.Contains(err.Error(), "failed on mac after ") || !strings.Contains(err.Error(), "the connection to the host dropped") {
		t.Errorf("a dropped ssh must say so and say how long it took: %v", err)
	}
	m = &macHost{arch: "arm64", installedArchs: "arm64"}
	r = m.runner()
	inner = r.answer
	r.answer = func(h Host, script, stdin string) ([]byte, []byte, error) {
		if strings.HasPrefix(script, terminalScript) {
			return nil, nil, exitError(t, "1")
		}
		return inner(h, script, stdin)
	}
	_, err = InstallMacDesktop(context.Background(), r, mac, "/p.pkg", "", InstallOptions{AskSudo: true, Interactive: true}, &bytes.Buffer{})
	if err == nil || strings.Contains(err.Error(), "connection to the host dropped") {
		t.Errorf("a sudo failure is not a dropped connection: %v", err)
	}
}

// The host's Ion must not quit until sudo has the password: a failed prompt
// leaves it running.
func TestInstallMacDesktop_AskSudoQuitsIonOnlyAfterThePassword(t *testing.T) {
	m := &macHost{arch: "arm64", running: true, installedArchs: "arm64"}
	r := m.runner()
	var steps []string
	rec, err := InstallMacDesktop(context.Background(), r, mac, "/p.pkg", "", InstallOptions{AskSudo: true, Interactive: true, QuitIon: true, OnStep: func(s string) { steps = append(steps, s) }}, &bytes.Buffer{})
	if err != nil || !rec.WasRunning {
		t.Fatalf("rec = %+v err = %v", rec, err)
	}
	var script string
	for _, s := range r.scripts {
		if s == macQuitIon {
			t.Errorf("Ion must not quit in a separate step before the password:\n%s", joined(r))
		}
		if strings.HasPrefix(s, terminalScript) {
			script = s
		}
	}
	verify := strings.Index(script, "-v || exit $?")
	quit := strings.Index(script, macQuitIon)
	install := strings.Index(script, "installer -pkg")
	if verify < 0 || quit < verify || install < quit || !strings.Contains(script, "trap \"rm -f '/tmp/ion-desktop-") {
		t.Errorf("the session must verify sudo, then quit Ion, then install, and clean up the package:\n%s", script)
	}
	for _, want := range []string{"install on mac (waiting for the sudo password)"} {
		found := false
		for _, s := range steps {
			found = found || s == want
		}
		if !found {
			t.Errorf("OnStep never heard %q: %v", want, steps)
		}
	}
}

func TestMacTerminalInstall_NoQuitWhenIonIsNotRunning(t *testing.T) {
	script := macTerminalInstall(Host{Name: "m"}, "/tmp/x.pkg", false)
	if strings.Contains(script, "-v") || strings.Contains(script, "pkill") || !strings.Contains(script, "installer -pkg '/tmp/x.pkg' -target /") {
		t.Errorf("script:\n%s", script)
	}
}
