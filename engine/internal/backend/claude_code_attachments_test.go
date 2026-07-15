package backend

import (
	"encoding/base64"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/dsswift/ion/engine/internal/types"
)

// writeTempPDF writes n bytes to a .pdf file in the test's temp dir and returns
// its absolute path.
func writeTempPDF(t *testing.T, name string, n int) string {
	t.Helper()
	p := filepath.Join(t.TempDir(), name)
	if err := os.WriteFile(p, []byte(strings.Repeat("x", n)), 0o600); err != nil {
		t.Fatalf("write temp pdf: %v", err)
	}
	return p
}

func blockType(b map[string]interface{}) string {
	s, _ := b["type"].(string)
	return s
}

// Regression guard: no markers and no attachments returns exactly one text
// block holding the original prompt -- identical to the pre-#789 behavior.
func TestBuildCliUserContent_PlainPrompt(t *testing.T) {
	blocks := buildCliUserContent("hello world", nil)
	if len(blocks) != 1 {
		t.Fatalf("want 1 block, got %d", len(blocks))
	}
	if blockType(blocks[0]) != "text" || blocks[0]["text"] != "hello world" {
		t.Fatalf("unexpected text block: %#v", blocks[0])
	}
}

func TestBuildCliUserContent_PDFMarkerBecomesDocumentBlock(t *testing.T) {
	pdf := writeTempPDF(t, "manual.pdf", 1024)
	prompt := "summarize this [Attached file: " + pdf + "] please"

	blocks := buildCliUserContent(prompt, nil)
	if len(blocks) != 2 {
		t.Fatalf("want text + document, got %d blocks: %#v", len(blocks), blocks)
	}
	// Marker stripped from the text block.
	if txt, _ := blocks[0]["text"].(string); strings.Contains(txt, "[Attached") {
		t.Fatalf("marker not stripped from text: %q", txt)
	}
	doc := blocks[1]
	if blockType(doc) != "document" {
		t.Fatalf("want document block, got %q", blockType(doc))
	}
	src, _ := doc["source"].(map[string]interface{})
	if src["media_type"] != "application/pdf" || src["type"] != "base64" {
		t.Fatalf("bad document source: %#v", src)
	}
	if _, err := base64.StdEncoding.DecodeString(src["data"].(string)); err != nil {
		t.Fatalf("document data is not valid base64: %v", err)
	}
}

func TestBuildCliUserContent_ImageAttachmentBecomesImageBlock(t *testing.T) {
	// An image delivered via opts.Attachments plus its redundant marker.
	prompt := "look [Attached image: /tmp/shot.png]"
	atts := []types.ImageAttachment{{MediaType: "image/png", Data: "Zm9v", Path: "/tmp/shot.png"}}

	blocks := buildCliUserContent(prompt, atts)
	if len(blocks) != 2 {
		t.Fatalf("want text + image, got %d blocks: %#v", len(blocks), blocks)
	}
	if txt, _ := blocks[0]["text"].(string); strings.Contains(txt, "[Attached") {
		t.Fatalf("image marker not stripped from text: %q", txt)
	}
	if blockType(blocks[1]) != "image" {
		t.Fatalf("want image block, got %q", blockType(blocks[1]))
	}
}

func TestBuildCliUserContent_OversizedPDFKeepsMarker(t *testing.T) {
	pdf := writeTempPDF(t, "huge.pdf", maxInlineAttachmentBytes+1)
	prompt := "read [Attached file: " + pdf + "]"

	blocks := buildCliUserContent(prompt, nil)
	if len(blocks) != 1 {
		t.Fatalf("oversized file should not be inlined; got %d blocks", len(blocks))
	}
	if txt, _ := blocks[0]["text"].(string); !strings.Contains(txt, "[Attached file:") {
		t.Fatalf("oversized-file marker should be preserved for Read fallback: %q", txt)
	}
}

