package providers

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"sort"
	"strings"
	"time"

	"github.com/dsswift/ion/engine/internal/network"
	"github.com/dsswift/ion/engine/internal/types"
)

// BedrockOptions configures the AWS Bedrock provider.
type BedrockOptions struct {
	Region          string
	AccessKeyID     string
	SecretAccessKey  string
	SessionToken    string
}

type bedrockProvider struct {
	region         string
	accessKeyID    string
	secretAccessKey string
	sessionToken   string
	client         *http.Client
}

// NewBedrockProvider creates an AWS Bedrock provider that uses the ConverseStream
// API with AWS Signature V4 signing. Translates Bedrock events to Anthropic
// canonical format.
func NewBedrockProvider(opts *BedrockOptions) LlmProvider {
	region := "us-east-1"
	var accessKey, secretKey, sessionToken string

	if opts != nil {
		if opts.Region != "" {
			region = opts.Region
		}
		accessKey = opts.AccessKeyID
		secretKey = opts.SecretAccessKey
		sessionToken = opts.SessionToken
	}

	if accessKey == "" {
		accessKey = os.Getenv("AWS_ACCESS_KEY_ID")
	}
	if secretKey == "" {
		secretKey = os.Getenv("AWS_SECRET_ACCESS_KEY")
	}
	if sessionToken == "" {
		sessionToken = os.Getenv("AWS_SESSION_TOKEN")
	}
	if region == "us-east-1" {
		if r := os.Getenv("AWS_REGION"); r != "" {
			region = r
		} else if r := os.Getenv("AWS_DEFAULT_REGION"); r != "" {
			region = r
		}
	}

	return &bedrockProvider{
		region:          region,
		accessKeyID:     accessKey,
		secretAccessKey: secretKey,
		sessionToken:    sessionToken,
		client:          &http.Client{Transport: network.GetHTTPTransport()},
	}
}

func (p *bedrockProvider) ID() string { return "bedrock" }

func (p *bedrockProvider) Stream(ctx context.Context, opts types.LlmStreamOptions) (<-chan types.LlmStreamEvent, <-chan error) {
	events := make(chan types.LlmStreamEvent, 32)
	errc := make(chan error, 1)

	go func() {
		defer close(events)
		defer close(errc)

		if err := p.doStream(ctx, opts, events); err != nil {
			errc <- err
		}
	}()

	return events, errc
}

func (p *bedrockProvider) doStream(ctx context.Context, opts types.LlmStreamOptions, events chan<- types.LlmStreamEvent) error {
	maxTokens := opts.MaxTokens
	if maxTokens == 0 {
		maxTokens = 8192
	}

	body := map[string]any{
		"modelId": opts.Model,
		"system":  []map[string]any{{"text": opts.System}},
		"messages": formatBedrockMessages(opts.Messages),
		"inferenceConfig": map[string]any{"maxTokens": maxTokens},
	}

	if len(opts.Tools) > 0 {
		tools := make([]map[string]any, len(opts.Tools))
		for i, t := range opts.Tools {
			tools[i] = map[string]any{
				"toolSpec": map[string]any{
					"name":        t.Name,
					"description": t.Description,
					"inputSchema": map[string]any{"json": t.InputSchema},
				},
			}
		}
		body["toolConfig"] = map[string]any{"tools": tools}
	}

	raw, err := json.Marshal(body)
	if err != nil {
		return NewProviderError(ErrUnknown, fmt.Sprintf("marshal request: %v", err), 0, false)
	}

	url := fmt.Sprintf("https://bedrock-runtime.%s.amazonaws.com/model/%s/converse-stream",
		p.region, opts.Model)

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(raw))
	if err != nil {
		return NewProviderError(ErrUnknown, fmt.Sprintf("create request: %v", err), 0, false)
	}

	req.Header.Set("Content-Type", "application/json")

	// Sign with AWS Signature V4
	if err := p.signV4(req, raw); err != nil {
		return NewProviderError(ErrAuth, fmt.Sprintf("AWS signing failed: %v", err), 0, false)
	}

	resp, err := p.client.Do(req)
	if err != nil {
		return NewProviderError(ErrNetwork, err.Error(), 0, true)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		respBody, _ := io.ReadAll(resp.Body)
		return classifyBedrockError(resp.StatusCode, string(respBody))
	}

	// Emit message_start
	if err := sendEvent(ctx, events, types.LlmStreamEvent{
		Type: "message_start",
		MessageInfo: &types.LlmStreamMessageInfo{
			ID:    fmt.Sprintf("msg_bedrock_%d", time.Now().UnixMilli()),
			Model: opts.Model,
			Usage: types.LlmUsage{},
		},
	}); err != nil {
		return err
	}

	// Bedrock uses application/vnd.amazon.eventstream for streaming.
	// For SSE-based streaming fallback, parse line-delimited JSON events.
	return p.parseBedrockStream(ctx, resp.Body, events)
}

