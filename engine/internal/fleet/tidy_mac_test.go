package fleet

import (
	"context"
	"errors"
	"strings"
	"testing"
)

// tidyFixture is a Mac desktop host that installs a release on itself and
// can be reached over SSH. found is what macTidyFind prints there; sudoOK
// says whether its sudo runs without a password.
func tidyFixture(t *testing.T, found string, sudoOK bool, req Request) (*deployFixture, []Result) {
	t.Helper()
	fastSelfInstall(t)
	h := Host{Name: "m", SSH: "m", Kind: KindDesktop, Entry: pairedEntry, AskSudo: req.Install.AskSudo}
	f, d := newDeployFixture(t, Config{Hosts: []Host{h}})
	answer := f.answer
	f.runner.answer = func(host Host, script, stdin string) ([]byte, []byte, error) {
		switch {
		case script == macTidyFind:
			return []byte(found), nil, nil
		case script == "sudo -n true" && !sudoOK:
			return nil, []byte("sudo: a password is required"), errors.New("exit status 1")
		}
		return answer(host, script, stdin)
	}
	host := &fakeSelfHost{desktop: "0.2.0"}
	d.OpenLink = host.open
	d.Latest = func(context.Context) (Latest, error) { return Latest{Desktop: "0.3.0"}, nil }
	req.Hosts, req.Source = []Host{h}, SourceRelease
	p, err := d.Prepare(context.Background(), req)
	if err != nil {
		t.Fatal(err)
	}
	if !p.Targets[0].Self {
		t.Fatalf("target = %+v, want a self-install", p.Targets[0])
	}
	results, err := d.Run(context.Background(), p)
	if err != nil {
		t.Fatal(err)
	}
	if !results[0].OK {
		t.Fatalf("result = %+v", results[0])
	}
	return f, results
}

func tidyScripts(f *deployFixture) []string {
	var out []string
	for _, s := range f.scriptsFor("m") {
		if strings.Contains(s, "rm -rf") || strings.Contains(s, "chown") {
			out = append(out, s)
		}
	}
	return out
}

// After a Mac installs its desktop on itself, the deploy removes the old
// apps it set aside and takes the app back from root, with passwordless sudo.
func TestDeploy_TidiesASelfInstalledMac(t *testing.T) {
	found := "aside /Applications/.Ion.app.previous\naside /Applications/.Ion.app.previous.4242\nowner root\n"
	f, results := tidyFixture(t, found, true, Request{})

	got := tidyScripts(f)
	want := `sudo -n rm -rf '/Applications/.Ion.app.previous' '/Applications/.Ion.app.previous.4242' && sudo -n chown -R "$(id -un)" '/Applications/Ion.app'`
	if len(got) != 1 || got[0] != want {
		t.Fatalf("tidy scripts = %q\nwant %q", got, want)
	}
	if results[0].Tidy != "removed 2 old apps; took the app back from root" {
		t.Errorf("tidy = %q", results[0].Tidy)
	}
}

// Nothing set aside and the app already the user's: nothing runs as root.
func TestDeploy_NothingToTidy(t *testing.T) {
	f, results := tidyFixture(t, "", true, Request{})
	if got := tidyScripts(f); len(got) != 0 {
		t.Errorf("tidy ran %q", got)
	}
	for _, s := range f.scriptsFor("m") {
		if s == "sudo -n true" {
			t.Errorf("sudo was checked with nothing to tidy")
		}
	}
	if results[0].Tidy != "" {
		t.Errorf("tidy = %q", results[0].Tidy)
	}
}

// Sudo needs a password and none can be typed: the old app stays, and the
// result says how to remove it.
func TestDeploy_TidyNeedsAPassword(t *testing.T) {
	f, results := tidyFixture(t, "aside /Applications/.Ion.app.previous\n", false, Request{})
	if got := tidyScripts(f); len(got) != 0 {
		t.Errorf("tidy ran %q", got)
	}
	if !strings.Contains(results[0].Tidy, "old app left in place") || !strings.Contains(results[0].Tidy, "--ask-sudo") {
		t.Errorf("tidy = %q", results[0].Tidy)
	}
}

// With --ask-sudo on a terminal, the tidy asks for the password there.
func TestDeploy_TidyAsksForThePassword(t *testing.T) {
	req := Request{Terminal: true, Install: InstallOptions{AskSudo: true}}
	f, results := tidyFixture(t, "aside /Applications/.Ion.app.previous\n", false, req)
	if len(f.terminal) != 1 {
		t.Fatalf("terminal runs = %d", len(f.terminal))
	}
	script := f.terminal[0].Args[len(f.terminal[0].Args)-1]
	if !strings.Contains(script, "sudo -p 'Password for %u on m (ion fleet install): ' rm -rf '/Applications/.Ion.app.previous'") {
		t.Errorf("terminal script = %s", script)
	}
	if !strings.Contains(f.terminal[0].Banner, "removing an old Ion app on m") {
		t.Errorf("banner = %q", f.terminal[0].Banner)
	}
	if results[0].Tidy != "removed 1 old app" {
		t.Errorf("tidy = %q", results[0].Tidy)
	}
}

// An install over SSH hands the new app to the SSH user with the same sudo
// that ran the installer, so a later self-install replaces it outright.
func TestInstallMacDesktop_HandsTheAppToTheSSHUser(t *testing.T) {
	h := Host{Name: "m", SSH: "m"}
	if s := macTerminalInstall(h, "/tmp/x.pkg", false); !strings.Contains(s, `installer -pkg '/tmp/x.pkg' -target / && sudo -p 'Password for %u on m (ion fleet install): ' chown -R "$(id -un)" '/Applications/Ion.app'`) {
		t.Errorf("terminal install = %s", s)
	}
}

// Only a set-aside app is removed with sudo, whatever the host prints.
func TestParseMacTidy_TakesOnlySetAsideApps(t *testing.T) {
	out := "aside /Applications/.Ion.app.previous\naside /Applications/.Ion.app.previous.2\naside /\naside /Applications/Ion.app\naside /Applications/.Ion.app.previousX\nowner root\n"
	plan := parseMacTidy(out)
	want := []string{"/Applications/.Ion.app.previous", "/Applications/.Ion.app.previous.2"}
	if strings.Join(plan.aside, ",") != strings.Join(want, ",") || plan.owner != "root" {
		t.Errorf("plan = %+v, want aside %v and owner root", plan, want)
	}
}
