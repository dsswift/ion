package backend

import (
	"testing"

	"github.com/dsswift/ion/engine/internal/types"
)

// buildUserContentBlocks is the seam the runloop uses to convert a text
// prompt + pre-encoded image/document attachments into structured content
// blocks. The provider formatters (anthropic, openai, google, bedrock)
// already handle image and document blocks; these tests pin the conversion
// contract.

func TestBuildUserContentBlocks_TextOnly_NoAttachments(t *testing.T) {
	blocks := buildUserContentBlocks("hello", nil)
	if len(blocks) != 1 {
		t.Fatalf("want 1 block, got %d", len(blocks))
	}
	if blocks[0].Type != "text" || blocks[0].Text != "hello" {
		t.Fatalf("want text/hello, got type=%q text=%q", blocks[0].Type, blocks[0].Text)
	}
}

func TestBuildUserContentBlocks_TextPlusOneImage(t *testing.T) {
	atts := []types.ImageAttachment{
		{MediaType: "image/jpeg", Data: "AAA=", Path: "/tmp/x.jpg"},
	}
	blocks := buildUserContentBlocks("what is this", atts)
	if len(blocks) != 2 {
		t.Fatalf("want 2 blocks, got %d", len(blocks))
	}
	if blocks[0].Type != "text" || blocks[0].Text != "what is this" {
		t.Fatalf("first block: want text/'what is this', got type=%q text=%q", blocks[0].Type, blocks[0].Text)
	}
	if blocks[1].Type != "image" {
		t.Fatalf("second block: want image, got %q", blocks[1].Type)
	}
	if blocks[1].Source == nil {
		t.Fatalf("image block missing Source")
	}
	if blocks[1].Source.Type != "base64" {
		t.Fatalf("image source type: want base64, got %q", blocks[1].Source.Type)
	}
	if blocks[1].Source.MediaType != "image/jpeg" {
		t.Fatalf("image media_type: want image/jpeg, got %q", blocks[1].Source.MediaType)
	}
	if blocks[1].Source.Data != "AAA=" {
		t.Fatalf("image data: want AAA=, got %q", blocks[1].Source.Data)
	}
}

func TestBuildUserContentBlocks_MultipleImagesPreserveOrder(t *testing.T) {
	atts := []types.ImageAttachment{
		{MediaType: "image/png", Data: "PNG1"},
		{MediaType: "image/jpeg", Data: "JPG2"},
	}
	blocks := buildUserContentBlocks("two", atts)
	if len(blocks) != 3 {
		t.Fatalf("want 3 blocks, got %d", len(blocks))
	}
	if blocks[1].Source.MediaType != "image/png" || blocks[1].Source.Data != "PNG1" {
		t.Fatalf("first image: got %+v", blocks[1].Source)
	}
	if blocks[2].Source.MediaType != "image/jpeg" || blocks[2].Source.Data != "JPG2" {
		t.Fatalf("second image: got %+v", blocks[2].Source)
	}
}

func TestBuildUserContentBlocks_DropsEmptyAttachments(t *testing.T) {
	atts := []types.ImageAttachment{
		{MediaType: "image/png", Data: ""},      // missing data
		{MediaType: "", Data: "AAA="},           // missing media type
		{MediaType: "image/jpeg", Data: "GOOD"}, // valid
	}
	blocks := buildUserContentBlocks("hi", atts)
	if len(blocks) != 2 {
		t.Fatalf("want 2 blocks (text + 1 valid image), got %d", len(blocks))
	}
	if blocks[1].Source.Data != "GOOD" {
		t.Fatalf("only valid image should survive, got %+v", blocks[1].Source)
	}
}

func TestBuildUserContentBlocks_EmptyPromptStillEmitsImage(t *testing.T) {
	atts := []types.ImageAttachment{
		{MediaType: "image/jpeg", Data: "X"},
	}
	blocks := buildUserContentBlocks("", atts)
	if len(blocks) != 1 {
		t.Fatalf("want 1 image block (no text), got %d", len(blocks))
	}
	if blocks[0].Type != "image" {
		t.Fatalf("want image, got %q", blocks[0].Type)
	}
}

