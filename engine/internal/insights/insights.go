// Package insights extracts structured insights from conversation messages
// and provides secret scanning and redaction.
package insights

import (
	"encoding/json"
	"regexp"
	"strings"

	"github.com/dsswift/ion/engine/internal/types"
)

// Insight is a structured observation extracted from conversation.
type Insight struct {
	Type               string  `json:"type"`
	Content            string  `json:"content"`
	Confidence         float64 `json:"confidence"`
	SourceMessageIndex int     `json:"sourceMessageIndex"`
}

// ExtractInsights analyzes messages for patterns and extracts insights.
// The summarize function is called to condense long text blocks; pass nil to skip summarization.
func ExtractInsights(messages []types.LlmMessage, summarize func(string) (string, error)) ([]Insight, error) {
	var insights []Insight

	for i, msg := range messages {
		text := extractText(msg)
		if text == "" {
			continue
		}

		// Pattern-based extraction.
		if matched := extractPattern(text, `(?i)\b(?:important|critical|note|warning|caution)\b:?\s*(.+?)(?:\.|$)`, "important_note"); matched != "" {
			insights = append(insights, Insight{
				Type:               "important_note",
				Content:            matched,
				Confidence:         0.8,
				SourceMessageIndex: i,
			})
		}

		if matched := extractPattern(text, `(?i)\b(?:todo|fixme|hack|xxx)\b:?\s*(.+?)(?:\.|$)`, "todo"); matched != "" {
			insights = append(insights, Insight{
				Type:               "todo",
				Content:            matched,
				Confidence:         0.9,
				SourceMessageIndex: i,
			})
		}

		if matched := extractPattern(text, `(?i)\b(?:decided|conclusion|resolution)\b:?\s*(.+?)(?:\.|$)`, "decision"); matched != "" {
			insights = append(insights, Insight{
				Type:               "decision",
				Content:            matched,
				Confidence:         0.7,
				SourceMessageIndex: i,
			})
		}

		if matched := extractPattern(text, `(?i)\b(?:blocked|stuck|waiting on|depends on)\b:?\s*(.+?)(?:\.|$)`, "blocker"); matched != "" {
			insights = append(insights, Insight{
				Type:               "blocker",
				Content:            matched,
				Confidence:         0.75,
				SourceMessageIndex: i,
			})
		}
	}

	// Optional summarization pass.
	if summarize != nil && len(insights) > 10 {
		var summaryParts []string
		for _, ins := range insights {
			summaryParts = append(summaryParts, ins.Type+": "+ins.Content)
		}
		summary, err := summarize(strings.Join(summaryParts, "\n"))
		if err != nil {
			return insights, err
		}
		insights = append([]Insight{{
			Type:               "summary",
			Content:            summary,
			Confidence:         0.6,
			SourceMessageIndex: -1,
		}}, insights...)
	}

	return insights, nil
}

func extractPattern(text, pattern, _ string) string {
	re, err := regexp.Compile(pattern)
	if err != nil {
		return ""
	}
	matches := re.FindStringSubmatch(text)
	if len(matches) < 2 {
		return ""
	}
	result := strings.TrimSpace(matches[1])
	if len(result) > 200 {
		result = result[:200] + "..."
	}
	return result
}

func extractText(msg types.LlmMessage) string {
	switch c := msg.Content.(type) {
	case string:
		return c
	case []types.LlmContentBlock:
		var parts []string
		for _, b := range c {
			if b.Type == "text" && b.Text != "" {
				parts = append(parts, b.Text)
			}
		}
		return strings.Join(parts, "\n")
	case []any:
		var parts []string
		for _, item := range c {
			if m, ok := item.(map[string]any); ok {
				if t, _ := m["type"].(string); t == "text" {
					if text, ok := m["text"].(string); ok {
						parts = append(parts, text)
					}
				}
			}
		}
		return strings.Join(parts, "\n")
	default:
		b, err := json.Marshal(c)
		if err != nil {
			return ""
		}
		return string(b)
	}
}

// --- Secret Scanning ---

// SecretMatch represents a detected secret in text.
type SecretMatch struct {
	Type  string
	Value string
	Line  int
}

// secretPattern pairs a type name with a compiled regex.
type secretPattern struct {
	Type    string
	Pattern *regexp.Regexp
}

var secretPatterns []secretPattern

