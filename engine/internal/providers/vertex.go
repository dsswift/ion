package providers

import (
	"bytes"
	"context"
	"fmt"
	"os"
	"os/exec"
	"strings"
	"time"
)

// VertexConfig configures Anthropic via Google Cloud Vertex AI.
type VertexConfig struct {
	ProjectID   string
	Region      string
	AccessToken string
}

// NewVertexProvider creates an Anthropic provider routed through Vertex AI.
// It resolves the access token from config, environment, or gcloud CLI.
func NewVertexProvider(cfg VertexConfig) (LlmProvider, error) {
	region := cfg.Region
	if region == "" {
		region = "us-east5"
	}

	projectID := cfg.ProjectID
	if projectID == "" {
		projectID = os.Getenv("GOOGLE_CLOUD_PROJECT")
	}
	if projectID == "" {
		return nil, fmt.Errorf("vertex: no project ID configured (set VertexConfig.ProjectID or GOOGLE_CLOUD_PROJECT)")
	}

	accessToken := resolveVertexToken(cfg)
	if accessToken == "" {
		return nil, fmt.Errorf("vertex: no access token found (set VertexConfig.AccessToken, GOOGLE_ACCESS_TOKEN, or ensure gcloud is authenticated)")
	}

	baseURL := fmt.Sprintf(
		"https://%s-aiplatform.googleapis.com/v1/projects/%s/locations/%s/publishers/anthropic",
		region, projectID, region,
	)

	return NewAnthropicProvider(&ProviderOptions{
		ID:         "vertex",
		BaseURL:    baseURL,
		APIKey:     accessToken,
		AuthHeader: "bearer",
	}), nil
}

// resolveVertexToken resolves a Google Cloud access token from (in order):
// 1. VertexConfig.AccessToken
// 2. GOOGLE_ACCESS_TOKEN env var
// 3. gcloud auth print-access-token (10s timeout)
func resolveVertexToken(cfg VertexConfig) string {
	if cfg.AccessToken != "" {
		return cfg.AccessToken
	}

	if token := os.Getenv("GOOGLE_ACCESS_TOKEN"); token != "" {
		return token
	}

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	cmd := exec.CommandContext(ctx, "gcloud", "auth", "print-access-token")
	var out bytes.Buffer
	cmd.Stdout = &out
	cmd.Stderr = nil

	if err := cmd.Run(); err != nil {
		return ""
	}

	return strings.TrimSpace(out.String())
}
