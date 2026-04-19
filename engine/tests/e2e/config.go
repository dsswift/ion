//go:build e2e

package e2e

import (
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
)

// TestProviderConfig holds config for one provider in e2e tests.
type TestProviderConfig struct {
	APIKey    string `json:"apiKey"`
	APIKeyEnv string `json:"apiKeyEnv"`
	BaseURL   string `json:"baseURL"`
	TestModel string `json:"testModel"`
}

// TestConfig holds e2e test configuration loaded from testconfig.json.
type TestConfig struct {
	Anthropic      TestProviderConfig `json:"anthropic"`
	OpenAI         TestProviderConfig `json:"openai"`
	OpenAIGateway  TestProviderConfig `json:"openaiGateway"`
}

// ResolveAPIKey returns the API key, checking explicit value first, then env var.
func (c *TestProviderConfig) ResolveAPIKey() string {
	if c.APIKey != "" {
		return c.APIKey
	}
	if c.APIKeyEnv != "" {
		return os.Getenv(c.APIKeyEnv)
	}
	return ""
}

// loadTestConfig reads testconfig.json from the same directory as the test file.
func loadTestConfig() (*TestConfig, error) {
	_, thisFile, _, _ := runtime.Caller(0)
	dir := filepath.Dir(thisFile)
	data, err := os.ReadFile(filepath.Join(dir, "testconfig.json"))
	if err != nil {
		return nil, err
	}
	var cfg TestConfig
	if err := json.Unmarshal(data, &cfg); err != nil {
		return nil, err
	}
	return &cfg, nil
}
