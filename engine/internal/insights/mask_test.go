package insights

import (
	"strings"
	"testing"
)

func TestMaskSensitiveFields(t *testing.T) {
	tests := []struct {
		name  string
		input string
		want  string // substring that should NOT appear
	}{
		{"api_key", `"api_key": "sk-abc123"`, "sk-abc123"},
		{"password", `"password": "hunter2"`, "hunter2"},
		{"token", `"token": "eyJhbG..."`, "eyJhbG"},
		{"secret", `"secret": "s3cr3t"`, "s3cr3t"},
		{"authorization", `"authorization": "Bearer xyz"`, "Bearer xyz"},
		{"client_secret", `"client_secret": "cs-abc"`, "cs-abc"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			result := MaskSensitiveFields(tt.input)
			if strings.Contains(result, tt.want) {
				t.Errorf("MaskSensitiveFields(%q) still contains %q\nGot: %s", tt.input, tt.want, result)
			}
			if !strings.Contains(result, "[REDACTED]") {
				t.Errorf("MaskSensitiveFields(%q) missing [REDACTED]\nGot: %s", tt.input, result)
			}
		})
	}

	// Non-sensitive fields should be preserved
	nonSensitive := `"name": "John", "age": "30"`
	if MaskSensitiveFields(nonSensitive) != nonSensitive {
		t.Errorf("non-sensitive content was modified")
	}
}
