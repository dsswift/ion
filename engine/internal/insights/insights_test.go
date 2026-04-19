package insights

import (
	"strings"
	"testing"

	"github.com/dsswift/ion/engine/internal/types"
)

func TestExtractInsights(t *testing.T) {
	messages := []types.LlmMessage{
		{Role: "assistant", Content: "Important: always run tests before merging."},
		{Role: "assistant", Content: "TODO: refactor the database layer."},
		{Role: "assistant", Content: "The team decided to use PostgreSQL."},
	}

	insights, err := ExtractInsights(messages, nil)
	if err != nil {
		t.Fatalf("ExtractInsights: %v", err)
	}
	if len(insights) == 0 {
		t.Fatal("expected insights to be extracted")
	}

	typeSet := make(map[string]bool)
	for _, ins := range insights {
		typeSet[ins.Type] = true
	}
	if !typeSet["important_note"] {
		t.Error("expected important_note insight")
	}
	if !typeSet["todo"] {
		t.Error("expected todo insight")
	}
}

func TestExtractInsightsEmpty(t *testing.T) {
	insights, err := ExtractInsights(nil, nil)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(insights) != 0 {
		t.Errorf("expected 0 insights, got %d", len(insights))
	}
}

func TestScanForSecrets(t *testing.T) {
	tests := []struct {
		name     string
		text     string
		wantType string
	}{
		{"AWS access key", "AKIAIOSFODNN7EXAMPLE extra", "aws_access_key"},
		{"GitHub token", "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmn", "github_token"},
		{"Stripe key", "sk_live_ABCDEFGHIJKLMNOPQRSTUVWXYZab", "stripe_secret_key"},
		{"JWT", "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abc123def456ghi789", "jwt"},
		{"Private key header", "-----BEGIN RSA PRIVATE KEY-----", "private_key"},
		{"Slack token", "xoxb-123456789012-abcdef", "slack_token"},
		{"Anthropic key", "sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefgh", "anthropic_api_key"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			matches := ScanForSecrets(tt.text)
			if len(matches) == 0 {
				t.Fatalf("expected at least one match for %q", tt.text)
			}
			found := false
			for _, m := range matches {
				if m.Type == tt.wantType {
					found = true
					break
				}
			}
			if !found {
				t.Errorf("expected type %q in matches, got types: %v", tt.wantType, matchTypes(matches))
			}
		})
	}
}

func TestScanForSecretsClean(t *testing.T) {
	matches := ScanForSecrets("This is normal text with no secrets.")
	if len(matches) != 0 {
		t.Errorf("expected no matches, got %d", len(matches))
	}
}

func TestRedactSecrets(t *testing.T) {
	input := "My token is ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmn and that is it."
	result := RedactSecrets(input)
	if strings.Contains(result, "ghp_") {
		t.Error("expected token to be redacted")
	}
	if !strings.Contains(result, "[REDACTED:") {
		t.Error("expected [REDACTED:...] marker")
	}
}

func TestContainsSecrets(t *testing.T) {
	if ContainsSecrets("normal text") {
		t.Error("expected false for normal text")
	}
	if !ContainsSecrets("sk_live_ABCDEFGHIJKLMNOPQRSTUVWXYZab") {
		t.Error("expected true for Stripe key")
	}
}

func matchTypes(matches []SecretMatch) []string {
	var types []string
	for _, m := range matches {
		types = append(types, m.Type)
	}
	return types
}
