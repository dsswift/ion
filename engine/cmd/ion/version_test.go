package main

import (
	"bytes"
	"encoding/json"
	"strings"
	"testing"
)

func TestPrintVersion_JSONCarriesFormats(t *testing.T) {
	var out bytes.Buffer
	printVersion(&out, true)
	var got versionReport
	if err := json.Unmarshal(out.Bytes(), &got); err != nil {
		t.Fatalf("not JSON: %v\n%s", err, out.String())
	}
	if got.Version != version {
		t.Errorf("version = %q, want %q", got.Version, version)
	}
	ids := map[string]string{}
	for _, f := range got.Formats {
		ids[f.ID] = f.Version
	}
	if ids["conversation-file"] == "" || ids["telemetry-frame"] == "" {
		t.Errorf("formats missing expected ids: %v", ids)
	}
	if strings.Contains(out.String(), "Constant") {
		t.Error("the Go constant name must not reach the JSON")
	}
}

func TestPrintVersion_Plain(t *testing.T) {
	var out bytes.Buffer
	printVersion(&out, false)
	if out.String() != "ion-engine "+version+"\n" {
		t.Errorf("got %q", out.String())
	}
}