func TestBuildUserContentBlocks_EmptyPromptAllInvalidAttachments(t *testing.T) {
	atts := []types.ImageAttachment{
		{MediaType: "image/png", Data: ""},
	}
	blocks := buildUserContentBlocks("", atts)
	if len(blocks) != 1 {
		t.Fatalf("want 1 fallback placeholder block, got %d", len(blocks))
	}
	if blocks[0].Type != "text" || blocks[0].Text == "" {
		t.Fatalf("want non-empty placeholder text, got type=%q text=%q", blocks[0].Type, blocks[0].Text)
	}
}

// ── PDF / document-block tests (#271 Gap 1) ──────────────────────────────────

// TestBuildUserContentBlocks_PDF_EmitsDocumentBlock verifies that ApiBackend
// produces a native document block for PDF wire attachments, matching the
// behavior of buildCliUserContent in the CLI-backend path. Before the fix,
// a PDF attachment was emitted as an image block (or silently dropped after
// the provider rejected the media type), forcing the model to use the Read
// tool instead of reading inline content.
func TestBuildUserContentBlocks_PDF_EmitsDocumentBlock(t *testing.T) {
	atts := []types.ImageAttachment{
		{MediaType: "application/pdf", Data: "PDFBASE64==", Path: "/tmp/report.pdf"},
	}
	blocks := buildUserContentBlocks("summarize this", atts)
	if len(blocks) != 2 {
		t.Fatalf("want 2 blocks (text + document), got %d", len(blocks))
	}
	if blocks[1].Type != "document" {
		t.Fatalf("PDF attachment: want block type 'document', got %q", blocks[1].Type)
	}
	if blocks[1].Source == nil {
		t.Fatal("document block missing Source")
	}
	if blocks[1].Source.Type != "base64" {
		t.Fatalf("document source type: want 'base64', got %q", blocks[1].Source.Type)
	}
	if blocks[1].Source.MediaType != "application/pdf" {
		t.Fatalf("document media_type: want 'application/pdf', got %q", blocks[1].Source.MediaType)
	}
	if blocks[1].Source.Data != "PDFBASE64==" {
		t.Fatalf("document data mismatch: got %q", blocks[1].Source.Data)
	}
}

// TestBuildUserContentBlocks_PDF_EmptyPromptDocumentOnly verifies that a
// PDF-only message (no text) emits exactly one document block and no text
// block (the "at least one block" invariant holds without a fallback
// placeholder since the document block is present).
func TestBuildUserContentBlocks_PDF_EmptyPromptDocumentOnly(t *testing.T) {
	atts := []types.ImageAttachment{
		{MediaType: "application/pdf", Data: "PDF=="},
	}
	blocks := buildUserContentBlocks("", atts)
	if len(blocks) != 1 {
		t.Fatalf("want 1 document block (no text), got %d", len(blocks))
	}
	if blocks[0].Type != "document" {
		t.Fatalf("want document, got %q", blocks[0].Type)
	}
}

// TestBuildUserContentBlocks_MixedImageAndPDF verifies that a mixed
// prompt (image + PDF) emits the correct block types in order.
func TestBuildUserContentBlocks_MixedImageAndPDF(t *testing.T) {
	atts := []types.ImageAttachment{
		{MediaType: "image/png", Data: "IMG=="},
		{MediaType: "application/pdf", Data: "PDF=="},
	}
	blocks := buildUserContentBlocks("compare", atts)
	if len(blocks) != 3 {
		t.Fatalf("want 3 blocks (text + image + document), got %d", len(blocks))
	}
	if blocks[1].Type != "image" {
		t.Fatalf("second block: want image, got %q", blocks[1].Type)
	}
	if blocks[2].Type != "document" {
		t.Fatalf("third block: want document, got %q", blocks[2].Type)
	}
}

// TestBuildUserContentBlocks_UnknownMediaType_Skipped verifies that attachments
// with unrecognised media types (not image/* and not application/pdf) are
// silently skipped — their marker, if any, remains in the prompt for the
// Read-tool fallback.
func TestBuildUserContentBlocks_UnknownMediaType_Skipped(t *testing.T) {
	atts := []types.ImageAttachment{
		{MediaType: "text/csv", Data: "CSV=="},
		{MediaType: "image/jpeg", Data: "IMG=="},
	}
	blocks := buildUserContentBlocks("data", atts)
	// text + image only; the csv attachment is skipped
	if len(blocks) != 2 {
		t.Fatalf("want 2 blocks (text + image), got %d (csv should be skipped)", len(blocks))
	}
	if blocks[1].Type != "image" {
		t.Fatalf("second block should be image (csv skipped), got %q", blocks[1].Type)
	}
}

