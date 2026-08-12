package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func TestStampBuildIdentity_WritesFile(t *testing.T) {
	sdkDir := t.TempDir()
	ionSdkDir := filepath.Join(sdkDir, "ion-sdk")
	if err := os.MkdirAll(ionSdkDir, 0o755); err != nil {
		t.Fatalf("mkdir ion-sdk: %v", err)
	}

	oldVersion := version
	version = "v1.2.3-abc1234"
	defer func() { version = oldVersion }()

	if err := stampBuildIdentity(sdkDir); err != nil {
		t.Fatalf("stampBuildIdentity: %v", err)
	}

	data, err := os.ReadFile(filepath.Join(ionSdkDir, "build-identity.json"))
	if err != nil {
		t.Fatalf("read stamped file: %v", err)
	}

	var got struct {
		BuildIdentity string `json:"buildIdentity"`
	}
	if err := json.Unmarshal(data, &got); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if got.BuildIdentity != "v1.2.3-abc1234" {
		t.Errorf("buildIdentity = %q, want %q", got.BuildIdentity, "v1.2.3-abc1234")
	}
}

func TestStampBuildIdentity_DevVersion(t *testing.T) {
	sdkDir := t.TempDir()
	ionSdkDir := filepath.Join(sdkDir, "ion-sdk")
	if err := os.MkdirAll(ionSdkDir, 0o755); err != nil {
		t.Fatalf("mkdir ion-sdk: %v", err)
	}

	oldVersion := version
	version = "dev"
	defer func() { version = oldVersion }()

	if err := stampBuildIdentity(sdkDir); err != nil {
		t.Fatalf("stampBuildIdentity: %v", err)
	}

	data, err := os.ReadFile(filepath.Join(ionSdkDir, "build-identity.json"))
	if err != nil {
		t.Fatalf("read stamped file: %v", err)
	}

	var got struct {
		BuildIdentity string `json:"buildIdentity"`
	}
	if err := json.Unmarshal(data, &got); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if got.BuildIdentity != "dev" {
		t.Errorf("buildIdentity = %q, want %q", got.BuildIdentity, "dev")
	}
}
