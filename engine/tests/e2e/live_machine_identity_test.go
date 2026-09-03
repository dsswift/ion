//go:build e2e

package e2e

import (
	"context"
	"os"
	"testing"
	"time"

	"github.com/dsswift/ion/engine/internal/auth"
	"github.com/dsswift/ion/engine/internal/types"
)

// These tests acquire real credentials from cloud metadata services.
// They skip unless the corresponding env var is set:
//
//   ION_E2E_AZURE_MI=1  — run on an Azure VM/Container App with managed identity
//   ION_E2E_GCP=1       — run on a GCE instance with metadata server access
//   ION_E2E_AWS=1        — run on an EC2/ECS/EKS instance with instance profile
//
// Optional:
//   ION_E2E_AUDIENCE     — custom audience for Azure token acquisition
//   ION_E2E_AWS_KIND     — AWS credential kind: imds (default), ecs, eks, irsa, env

func TestAzureManagedIdentity_Acquire(t *testing.T) {
	if os.Getenv("ION_E2E_AZURE_MI") == "" {
		t.Skip("ION_E2E_AZURE_MI not set — skipping Azure managed identity test")
	}

	audience := os.Getenv("ION_E2E_AUDIENCE")
	scope := "https://cognitiveservices.azure.com/.default"
	cfg := &types.AuthConfig{IdentityProvider: "azure", OAuth: map[string]types.OAuthConfig{"azure": {
		Scopes: []string{scope}, Audience: audience,
		MachineIdentity: &types.MachineIdentityConfig{Source: "azure_managed_identity", Azure: &types.AzureMachineIdentityConfig{}},
	}}}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	first, err := auth.VerifyConfiguredWorkload(ctx, cfg)
	if err != nil {
		t.Fatalf("VerifyConfiguredWorkload failed: %v", err)
	}
	second, err := auth.VerifyConfiguredWorkload(ctx, cfg)
	if err != nil {
		t.Fatalf("second VerifyConfiguredWorkload failed: %v", err)
	}
	if first.Identity == nil || first.Identity.Kind != "workload" || first.Identity.Source != "azure_managed_identity" {
		t.Fatalf("identity = %#v", first.Identity)
	}
	if first.ExpiresAt.Before(time.Now()) || second.ExpiresAt.Before(time.Now()) {
		t.Fatalf("expiry is in the past: first=%v second=%v", first.ExpiresAt, second.ExpiresAt)
	}
	if !first.ExpiresAt.Equal(second.ExpiresAt) {
		t.Fatalf("cache was not reused: first=%v second=%v", first.ExpiresAt, second.ExpiresAt)
	}

	t.Logf("Azure workload identity verified, expires %v", first.ExpiresAt)
}

func TestAzureManagedIdentity_AcquireWithClientID(t *testing.T) {
	if os.Getenv("ION_E2E_AZURE_MI") == "" {
		t.Skip("ION_E2E_AZURE_MI not set — skipping Azure managed identity test")
	}

	clientID := os.Getenv("ION_E2E_AZURE_CLIENT_ID")
	if clientID == "" {
		t.Skip("ION_E2E_AZURE_CLIENT_ID not set — skipping user-assigned identity test")
	}

	source := auth.NewAzureIdentitySource(auth.AzureMachineIdentityConfig{
		ClientID: clientID,
	})
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	audience := os.Getenv("ION_E2E_AUDIENCE")
	scope := "https://cognitiveservices.azure.com/.default"

	token, expiry, err := source.Acquire(ctx, scope, audience)
	if err != nil {
		t.Fatalf("Acquire with clientID failed: %v", err)
	}

	if token == "" {
		t.Fatal("token is empty")
	}
	if expiry.Before(time.Now()) {
		t.Fatalf("expiry %v is in the past", expiry)
	}

	t.Logf("Azure user-assigned managed identity token acquired, expires %v", expiry)
}

func TestGCPMetadata_Acquire(t *testing.T) {
	if os.Getenv("ION_E2E_GCP") == "" {
		t.Skip("ION_E2E_GCP not set — skipping GCP metadata test")
	}

	source := auth.NewGCPMetadataSource(auth.GCPMachineIdentityConfig{})
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	scope := "https://www.googleapis.com/auth/cloud-platform"

	token, expiry, err := source.Acquire(ctx, scope, "")
	if err != nil {
		t.Fatalf("Acquire failed: %v", err)
	}

	if token == "" {
		t.Fatal("token is empty")
	}
	if expiry.Before(time.Now()) {
		t.Fatalf("expiry %v is in the past", expiry)
	}

	t.Logf("GCP access token acquired, expires %v (in %v)", expiry, time.Until(expiry).Round(time.Second))
}

func TestGCPMetadata_AcquireIDToken(t *testing.T) {
	if os.Getenv("ION_E2E_GCP") == "" {
		t.Skip("ION_E2E_GCP not set — skipping GCP metadata test")
	}

	audience := os.Getenv("ION_E2E_AUDIENCE")
	if audience == "" {
		audience = "https://example.com"
	}

	source := auth.NewGCPMetadataSource(auth.GCPMachineIdentityConfig{
		TokenType: "id_token",
	})
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	token, expiry, err := source.Acquire(ctx, "", audience)
	if err != nil {
		t.Fatalf("Acquire id_token failed: %v", err)
	}

	if token == "" {
		t.Fatal("id_token is empty")
	}
	if expiry.Before(time.Now()) {
		t.Fatalf("expiry %v is in the past", expiry)
	}

	t.Logf("GCP id_token acquired, expires %v", expiry)
}

func TestAWSCredentials_Retrieve(t *testing.T) {
	if os.Getenv("ION_E2E_AWS") == "" {
		t.Skip("ION_E2E_AWS not set — skipping AWS credential test")
	}

	kind := os.Getenv("ION_E2E_AWS_KIND")
	if kind == "" {
		kind = "imds"
	}

	cfg := &types.AWSMachineIdentityConfig{Kind: kind}

	provider, err := auth.NewAWSCredentialsProvider(cfg)
	if err != nil {
		t.Fatalf("NewAWSCredentialsProvider(%q) failed: %v", kind, err)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	creds, err := provider.Retrieve(ctx)
	if err != nil {
		t.Fatalf("Retrieve failed: %v", err)
	}

	if creds.AccessKeyID == "" {
		t.Fatal("AccessKeyID is empty")
	}
	if creds.SecretAccessKey == "" {
		t.Fatal("SecretAccessKey is empty")
	}
	if !creds.ExpiresAt.IsZero() && creds.ExpiresAt.Before(time.Now()) {
		t.Fatalf("credentials expired at %v", creds.ExpiresAt)
	}

	t.Logf("AWS credentials retrieved via %q; expires %v", kind, creds.ExpiresAt)
}
