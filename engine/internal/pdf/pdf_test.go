package pdf

import (
	"encoding/base64"
	"os"
	"path/filepath"
	"testing"
)

func TestValidatePdf_ValidFile(t *testing.T) {
	tmp := filepath.Join(t.TempDir(), "test.pdf")
	content := []byte("%PDF-1.4 fake pdf content")
	if err := os.WriteFile(tmp, content, 0o644); err != nil {
		t.Fatal(err)
	}

	if err := ValidatePdf(tmp); err != nil {
		t.Errorf("ValidatePdf should accept valid PDF header, got: %v", err)
	}
}

func TestValidatePdf_NonPdfFile(t *testing.T) {
	tmp := filepath.Join(t.TempDir(), "notpdf.txt")
	if err := os.WriteFile(tmp, []byte("hello world this is not a pdf"), 0o644); err != nil {
		t.Fatal(err)
	}

	err := ValidatePdf(tmp)
	if err == nil {
		t.Error("ValidatePdf should reject non-PDF file")
	}
}

func TestValidatePdf_MissingFile(t *testing.T) {
	err := ValidatePdf("/tmp/does-not-exist-ever-12345.pdf")
	if err == nil {
		t.Error("ValidatePdf should return error for missing file")
	}
}

func TestEncodePdf_SmallFile(t *testing.T) {
	tmp := filepath.Join(t.TempDir(), "test.pdf")
	content := []byte("%PDF-1.4 small test content")
	if err := os.WriteFile(tmp, content, 0o644); err != nil {
		t.Fatal(err)
	}

	encoded, err := EncodePdf(tmp)
	if err != nil {
		t.Fatalf("EncodePdf returned error: %v", err)
	}

	expected := base64.StdEncoding.EncodeToString(content)
	if encoded != expected {
		t.Errorf("EncodePdf output mismatch\ngot:  %s\nwant: %s", encoded, expected)
	}
}

func TestEncodePdf_MissingFile(t *testing.T) {
	_, err := EncodePdf("/tmp/does-not-exist-ever-12345.pdf")
	if err == nil {
		t.Error("EncodePdf should return error for missing file")
	}
}

func TestExtractPdfPages_NoPdftoppm(t *testing.T) {
	// Use a valid PDF header so validation passes, but pdftoppm may not be installed.
	tmp := filepath.Join(t.TempDir(), "test.pdf")
	content := []byte("%PDF-1.4 fake pdf body")
	if err := os.WriteFile(tmp, content, 0o644); err != nil {
		t.Fatal(err)
	}

	_, err := ExtractPdfPages(tmp, "1")
	// If pdftoppm is not installed, we expect an error about it not being found.
	// If it IS installed, the fake PDF will cause pdftoppm to fail.
	// Either way, there should be an error since this is not a real PDF.
	if err == nil {
		t.Error("ExtractPdfPages should return error for fake PDF or missing pdftoppm")
	}
}