func (p *bedrockProvider) parseBedrockStream(ctx context.Context, reader io.Reader, events chan<- types.LlmStreamEvent) error {
	// Bedrock ConverseStream returns event-stream binary format. For the raw
	// HTTP implementation we parse SSE if the endpoint supports it, or we
	// fall back to reading the full response body as JSON events.
	//
	// The proper implementation would parse the event-stream binary protocol.
	// For now we read SSE events which works with the REST API streaming.
	contentIndex := 0
	var totalInputToks, totalOutputToks int

	for sse := range ParseSSEStream(reader) {
		if sse.Data == "" {
			continue
		}

		var event map[string]any
		if err := json.Unmarshal([]byte(sse.Data), &event); err != nil {
			continue
		}

		// contentBlockStart
		if start, ok := event["contentBlockStart"].(map[string]any); ok {
			startInfo, _ := start["start"].(map[string]any)
			if tu, ok := startInfo["toolUse"].(map[string]any); ok {
				if err := sendEvent(ctx, events, types.LlmStreamEvent{
					Type:       "content_block_start",
					BlockIndex: contentIndex,
					ContentBlock: &types.LlmStreamContentBlock{
						Type: "tool_use",
						ID:   fmt.Sprintf("%v", tu["toolUseId"]),
						Name: fmt.Sprintf("%v", tu["name"]),
					},
				}); err != nil {
					return err
				}
			} else {
				if err := sendEvent(ctx, events, types.LlmStreamEvent{
					Type:         "content_block_start",
					BlockIndex:   contentIndex,
					ContentBlock: &types.LlmStreamContentBlock{Type: "text", Text: ""},
				}); err != nil {
					return err
				}
			}
		}

		// contentBlockDelta
		if d, ok := event["contentBlockDelta"].(map[string]any); ok {
			if delta, ok := d["delta"].(map[string]any); ok {
				if text, ok := delta["text"].(string); ok {
					if err := sendEvent(ctx, events, types.LlmStreamEvent{
						Type:       "content_block_delta",
						BlockIndex: contentIndex,
						Delta:      &types.LlmStreamDelta{Type: "text_delta", Text: text},
					}); err != nil {
						return err
					}
				}
				if tu, ok := delta["toolUse"].(map[string]any); ok {
					if input, ok := tu["input"].(string); ok {
						if err := sendEvent(ctx, events, types.LlmStreamEvent{
							Type:       "content_block_delta",
							BlockIndex: contentIndex,
							Delta:      &types.LlmStreamDelta{Type: "input_json_delta", PartialJSON: input},
						}); err != nil {
							return err
						}
					}
				}
			}
		}

		// contentBlockStop
		if _, ok := event["contentBlockStop"]; ok {
			if err := sendEvent(ctx, events, types.LlmStreamEvent{
				Type:       "content_block_stop",
				BlockIndex: contentIndex,
			}); err != nil {
				return err
			}
			contentIndex++
		}

		// metadata
		if meta, ok := event["metadata"].(map[string]any); ok {
			if usage, ok := meta["usage"].(map[string]any); ok {
				if v, ok := usage["inputTokens"].(float64); ok {
					totalInputToks = int(v)
				}
				if v, ok := usage["outputTokens"].(float64); ok {
					totalOutputToks = int(v)
				}
			}
		}

		// messageStop
		if stop, ok := event["messageStop"].(map[string]any); ok {
			reason := "end_turn"
			if sr, ok := stop["stopReason"].(string); ok {
				switch sr {
				case "tool_use":
					reason = "tool_use"
				case "max_tokens":
					reason = "max_tokens"
				}
			}
			if err := sendEvent(ctx, events, types.LlmStreamEvent{
				Type:  "message_delta",
				Delta: &types.LlmStreamDelta{Type: "message_delta", StopReason: &reason},
				DeltaUsage: &types.LlmUsage{
					InputTokens:  totalInputToks,
					OutputTokens: totalOutputToks,
				},
			}); err != nil {
				return err
			}
		}
	}

	return sendEvent(ctx, events, types.LlmStreamEvent{Type: "message_stop"})
}

