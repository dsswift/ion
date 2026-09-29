package auth

import "testing"

func TestResolveProviderEnv_Bedrock_CompleteSet(t *testing.T) {
	t.Setenv("AWS_ACCESS_KEY_ID", "AKIATEST")
	t.Setenv("AWS_SECRET_ACCESS_KEY", "secret-value")
	t.Setenv("AWS_SESSION_TOKEN", "session-value")
	t.Setenv("AWS_REGION", "us-west-2")
	t.Setenv("AWS_DEFAULT_REGION", "")

	vals, ok := ResolveProviderEnv("bedrock")
	if !ok {
		t.Fatal("expected bedrock env set to resolve")
	}
	if vals.Values["accessKeyID"] != "AKIATEST" {
		t.Errorf("accessKeyID = %q", vals.Values["accessKeyID"])
	}
	if vals.Values["secretAccessKey"] != "secret-value" {
		t.Errorf("secretAccessKey = %q", vals.Values["secretAccessKey"])
	}
	if vals.Values["sessionToken"] != "session-value" {
		t.Errorf("sessionToken = %q", vals.Values["sessionToken"])
	}
	if vals.Values["region"] != "us-west-2" {
		t.Errorf("region = %q", vals.Values["region"])
	}
	if vals.Source != "env" {
		t.Errorf("source = %q", vals.Source)
	}
}

func TestResolveProviderEnv_Bedrock_MissingSecret(t *testing.T) {
	t.Setenv("AWS_ACCESS_KEY_ID", "AKIATEST")
	t.Setenv("AWS_SECRET_ACCESS_KEY", "")
	t.Setenv("AWS_SESSION_TOKEN", "")
	t.Setenv("AWS_REGION", "")
	t.Setenv("AWS_DEFAULT_REGION", "")

	_, ok := ResolveProviderEnv("bedrock")
	if ok {
		t.Fatal("expected bedrock to fail to resolve with a missing required field, not resolve a partial credential")
	}
}

func TestResolveProviderEnv_Foundry_FallsBackToAnthropic(t *testing.T) {
	t.Setenv("ANTHROPIC_FOUNDRY_API_KEY", "")
	t.Setenv("ANTHROPIC_API_KEY", "sk-anthropic-fallback")
	t.Setenv("ANTHROPIC_FOUNDRY_BASE_URL", "")

	vals, ok := ResolveProviderEnv("foundry")
	if !ok {
		t.Fatal("expected foundry to resolve via the anthropic fallback")
	}
	if vals.Values["apiKey"] != "sk-anthropic-fallback" {
		t.Errorf("apiKey = %q", vals.Values["apiKey"])
	}
	if _, hasBaseURL := vals.Values["baseURL"]; hasBaseURL {
		t.Error("expected no baseURL when ANTHROPIC_FOUNDRY_BASE_URL is unset")
	}
}

func TestResolveProviderEnv_Vertex_TokenAndProject(t *testing.T) {
	t.Setenv("GOOGLE_ACCESS_TOKEN", "gcloud-token")
	t.Setenv("GOOGLE_CLOUD_PROJECT", "my-project")

	vals, ok := ResolveProviderEnv("vertex")
	if !ok {
		t.Fatal("expected vertex env set to resolve")
	}
	if vals.Values["accessToken"] != "gcloud-token" {
		t.Errorf("accessToken = %q", vals.Values["accessToken"])
	}
	if vals.Values["projectID"] != "my-project" {
		t.Errorf("projectID = %q", vals.Values["projectID"])
	}
}

func TestResolveProviderEnv_Vertex_MissingToken(t *testing.T) {
	t.Setenv("GOOGLE_ACCESS_TOKEN", "")
	t.Setenv("GOOGLE_CLOUD_PROJECT", "my-project")

	_, ok := ResolveProviderEnv("vertex")
	if ok {
		t.Fatal("expected vertex to fail to resolve without an access token")
	}
}

func TestResolveProviderEnv_UnknownProvider_NoSet(t *testing.T) {
	_, ok := ResolveProviderEnv("anthropic")
	if ok {
		t.Fatal("expected anthropic (single-key provider) to have no declared multi-value set")
	}
}

func TestResolveProviderEnv_WhitespaceOnlyIsAbsent(t *testing.T) {
	t.Setenv("AWS_ACCESS_KEY_ID", "   ")
	t.Setenv("AWS_SECRET_ACCESS_KEY", "secret")

	_, ok := ResolveProviderEnv("bedrock")
	if ok {
		t.Fatal("expected whitespace-only access key to be treated as absent")
	}
}

func TestResolveProviderEnv_RegionPrefersRegionOverDefault(t *testing.T) {
	t.Setenv("AWS_ACCESS_KEY_ID", "AKIA")
	t.Setenv("AWS_SECRET_ACCESS_KEY", "secret")
	t.Setenv("AWS_REGION", "us-east-1")
	t.Setenv("AWS_DEFAULT_REGION", "eu-west-1")

	vals, ok := ResolveProviderEnv("bedrock")
	if !ok {
		t.Fatal("expected bedrock to resolve")
	}
	if vals.Values["region"] != "us-east-1" {
		t.Errorf("expected AWS_REGION to win over AWS_DEFAULT_REGION, got %q", vals.Values["region"])
	}
}