func init() {
	// Build patterns once at init time.
	defs := []struct {
		Type    string
		Pattern string
	}{
		// AWS
		{"aws_access_key", `(?:^|[^A-Za-z0-9])(?:(?:A3T[A-Z0-9]|AKIA|ASIA|ABIA|ACCA)[0-9A-Z]{16})(?:[^A-Za-z0-9]|$)`},
		{"aws_secret_key", `(?i)aws[_]?secret[_]?access[_]?key[\s]*[=:]\s*['"]?([A-Za-z0-9/+=]{40})['"]?`},
		// GitHub
		{"github_token", `(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{36,}`},
		{"github_fine_grained", `github_pat_[A-Za-z0-9_]{22,}`},
		// Stripe
		{"stripe_secret_key", `sk_(?:live|test)_[A-Za-z0-9]{24,}`},
		{"stripe_publishable_key", `pk_(?:live|test)_[A-Za-z0-9]{24,}`},
		{"stripe_restricted_key", `rk_(?:live|test)_[A-Za-z0-9]{24,}`},
		// Slack
		{"slack_token", `xox[bporas]-[A-Za-z0-9-]+`},
		{"slack_webhook", `https://hooks\.slack\.com/services/[A-Za-z0-9/]+`},
		// JWT
		{"jwt", `eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+`},
		// PEM private keys
		{"private_key", `-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----`},
		// Generic API keys
		{"api_key_generic", `(?i)(?:api[_-]?key|apikey)[\s]*[=:]\s*['"]?([A-Za-z0-9_\-]{20,})['"]?`},
		{"bearer_token", `(?i)(?:bearer|authorization)[\s]*[=:]\s*['"]?([A-Za-z0-9_\-.]{20,})['"]?`},
		// Database URLs
		{"database_url", `(?i)(?:postgres|mysql|mongodb|redis)://[^\s'"]+`},
		// Google
		{"google_api_key", `AIza[A-Za-z0-9_\-]{35}`},
		{"google_oauth", `[0-9]+-[a-z0-9_]+\.apps\.googleusercontent\.com`},
		// Azure
		{"azure_storage_key", `(?i)(?:AccountKey|azure[_]?storage[_]?key)[\s]*[=:]\s*['"]?([A-Za-z0-9+/=]{44,})['"]?`},
		// Twilio
		{"twilio_api_key", `SK[0-9a-fA-F]{32}`},
		// SendGrid
		{"sendgrid_api_key", `SG\.[A-Za-z0-9_\-]{22}\.[A-Za-z0-9_\-]{43}`},
		// Mailgun
		{"mailgun_api_key", `key-[A-Za-z0-9]{32}`},
		// NPM
		{"npm_token", `npm_[A-Za-z0-9]{36}`},
		// PyPI
		{"pypi_token", `pypi-[A-Za-z0-9_\-]{50,}`},
		// Heroku
		{"heroku_api_key", `(?i)heroku[_]?api[_]?key[\s]*[=:]\s*['"]?([a-f0-9-]{36})['"]?`},
		// Datadog
		{"datadog_api_key", `(?i)dd[_]?api[_]?key[\s]*[=:]\s*['"]?([a-f0-9]{32})['"]?`},
		// OpenAI
		{"openai_api_key", `sk-[A-Za-z0-9]{20,}T3BlbkFJ[A-Za-z0-9]{20,}`},
		// Anthropic
		{"anthropic_api_key", `sk-ant-[A-Za-z0-9_\-]{20,}`},
		// SSH private key content
		{"ssh_private_key", `-----BEGIN OPENSSH PRIVATE KEY-----`},
		// Generic password assignment
		{"password_assignment", `(?i)(?:password|passwd|pwd)[\s]*[=:]\s*['"]?([^\s'"]{8,})['"]?`},
		// Generic secret assignment
		{"secret_assignment", `(?i)(?:secret|token|credential)[\s]*[=:]\s*['"]?([^\s'"]{8,})['"]?`},
		// Base64 encoded blobs that look like secrets (64+ chars)
		{"base64_secret", `(?i)(?:key|secret|token|password)[\s]*[=:]\s*['"]?([A-Za-z0-9+/=]{64,})['"]?`},
		// Discord
		{"discord_token", `(?:mfa\.[\w-]{84}|[\w-]{24}\.[\w-]{6}\.[\w-]{27,})`},
		// Shopify
		{"shopify_token", `shpat_[a-fA-F0-9]{32}`},
		{"shopify_secret", `shpss_[a-fA-F0-9]{32}`},
		// DigitalOcean
		{"digitalocean_token", `dop_v1_[a-f0-9]{64}`},
		{"digitalocean_oauth", `doo_v1_[a-f0-9]{64}`},
		{"docker_hub_pat", `dckr_pat_[A-Za-z0-9_-]{20,}`},
		// Terraform
		{"terraform_token", `[a-z0-9]{14}\.atlasv1\.[a-z0-9_-]{60,}`},
		// Vault
		{"vault_token", `(?:hvs|hvb)\.[A-Za-z0-9_-]{24,}`},
		// Doppler
		{"doppler_token", `dp\.st\.[a-z0-9_-]+\.[A-Za-z0-9]{40,}`},
		// 1Password
		{"onepassword_token", `ops_[A-Za-z0-9_\-]{40,}`},
		// Generic hex key (32+ hex chars labeled as key/secret)
		{"hex_secret", `(?i)(?:key|secret)[\s]*[=:]\s*['"]?([a-f0-9]{32,})['"]?`},
		// Azure connection string
		{"azure_connection_string", `(?i)(?:DefaultEndpointsProtocol|AccountName|AccountKey|EndpointSuffix)=[^\s;]+(?:;[^\s;]+)+`},
		// Basic auth
		{"basic_auth", `(?i)(?:basic)\s+[A-Za-z0-9+/=]{20,}`},
		// PGP private key
		{"pgp_private", `-----BEGIN PGP PRIVATE KEY BLOCK-----`},
		// GitLab
		{"gitlab_token", `glpat-[A-Za-z0-9_\-]{20,}`},
		// Facebook
		{"facebook_token", `(?i)(?:facebook|fb)[_]?(?:access[_]?token|secret)[\s]*[=:]\s*['"]?([A-Za-z0-9_\-]{20,})['"]?`},
		{"facebook_raw_token", `EAACEdEose0cBA[A-Za-z0-9]+`},
		// Cloudflare
		{"cloudflare_key", `(?i)cloudflare[_]?(?:api[_]?key|token)[\s]*[=:]\s*['"]?([A-Za-z0-9_\-]{20,})['"]?`},
		// Azure client secret
		{"azure_client_secret", `(?i)azure[_]?client[_]?secret[\s]*[=:]\s*['"]?([A-Za-z0-9_\-~.]{20,})['"]?`},
		// GCP service account
		{"gcp_service_account", `"type"\s*:\s*"service_account"`},
	}

	for _, d := range defs {
		re, err := regexp.Compile(d.Pattern)
		if err != nil {
			continue
		}
		secretPatterns = append(secretPatterns, secretPattern{Type: d.Type, Pattern: re})
	}
}