func formatBedrockMessages(messages []types.LlmMessage) []map[string]any {
	var result []map[string]any
	for _, msg := range messages {
		blocks := contentBlocks(msg)
		if blocks == nil {
			if s, ok := msg.Content.(string); ok {
				result = append(result, map[string]any{
					"role":    msg.Role,
					"content": []map[string]any{{"text": s}},
				})
			}
			continue
		}

		var content []map[string]any
		for _, b := range blocks {
			switch b.Type {
			case "text":
				content = append(content, map[string]any{"text": b.Text})
			case "tool_use":
				content = append(content, map[string]any{
					"toolUse": map[string]any{
						"toolUseId": b.ID,
						"name":      b.Name,
						"input":     b.Input,
					},
				})
			case "tool_result":
				status := "success"
				if b.IsError != nil && *b.IsError {
					status = "error"
				}
				content = append(content, map[string]any{
					"toolResult": map[string]any{
						"toolUseId": b.ToolUseID,
						"content":   []map[string]any{{"text": b.Content}},
						"status":    status,
					},
				})
			case "image":
				if b.Source != nil {
					mediaType := b.Source.MediaType
					parts := strings.SplitN(mediaType, "/", 2)
					format := "jpeg"
					if len(parts) == 2 {
						format = parts[1]
					}
					content = append(content, map[string]any{
						"image": map[string]any{
							"format": format,
							"source": map[string]any{"bytes": b.Source.Data},
						},
					})
				}
			}
		}
		if len(content) > 0 {
			result = append(result, map[string]any{"role": msg.Role, "content": content})
		}
	}
	return result
}

func classifyBedrockError(status int, body string) *ProviderError {
	msg := fmt.Sprintf("Bedrock API error (HTTP %d): %s", status, body)
	bodyLower := strings.ToLower(body)

	if status == 429 || strings.Contains(bodyLower, "throttling") {
		return NewProviderError(ErrRateLimit, msg, status, true)
	}
	if status == 401 || status == 403 {
		return NewProviderError(ErrAuth, msg, status, false)
	}
	if status >= 500 {
		return NewProviderError(ErrOverloaded, msg, status, true)
	}
	if strings.Contains(bodyLower, "too long") || strings.Contains(bodyLower, "validation") {
		return NewProviderError(ErrPromptTooLong, msg, status, false)
	}
	return NewProviderError(ErrUnknown, msg, status, false)
}

// --- AWS Signature V4 ---

func (p *bedrockProvider) signV4(req *http.Request, payload []byte) error {
	if p.accessKeyID == "" || p.secretAccessKey == "" {
		return fmt.Errorf("AWS credentials not configured")
	}

	now := time.Now().UTC()
	datestamp := now.Format("20060102")
	amzDate := now.Format("20060102T150405Z")

	req.Header.Set("X-Amz-Date", amzDate)
	if p.sessionToken != "" {
		req.Header.Set("X-Amz-Security-Token", p.sessionToken)
	}
	req.Header.Set("Host", req.URL.Host)

	// Create canonical request
	payloadHash := sha256Hex(payload)

	signedHeaders := canonicalHeaders(req)
	canonicalReq := strings.Join([]string{
		req.Method,
		req.URL.Path,
		req.URL.RawQuery,
		canonicalHeaderString(req, signedHeaders),
		strings.Join(signedHeaders, ";"),
		payloadHash,
	}, "\n")

	// Create string to sign
	credentialScope := fmt.Sprintf("%s/%s/bedrock/aws4_request", datestamp, p.region)
	stringToSign := strings.Join([]string{
		"AWS4-HMAC-SHA256",
		amzDate,
		credentialScope,
		sha256Hex([]byte(canonicalReq)),
	}, "\n")

	// Calculate signature
	signingKey := deriveSigningKey(p.secretAccessKey, datestamp, p.region, "bedrock")
	signature := hex.EncodeToString(hmacSHA256(signingKey, []byte(stringToSign)))

	// Set Authorization header
	auth := fmt.Sprintf("AWS4-HMAC-SHA256 Credential=%s/%s, SignedHeaders=%s, Signature=%s",
		p.accessKeyID, credentialScope, strings.Join(signedHeaders, ";"), signature)
	req.Header.Set("Authorization", auth)

	return nil
}

func canonicalHeaders(req *http.Request) []string {
	var headers []string
	for k := range req.Header {
		headers = append(headers, strings.ToLower(k))
	}
	sort.Strings(headers)
	return headers
}

func canonicalHeaderString(req *http.Request, signedHeaders []string) string {
	var b strings.Builder
	for _, h := range signedHeaders {
		b.WriteString(h)
		b.WriteString(":")
		b.WriteString(strings.TrimSpace(req.Header.Get(h)))
		b.WriteString("\n")
	}
	return b.String()
}

func sha256Hex(data []byte) string {
	h := sha256.Sum256(data)
	return hex.EncodeToString(h[:])
}

func hmacSHA256(key, data []byte) []byte {
	h := hmac.New(sha256.New, key)
	h.Write(data)
	return h.Sum(nil)
}

func deriveSigningKey(secret, datestamp, region, service string) []byte {
	kDate := hmacSHA256([]byte("AWS4"+secret), []byte(datestamp))
	kRegion := hmacSHA256(kDate, []byte(region))
	kService := hmacSHA256(kRegion, []byte(service))
	return hmacSHA256(kService, []byte("aws4_request"))
}