func TestBuildCliUserContent_NonPDFAndPlanMarkersUntouched(t *testing.T) {
	prompt := "x [Attached file: /tmp/notes.txt] y [Attached plan: /tmp/plan.md]"
	blocks := buildCliUserContent(prompt, nil)
	if len(blocks) != 1 {
		t.Fatalf("non-pdf/plan markers should not produce media blocks; got %d", len(blocks))
	}
	txt, _ := blocks[0]["text"].(string)
	if !strings.Contains(txt, "notes.txt") || !strings.Contains(txt, "plan.md") {
		t.Fatalf("non-pdf/plan markers should be preserved: %q", txt)
	}
}

func TestBuildCliUserContent_DuplicatePDFMarkerInlinedOnce(t *testing.T) {
	pdf := writeTempPDF(t, "dup.pdf", 512)
	prompt := "[Attached file: " + pdf + "] and again [Attached file: " + pdf + "]"

	blocks := buildCliUserContent(prompt, nil)
	docs := 0
	for _, b := range blocks {
		if blockType(b) == "document" {
			docs++
		}
	}
	if docs != 1 {
		t.Fatalf("duplicate marker should inline once, got %d document blocks", docs)
	}
	if txt, _ := blocks[0]["text"].(string); strings.Contains(txt, "[Attached") {
		t.Fatalf("both duplicate markers should be stripped: %q", txt)
	}
}

// Wire-delivered PDF (remote client): a document block is built straight from
// Data with zero disk access, and a matching `file` marker is stripped so the
// model cannot try to Read a client-local path (#853).
func TestBuildCliUserContent_WirePDFDocumentBlock(t *testing.T) {
	pdfB64 := base64.StdEncoding.EncodeToString([]byte("%PDF-1.4 fake"))
	clientPath := "/Users/someone-else/Downloads/report.pdf" // does not exist here
	prompt := "[Attached file: " + clientPath + "]\nsummarize this"
	blocks := buildCliUserContent(prompt, []types.ImageAttachment{
		{MediaType: "application/pdf", Data: pdfB64, Path: clientPath},
	})
	if len(blocks) != 2 {
		t.Fatalf("want text+document, got %d blocks: %#v", len(blocks), blocks)
	}
	if blockType(blocks[1]) != "document" {
		t.Fatalf("want document block, got %q", blockType(blocks[1]))
	}
	src := blocks[1]["source"].(map[string]interface{})
	if src["media_type"] != "application/pdf" || src["data"] != pdfB64 {
		t.Fatalf("document source mismatch: %#v", src)
	}
	text := blocks[0]["text"].(string)
	if strings.Contains(text, clientPath) || strings.Contains(text, "[Attached file:") {
		t.Fatalf("file marker not stripped: %q", text)
	}
}

// Mixed wire attachments keep their relative order and unknown media types are
// dropped without breaking the rest.
func TestBuildCliUserContent_WireMixedAndUnknown(t *testing.T) {
	blocks := buildCliUserContent("look", []types.ImageAttachment{
		{MediaType: "image/png", Data: "aW1n"},
		{MediaType: "application/zip", Data: "emlw"}, // dropped
		{MediaType: "application/pdf", Data: "cGRm"},
	})
	if len(blocks) != 3 {
		t.Fatalf("want text+image+document, got %d: %#v", len(blocks), blocks)
	}
	if blockType(blocks[1]) != "image" || blockType(blocks[2]) != "document" {
		t.Fatalf("unexpected order: %q, %q", blockType(blocks[1]), blockType(blocks[2]))
	}
}

// A `file` marker whose path matches no wire attachment stays untouched (the
// local-disk #789 path or Read fallback still owns it).
func TestBuildCliUserContent_UnmatchedFileMarkerKept(t *testing.T) {
	prompt := "[Attached file: /nonexistent/other.pdf] and [Attached image: /tmp/x.png]"
	blocks := buildCliUserContent(prompt, []types.ImageAttachment{
		{MediaType: "application/pdf", Data: "cGRm", Path: "/somewhere/else.pdf"},
	})
	text := blocks[0]["text"].(string)
	if !strings.Contains(text, "[Attached file: /nonexistent/other.pdf]") {
		t.Fatalf("unmatched file marker should survive: %q", text)
	}
	if strings.Contains(text, "[Attached image:") {
		t.Fatalf("image marker should be stripped when wire attachments exist: %q", text)
	}
}
