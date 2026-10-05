package fleet

import (
	"context"
	"strings"
	"testing"
)

// A platform nothing can build fails only its own hosts: the others are
// built for and deployed, and the refused one is never touched.
func TestDeploy_AHostNothingCanBuildForDoesNotStopTheOthers(t *testing.T) {
	onMac(t)
	cfg := Config{Checkout: fakeCheckout(t), Hosts: []Host{
		{Name: "mac", SSH: "mac", Kind: KindServer},
		{Name: "win", SSH: "win", Kind: KindDesktop},
	}}
	f, d := builderFixture(t, cfg, map[string]string{"win": "go\n"})
	f.platform["mac"], f.platform["win"] = "Darwin arm64", "Windows arm64"
	var events []Event
	d.Progress = func(e Event) {
		f.mu.Lock()
		events = append(events, e)
		f.mu.Unlock()
	}
	p, err := d.Prepare(context.Background(), Request{Hosts: cfg.Hosts, Source: SourceDev, Checkout: cfg.Checkout})
	if err != nil {
		t.Fatal(err)
	}
	if len(p.Refused()) != 1 || p.Refused()[0].Host.Name != "win" {
		t.Fatalf("refused = %+v", p.Refused())
	}
	before := len(f.scriptsFor("win"))
	results, err := d.Run(context.Background(), p)
	if err != nil {
		t.Fatal(err)
	}
	if !results[0].OK {
		t.Errorf("mac must deploy: %s", results[0].Error)
	}
	if results[1].OK || !strings.Contains(results[1].Error, "nothing can build the Windows desktop for arm64") {
		t.Errorf("win = %+v", results[1])
	}
	for _, script := range f.scriptsFor("win")[before:] {
		if strings.HasPrefix(script, copyToScript) || strings.Contains(script, "make.ps1") {
			t.Errorf("a refused host must not be built on or installed to: %s", script)
		}
	}
	var winStages []string
	for _, e := range events {
		if e.Host == "win" {
			winStages = append(winStages, e.Stage)
		}
	}
	if strings.Join(winStages, ",") != StageFailed {
		t.Errorf("a refused host fails at once and is never queued: %v", winStages)
	}
}

// A host named in ReleaseHosts installs the newest release while the others
// take the build, so nothing has to build for it.
func TestDeploy_AHostCanTakeTheReleaseInsteadOfTheBuild(t *testing.T) {
	onMac(t)
	cfg := Config{Checkout: fakeCheckout(t), Hosts: []Host{
		{Name: "mac", SSH: "mac", Kind: KindServer},
		{Name: "win", SSH: "win", Kind: KindDesktop},
	}}
	f, d := builderFixture(t, cfg, map[string]string{"win": "go\n"})
	f.platform["mac"], f.platform["win"] = "Darwin arm64", "Windows arm64"
	d.Latest = func(context.Context) (Latest, error) { return Latest{Desktop: "9.9.9"}, nil }
	p, err := d.Prepare(context.Background(), Request{Hosts: cfg.Hosts, Source: SourceDev, Checkout: cfg.Checkout, ReleaseHosts: []string{"win"}})
	if err != nil {
		t.Fatal(err)
	}
	mac, win := p.Targets[0], p.Targets[1]
	if mac.Source != SourceDev || win.Source != SourceRelease || win.Refusal != "" {
		t.Fatalf("targets = %+v", p.Targets)
	}
	if artifactKey(win) != "desktop/windows/arm64@release" || artifactKey(mac) != "server/darwin/arm64" {
		t.Errorf("keys = %s, %s", artifactKey(win), artifactKey(mac))
	}
	if len(p.Builds) != 1 || p.Builds[0].Key != "server/darwin/arm64" {
		t.Errorf("only the build's hosts are built for: %+v", p.Builds)
	}
	for _, script := range f.scriptsFor("win") {
		if strings.Contains(script, "Get-Command $t") {
			t.Error("a host that takes the release is not asked whether it can build")
		}
	}
	if plan := strings.Join(p.PlanLines(), "\n"); !strings.Contains(plan, "win: desktop windows/arm64") || !strings.Contains(plan, "installs the newest release, not the build") {
		t.Errorf("plan:\n%s", plan)
	}
}

// Every build and install log line reaches LogLine with the hosts it is about.
func TestDeploy_LogLinesNameTheirHosts(t *testing.T) {
	cfg := Config{Checkout: fakeCheckout(t), Hosts: serverHosts("a", "b")}
	f, d := newDeployFixture(t, cfg)
	lines := map[string][]string{}
	d.LogLine = func(hosts []string, line string) {
		f.mu.Lock()
		defer f.mu.Unlock()
		key := strings.Join(hosts, ",")
		lines[key] = append(lines[key], line)
	}
	p, err := d.Prepare(context.Background(), Request{Hosts: cfg.Hosts, Source: SourceDev, Checkout: cfg.Checkout})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := d.Run(context.Background(), p); err != nil {
		t.Fatal(err)
	}
	if build := strings.Join(lines["a,b"], "\n"); !strings.Contains(build, "finished in") {
		t.Errorf("the one build is about both hosts: %q", build)
	}
	for _, host := range []string{"a", "b"} {
		if install := strings.Join(lines[host], "\n"); !strings.Contains(install, "==> ship") {
			t.Errorf("%s's install log: %q", host, install)
		}
	}
}
