package main

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/dsswift/ion/engine/internal/fleet"
)

func TestFleetCheckout_SetsAndShowsTheDevCheckout(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "fleet.json")
	checkout := filepath.Join(dir, "ion")
	for _, rel := range []string{"scripts/package-studio-server.sh", "scripts/install-studio-server.sh", "engine/go.mod", "desktop/package.json"} {
		if err := os.MkdirAll(filepath.Dir(filepath.Join(checkout, rel)), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(checkout, rel), nil, 0o644); err != nil {
			t.Fatal(err)
		}
	}
	// A host still owed its move must survive the write.
	if err := fleet.Save(path, fleet.Config{LegacyHosts: []fleet.Host{{Name: "old", SSH: "user@old.example.org", Kind: fleet.KindServer}}}); err != nil {
		t.Fatal(err)
	}

	var out bytes.Buffer
	if err := fleetCheckoutAt(path, nil, &out); err != nil || !strings.Contains(out.String(), "no checkout is set") {
		t.Fatalf("unset: %q %v", out.String(), err)
	}
	if err := fleetCheckoutAt(path, []string{filepath.Join(dir, "not-ion")}, &out); err == nil {
		t.Fatal("a folder that is not an Ion checkout was accepted")
	}
	if err := fleetCheckoutAt(path, []string{checkout}, &out); err != nil {
		t.Fatal(err)
	}
	back, err := fleet.Load(path)
	if err != nil || back.Checkout != checkout || len(back.LegacyHosts) != 1 {
		t.Fatalf("fleet file after = %+v %v", back, err)
	}
	out.Reset()
	if err := fleetCheckoutAt(path, nil, &out); err != nil || strings.TrimSpace(out.String()) != checkout {
		t.Fatalf("show: %q %v", out.String(), err)
	}
}

// The command as a person types it: `ion fleet checkout PATH`, then
// `ion fleet checkout`. The path must reach the command, and the bare form
// must not fail for having no argument.
func TestFleetCheckout_ThroughTheFleetCommand(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)
	checkout := filepath.Join(home, "ion")
	for _, rel := range []string{"scripts/package-studio-server.sh", "scripts/install-studio-server.sh", "engine/go.mod", "desktop/package.json"} {
		if err := os.MkdirAll(filepath.Dir(filepath.Join(checkout, rel)), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(checkout, rel), nil, 0o644); err != nil {
			t.Fatal(err)
		}
	}
	cmdFleet([]string{"checkout", checkout}, map[string]string{})
	cmdFleet([]string{"checkout"}, map[string]string{})
	back, err := fleet.Load(fleet.DefaultPath())
	if err != nil || back.Checkout != checkout {
		t.Fatalf("fleet file after = %+v %v", back, err)
	}
}
