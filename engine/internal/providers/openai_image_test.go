package providers

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/dsswift/ion/engine/internal/types"
)

// TestImageModelCatalogEntries pins that the embedded catalog registers
// dall-e-3 and gpt-image-1 with modelKind="image" after init().
func TestImageModelCatalogEntries(t *testing.T) {
	for _, id := range []string{"dall-e-3", "gpt-image-1"} {
		info := GetModelInfo(id)
		if info == nil {
			t.Errorf("%s: not found in model registry after init()", id)
			continue
		}
		if info.ProviderID != "openai" {
			t.Errorf("%s: ProviderID = %q, want %q", id, info.ProviderID, "openai")
		}
		if info.ModelKind != "image" {
			t.Errorf("%s: ModelKind = %q, want %q", id, info.ModelKind, "image")
		}
	}
}

// TestImageModelListModelsKind pins that ListModels propagates ModelKind for
// the image catalog entries.
func TestImageModelListModelsKind(t *testing.T) {
	entries := ListModels()
	byID := make(map[string]types.ModelEntry, len(entries))
	for _, e := range entries {
		byID[e.ID] = e
	}
	for _, id := range []string{"dall-e-3", "gpt-image-1"} {
		e, ok := byID[id]
		if !ok {
			t.Errorf("%s: not found in ListModels()", id)
			continue
		}
		if e.ModelKind != "image" {
			t.Errorf("%s: ModelKind = %q in ListModels(), want %q", id, e.ModelKind, "image")
		}
	}
}

// TestResolveImageProvider pins that ResolveImageProvider returns a non-nil
// ImageProvider for the two image models after init().
func TestResolveImageProvider(t *testing.T) {
	for _, id := range []string{"dall-e-3", "gpt-image-1"} {
		p := ResolveImageProvider(id)
		if p == nil {
			t.Errorf("ResolveImageProvider(%q) = nil, want non-nil", id)
		}
	}
}

// TestOpenAIImageProviderGenerate pins the HTTP request shape sent to the
// images/generations endpoint using a mock server.
func TestOpenAIImageProviderGenerate(t *testing.T) {
	const wantModel = "dall-e-3"
	const wantPrompt = "a red bicycle on a beach"
	const wantB64 = "abc123base64=="
	const wantRevised = "a red racing bicycle parked on a sandy beach"

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Verify path
		if r.URL.Path != "/v1/images/generations" {
			t.Errorf("path = %q, want /v1/images/generations", r.URL.Path)
		}
		if r.Method != http.MethodPost {
			t.Errorf("method = %q, want POST", r.Method)
		}

		// Decode and verify body
		var body map[string]any
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Errorf("decode request body: %v", err)
		}
		if body["model"] != wantModel {
			t.Errorf("body.model = %v, want %q", body["model"], wantModel)
		}
		if body["prompt"] != wantPrompt {
			t.Errorf("body.prompt = %v, want %q", body["prompt"], wantPrompt)
		}
		if body["response_format"] != "b64_json" {
			t.Errorf("body.response_format = %v, want b64_json", body["response_format"])
		}
		n, _ := body["n"].(float64)
		if n != 1 {
			t.Errorf("body.n = %v, want 1", n)
		}

		// Return mock response
		w.Header().Set("Content-Type", "application/json")
		resp := map[string]any{
			"data": []map[string]any{
				{"b64_json": wantB64, "revised_prompt": wantRevised},
			},
		}
		if err := json.NewEncoder(w).Encode(resp); err != nil {
			t.Errorf("encode response: %v", err)
		}
	}))
	defer srv.Close()

	p := NewOpenAIImageProvider(&ProviderOptions{
		BaseURL: srv.URL,
		APIKey:  "test-key",
	})

	results, err := p.Generate(context.Background(), types.ImageGenerateOptions{
		Model:  wantModel,
		Prompt: wantPrompt,
	})
	if err != nil {
		t.Fatalf("Generate() error = %v", err)
	}
	if len(results) != 1 {
		t.Fatalf("len(results) = %d, want 1", len(results))
	}
	if results[0].Data != wantB64 {
		t.Errorf("result.Data = %q, want %q", results[0].Data, wantB64)
	}
	if results[0].RevisedPrompt != wantRevised {
		t.Errorf("result.RevisedPrompt = %q, want %q", results[0].RevisedPrompt, wantRevised)
	}
	if results[0].MediaType != "image/png" {
		t.Errorf("result.MediaType = %q, want image/png", results[0].MediaType)
	}
}

// TestOpenAIImageProviderAuthHeader pins that the image provider honors the
// AuthHeader option the same way the chat provider does (setAuthHeader):
// "x-api-key" sends the key in the x-api-key header with no Authorization
// header (APIM subscription-key gateways), and the default sends
// Authorization: Bearer. Without this parity a gateway config that works for
// chat would 401 on image calls.
func TestOpenAIImageProviderAuthHeader(t *testing.T) {
	cases := []struct {
		name       string
		authHeader string
		check      func(t *testing.T, r *http.Request)
	}{
		{
			name:       "default bearer",
			authHeader: "",
			check: func(t *testing.T, r *http.Request) {
				if got := r.Header.Get("Authorization"); got != "Bearer test-key" {
					t.Errorf("Authorization = %q, want %q", got, "Bearer test-key")
				}
			},
		},
		{
			name:       "x-api-key gateway style",
			authHeader: "x-api-key",
			check: func(t *testing.T, r *http.Request) {
				if got := r.Header.Get("x-api-key"); got != "test-key" {
					t.Errorf("x-api-key = %q, want %q", got, "test-key")
				}
				if got := r.Header.Get("Authorization"); got != "" {
					t.Errorf("Authorization = %q, want empty when x-api-key style is configured", got)
				}
			},
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				tc.check(t, r)
				w.Header().Set("Content-Type", "application/json")
				if err := json.NewEncoder(w).Encode(map[string]any{
					"data": []map[string]any{{"b64_json": "aaaa"}},
				}); err != nil {
					t.Errorf("encode response: %v", err)
				}
			}))
			defer srv.Close()

			p := NewOpenAIImageProvider(&ProviderOptions{
				BaseURL:    srv.URL,
				APIKey:     "test-key",
				AuthHeader: tc.authHeader,
			})
			if _, err := p.Generate(context.Background(), types.ImageGenerateOptions{
				Model:  "dall-e-3",
				Prompt: "test",
			}); err != nil {
				t.Fatalf("Generate() error = %v", err)
			}
		})
	}
}

// TestBuildImageEndpoint pins the URL construction for both /v1-suffixed and
// bare base URLs.
func TestBuildImageEndpoint(t *testing.T) {
	cases := []struct {
		base string
		want string
	}{
		{"https://api.openai.com", "https://api.openai.com/v1/images/generations"},
		{"https://api.openai.com/v1", "https://api.openai.com/v1/images/generations"},
		{"http://localhost:8080/v1", "http://localhost:8080/v1/images/generations"},
	}
	for _, tc := range cases {
		got := buildImageEndpoint(tc.base)
		if got != tc.want {
			t.Errorf("buildImageEndpoint(%q) = %q, want %q", tc.base, got, tc.want)
		}
	}
}