// ScanForSecrets scans text for known secret patterns and returns matches.
func ScanForSecrets(text string) []SecretMatch {
	var matches []SecretMatch
	lines := strings.Split(text, "\n")

	for lineNo, line := range lines {
		for _, sp := range secretPatterns {
			locs := sp.Pattern.FindAllString(line, -1)
			for _, loc := range locs {
				matches = append(matches, SecretMatch{
					Type:  sp.Type,
					Value: loc,
					Line:  lineNo + 1,
				})
			}
		}
	}

	return matches
}

// RedactSecrets replaces detected secrets with [REDACTED:<type>].
func RedactSecrets(text string) string {
	result := text
	for _, sp := range secretPatterns {
		result = sp.Pattern.ReplaceAllStringFunc(result, func(match string) string {
			return "[REDACTED:" + sp.Type + "]"
		})
	}
	return result
}

// ContainsSecrets returns true if the text contains any known secret patterns.
func ContainsSecrets(text string) bool {
	for _, sp := range secretPatterns {
		if sp.Pattern.MatchString(text) {
			return true
		}
	}
	return false
}

// sensitiveFieldRe matches JSON-like key-value pairs where the key name
// suggests a secret (token, password, key, etc.) and redacts the value.
var sensitiveFieldRe = regexp.MustCompile(
	`("(?i:token|password|secret|key|auth|credential|api_?key|access_?key|private_?key|bearer|authorization|client_?secret)")\s*:\s*"([^"]*)"`,
)

// MaskSensitiveFields redacts values of sensitive-looking keys in JSON-like content.
func MaskSensitiveFields(content string) string {
	return sensitiveFieldRe.ReplaceAllString(content, `$1: "[REDACTED]"`)
}
