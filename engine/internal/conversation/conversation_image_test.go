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
	os.WriteFile(filepath.Join(dir, "CLAUDE.md"), []byte("# test context"), 0o644)

	results := DiscoverContextFiles(dir, nil)
	found := false
	for _, r := range results {
		if r.Path == filepath.Join(dir, "CLAUDE.md") {
			found = true
			if r.Content != "# test context" {
				t.Errorf("unexpected content: %q", r.Content)
			}
		}
	}
	if !found {
		t.Fatal("expected to find CLAUDE.md in cwd")
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

// --- NavigateTree sets leafID and rebuilds ---
