package conversation

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestEncodeImage(t *testing.T) {
	dir := t.TempDir()

	// Create a tiny PNG (just enough bytes to not be empty)
	pngData := []byte{
		0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A,
		0x00, 0x00, 0x00, 0x0D, 0x49, 0x48, 0x44, 0x52,
	}
	pngPath := filepath.Join(dir, "test.png")
	os.WriteFile(pngPath, pngData, 0o644)

	block, err := EncodeImage(pngPath)
	if err != nil {
		t.Fatal(err)
	}
	if block.Type != "image" {
		t.Errorf("type = %v, want image", block.Type)
	}
	if block.Source == nil {
		t.Fatal("expected source to be set")
	}
	if block.Source.MediaType != "image/png" {
		t.Errorf("media_type = %v, want image/png", block.Source.MediaType)
	}
	if block.Source.Data == "" {
		t.Error("base64 data should not be empty")
	}
}

func TestEncodeImageUnsupportedFormat(t *testing.T) {
	dir := t.TempDir()
	bmpPath := filepath.Join(dir, "test.bmp")
	os.WriteFile(bmpPath, []byte("BM"), 0o644)

	_, err := EncodeImage(bmpPath)
	if err == nil {
		t.Error("expected error for unsupported format")
	}
}

func TestEncodeImageNotFound(t *testing.T) {
	_, err := EncodeImage("/nonexistent/image.png")
	if err == nil {
		t.Error("expected error for missing file")
	}
}

// --- Deep branching ---

func TestDiscoverContextFiles_FindsInCwd(t *testing.T) {
	dir := t.TempDir()
	os.WriteFile(filepath.Join(dir, "AGENTS.md"), []byte("# test context"), 0o644)

	results := DiscoverContextFiles(dir, nil)
	found := false
	for _, r := range results {
		if r.Path == filepath.Join(dir, "AGENTS.md") {
			found = true
			if r.Content != "# test context" {
				t.Errorf("unexpected content: %q", r.Content)
			}
		}
	}
	if !found {
		t.Fatal("expected to find AGENTS.md in cwd")
	}
}

func TestDiscoverContextFiles_EmptyDir(t *testing.T) {
	dir := t.TempDir()

	results := DiscoverContextFiles(dir, []string{"NONEXISTENT.md"})
	if len(results) != 0 {
		t.Fatalf("expected 0 results, got %d", len(results))
	}
}

// --- Encode image: oversized file ---

func TestEncodeImage_OversizedFile(t *testing.T) {
	dir := t.TempDir()
	bigPath := filepath.Join(dir, "big.png")
	// Write a file just over 20MB
	buf := make([]byte, 21*1024*1024)
	os.WriteFile(bigPath, buf, 0o644)

	_, err := EncodeImage(bigPath)
	if err == nil {
		t.Fatal("expected error for oversized image")
	}
	if !strings.Contains(err.Error(), "too large") {
		t.Fatalf("expected 'too large' in error, got %q", err.Error())
	}
}

// --- JSONL: preserves metadata ---

func TestEncodeImage_JPEG(t *testing.T) {
	dir := t.TempDir()
	jpgPath := filepath.Join(dir, "test.jpg")
	os.WriteFile(jpgPath, []byte{0xFF, 0xD8, 0xFF, 0xE0}, 0o644)

	block, err := EncodeImage(jpgPath)
	if err != nil {
		t.Fatal(err)
	}
	if block.Source.MediaType != "image/jpeg" {
		t.Errorf("media_type = %q, want image/jpeg", block.Source.MediaType)
	}
}

func TestEncodeImage_WebP(t *testing.T) {
	dir := t.TempDir()
	webpPath := filepath.Join(dir, "test.webp")
	os.WriteFile(webpPath, []byte("RIFF"), 0o644)

	block, err := EncodeImage(webpPath)
	if err != nil {
		t.Fatal(err)
	}
	if block.Source.MediaType != "image/webp" {
		t.Errorf("media_type = %q, want image/webp", block.Source.MediaType)
	}
}

func TestEncodeImage_GIF(t *testing.T) {
	dir := t.TempDir()
	gifPath := filepath.Join(dir, "test.gif")
	os.WriteFile(gifPath, []byte("GIF89a"), 0o644)

	block, err := EncodeImage(gifPath)
	if err != nil {
		t.Fatal(err)
	}
	if block.Source.MediaType != "image/gif" {
		t.Errorf("media_type = %q, want image/gif", block.Source.MediaType)
	}
}

// --- Content-sniff overrides extension (regression for JPEG-as-PNG crash) ---

