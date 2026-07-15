package extension

import (
	"encoding/base64"
	"os"
	"path/filepath"
	"testing"
)

// TestParseToolResultWithImagesStructured pins the structured image-return path:
// a { content, images:[{path, mediaType}] } response must read each file,
// base64-encode the bytes, and populate ToolResult.Images with Type="base64".
// Reverting the parseToolResultWithImages call in host_transpile.go leaves
// images dropped; this test pins the parser itself.
func TestParseToolResultWithImagesStructured(t *testing.T) {
	dir := t.TempDir()
	imgPath := filepath.Join(dir, "shot.png")
	payload := []byte{0x89, 0x50, 0x4e, 0x47} // arbitrary bytes
	if err := os.WriteFile(imgPath, payload, 0o644); err != nil {
		t.Fatalf("write temp image: %v", err)
	}

	raw := []byte(`{"content":"here is the chart","images":[{"path":"` + imgPath + `","mediaType":"image/png"}]}`)
	result, ok := parseToolResultWithImages(raw, "test-ext")
	if !ok {
		t.Fatal("parseToolResultWithImages returned ok=false for a structured images response")
	}
	if result.Content != "here is the chart" {
		t.Errorf("Content = %q, want the response content", result.Content)
	}
	if len(result.Images) != 1 {
		t.Fatalf("Images len = %d, want 1", len(result.Images))
	}
	img := result.Images[0]
	if img.Type != "base64" {
		t.Errorf("Image Type = %q, want base64", img.Type)
	}
	if img.MediaType != "image/png" {
		t.Errorf("Image MediaType = %q, want image/png", img.MediaType)
	}
	if want := base64.StdEncoding.EncodeToString(payload); img.Data != want {
		t.Errorf("Image Data = %q, want base64 of the file bytes %q", img.Data, want)
	}
}

// TestParseToolResultWithImagesTextFallback pins that non-image responses fall
// through untouched: a bare object with no images array returns ok=false so the
// caller keeps the existing text-formatting behavior.
func TestParseToolResultWithImagesTextFallback(t *testing.T) {
	for _, raw := range []string{
		`{"content":"just text"}`,
		`"a bare string"`,
		`42`,
		`{"content":"empty images","images":[]}`,
	} {
		if _, ok := parseToolResultWithImages([]byte(raw), "test-ext"); ok {
			t.Errorf("raw %q: ok=true, want false (should use text path)", raw)
		}
	}
}

// TestParseToolResultWithImagesSkipsBadEntries pins resilience: an entry with a
// missing path or an unreadable file is skipped (logged), not fatal. A single
// good image among bad ones still comes through.
func TestParseToolResultWithImagesSkipsBadEntries(t *testing.T) {
	dir := t.TempDir()
	good := filepath.Join(dir, "good.png")
	if err := os.WriteFile(good, []byte{1, 2, 3}, 0o644); err != nil {
		t.Fatalf("write temp image: %v", err)
	}
	missing := filepath.Join(dir, "does-not-exist.png")

	raw := []byte(`{"content":"mixed","images":[` +
		`{"path":"","mediaType":"image/png"},` +
		`{"path":"` + missing + `","mediaType":"image/png"},` +
		`{"path":"` + good + `","mediaType":"image/png"}]}`)

	result, ok := parseToolResultWithImages(raw, "test-ext")
	if !ok {
		t.Fatal("ok=false, want true (the array was non-empty)")
	}
	if len(result.Images) != 1 {
		t.Fatalf("Images len = %d, want 1 (only the readable image survives)", len(result.Images))
	}
}
