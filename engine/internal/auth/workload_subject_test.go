package auth

import (
	"testing"

	"github.com/dsswift/ion/engine/internal/types"
)

func TestWorkloadSubjectPrefersVerifiedSubject(t *testing.T) {
	got, err := WorkloadSubject(&ContextIdentity{Subject: "arn:aws:sts::1:assumed-role/x"}, "aws", types.OAuthConfig{})
	if err != nil || got != "arn:aws:sts::1:assumed-role/x" {
		t.Fatalf("got %q, %v", got, err)
	}
}

func TestWorkloadSubjectFromClientID(t *testing.T) {
	got, err := WorkloadSubject(&ContextIdentity{}, "beacon", types.OAuthConfig{ClientID: "abc"})
	if err != nil || got != "workload:beacon:abc" {
		t.Fatalf("got %q, %v", got, err)
	}
	t.Setenv("BEACON_CLIENT_ID", "from-env")
	got, err = WorkloadSubject(nil, "beacon", types.OAuthConfig{ClientIDEnv: "BEACON_CLIENT_ID"})
	if err != nil || got != "workload:beacon:from-env" {
		t.Fatalf("got %q, %v", got, err)
	}
	if _, err := WorkloadSubject(nil, "beacon", types.OAuthConfig{}); err == nil {
		t.Fatal("no client id must be an error")
	}
}