// TestEncodeImage_MismatchedExtension_JPEGasPNG is the direct regression test
// for the crash in conversation 1783802415913-98e41ec70915. A file with a .png
// extension that contains JPEG bytes must produce media_type "image/jpeg", not
// "image/png". Anthropic's API independently inspects the bytes and rejects a
// mismatch with invalid_request_error, killing the session.
func TestEncodeImage_MismatchedExtension_JPEGasPNG(t *testing.T) {
	dir := t.TempDir()
	// Real JPEG magic bytes saved under a .png extension — exactly the scenario
	// that crashed the live conversation.
	jpegBytes := []byte{0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46, 0x49, 0x46, 0x00, 0x01}
	path := filepath.Join(dir, "icon.png") // .png extension, JPEG content
	os.WriteFile(path, jpegBytes, 0o644)

	block, err := EncodeImage(path)
	if err != nil {
		t.Fatalf("EncodeImage failed: %v", err)
	}
	if block.Source == nil {
		t.Fatal("expected source to be set")
	}
	// Sniff must win: bytes are JPEG regardless of the .png extension.
	if block.Source.MediaType != "image/jpeg" {
		t.Errorf("media_type = %q, want image/jpeg (sniff must override extension)", block.Source.MediaType)
	}
}

// TestEncodeImage_MismatchedExtension_WebPasJPG verifies that WebP bytes saved
// under a .jpg extension produce media_type "image/webp", not "image/jpeg".
func TestEncodeImage_MismatchedExtension_WebPasJPG(t *testing.T) {
	dir := t.TempDir()
	// Go's net/http.DetectContentType requires at least 16 bytes to identify
	// WebP: RIFF (4) + file-size (4) + WEBP (4) + VP8 chunk type (4).
	// Using VP8L (lossless) marker here.
	webpBytes := []byte{'R', 'I', 'F', 'F', 0x10, 0x00, 0x00, 0x00, 'W', 'E', 'B', 'P', 'V', 'P', '8', 'L'}
	path := filepath.Join(dir, "image.jpg") // .jpg extension, WebP content
	os.WriteFile(path, webpBytes, 0o644)

	block, err := EncodeImage(path)
	if err != nil {
		t.Fatalf("EncodeImage failed: %v", err)
	}
	if block.Source == nil {
		t.Fatal("expected source to be set")
	}
	if block.Source.MediaType != "image/webp" {
		t.Errorf("media_type = %q, want image/webp (sniff must override extension)", block.Source.MediaType)
	}
}

// TestEncodeImage_MismatchedExtension_PNGasJPG verifies that PNG bytes saved
// under a .jpg extension produce media_type "image/png", not "image/jpeg".
func TestEncodeImage_MismatchedExtension_PNGasJPG(t *testing.T) {
	dir := t.TempDir()
	// Minimal PNG header (8-byte PNG signature).
	pngBytes := []byte{0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A}
	path := filepath.Join(dir, "image.jpg") // .jpg extension, PNG content
	os.WriteFile(path, pngBytes, 0o644)

	block, err := EncodeImage(path)
	if err != nil {
		t.Fatalf("EncodeImage failed: %v", err)
	}
	if block.Source == nil {
		t.Fatal("expected source to be set")
	}
	if block.Source.MediaType != "image/png" {
		t.Errorf("media_type = %q, want image/png (sniff must override extension)", block.Source.MediaType)
	}
}

// TestEncodeImage_SniffFallsBackToExtension verifies that when
// DetectContentType cannot identify the format (returns
// "application/octet-stream"), EncodeImage falls back to the extension-derived
// MIME type rather than erroring. This keeps small/synthetic test fixtures
// working correctly.
func TestEncodeImage_SniffFallsBackToExtension(t *testing.T) {
	dir := t.TempDir()
	// Bytes that DetectContentType cannot identify — not a known magic number.
	unknownBytes := []byte{0x00, 0x01, 0x02, 0x03}
	path := filepath.Join(dir, "mystery.png") // extension says PNG
	os.WriteFile(path, unknownBytes, 0o644)

	block, err := EncodeImage(path)
	if err != nil {
		t.Fatalf("EncodeImage failed: %v", err)
	}
	if block.Source == nil {
		t.Fatal("expected source to be set")
	}
	// Sniff fails → extension fallback → image/png.
	if block.Source.MediaType != "image/png" {
		t.Errorf("media_type = %q, want image/png (extension fallback)", block.Source.MediaType)
	}
}

// --- NavigateTree sets leafID and rebuilds ---
