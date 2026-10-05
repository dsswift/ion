package main

import (
	"testing"

	"github.com/dsswift/ion/engine/internal/fleet"
)

// A --to host an earlier fleet file listed keeps that file's settings until
// it has moved into the server list. A host with no Ion on it cannot move,
// and this deploy is what installs one.
func TestAdHocHost_KeepsALegacyHostsSettings(t *testing.T) {
	cfg := fleet.Config{LegacyHosts: []fleet.Host{{Name: "win", SSH: "user@win.example.org", Kind: fleet.KindDesktop, BuildDir: `C:\dev\build`}}}
	next, h, err := adHocHost(cfg, "user@win.example.org", fleet.KindDesktop, false, "")
	if err != nil || h.Name != "win" || h.BuildDir != `C:\dev\build` {
		t.Fatalf("host = %+v, err = %v", h, err)
	}
	if len(next.Hosts) != 1 || next.Hosts[0].Name != "win" {
		t.Errorf("the plan's hosts = %+v", next.Hosts)
	}
	if _, _, err := adHocHost(cfg, "user@win.example.org", fleet.KindServer, false, ""); err == nil {
		t.Error("a kind that contradicts the fleet's was accepted")
	}
}

func TestAdHocHost_TakesABuildFolderForAHostTheFleetDoesNotKnow(t *testing.T) {
	_, h, err := adHocHost(fleet.Config{}, "user@new.example.org", fleet.KindDesktop, false, `D:\build`)
	if err != nil || h.BuildDir != `D:\build` || h.SSH != "user@new.example.org" {
		t.Fatalf("host = %+v, err = %v", h, err)
	}
	if _, _, err := adHocHost(fleet.Config{}, "user@new.example.org", "", false, ""); err == nil {
		t.Error("a host the fleet does not know was accepted with no kind")
	}
}
