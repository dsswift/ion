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
		{MediaType: "image/jpeg", Data: "AAA=", Path: "/tmp/x.jpg", ContentHash: "input-hash"},
	}
	blocks := buildUserContentBlocks("what is this", atts)
	if len(blocks) != 2 {
		t.Fatalf("want 2 blocks, got %d", len(blocks))
	}
	if blocks[0].Type != "image" {
		t.Fatalf("first block: want image, got %q", blocks[0].Type)
	}
	if blocks[0].Source == nil {
		t.Fatalf("image block missing Source")
	}
	if blocks[0].Source.Type != "base64" {
		t.Fatalf("image source type: want base64, got %q", blocks[0].Source.Type)
	}
	if blocks[0].Source.MediaType != "image/jpeg" {
		t.Fatalf("image media_type: want image/jpeg, got %q", blocks[0].Source.MediaType)
	}
	if blocks[0].Source.Data != "AAA=" {
		t.Fatalf("image data: want AAA=, got %q", blocks[0].Source.Data)
	}
	if blocks[0].Source.ContentHash != "input-hash" {
		t.Fatalf("image content hash: want input-hash, got %q", blocks[0].Source.ContentHash)
	}
	if blocks[1].Type != "text" || blocks[1].Text != "what is this" {
		t.Fatalf("second block: want text/'what is this', got type=%q text=%q", blocks[1].Type, blocks[1].Text)
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
	if blocks[0].Type != "image" || blocks[0].Source == nil || blocks[0].Source.MediaType != "image/png" || blocks[0].Source.Data != "PNG1" {
		t.Fatalf("first image: got %+v", blocks[0])
	}
	if blocks[1].Type != "image" || blocks[1].Source == nil || blocks[1].Source.MediaType != "image/jpeg" || blocks[1].Source.Data != "JPG2" {
		t.Fatalf("second image: got %+v", blocks[1])
	}
	if blocks[2].Type != "text" || blocks[2].Text != "two" {
		t.Fatalf("text must follow images, got type=%q text=%q", blocks[2].Type, blocks[2].Text)
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
		t.Fatalf("want 2 blocks (image + text), got %d", len(blocks))
	}
	if blocks[0].Source.Data != "GOOD" {
		t.Fatalf("only valid image should survive, got %+v", blocks[0].Source)
	}
	if blocks[1].Type != "text" || blocks[1].Text != "hi" {
		t.Fatalf("text must follow valid media, got type=%q text=%q", blocks[1].Type, blocks[1].Text)
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

func TestBuildUserContentBlocks_DerivesMissingImageHash(t *testing.T) {
	blocks := buildUserContentBlocks("inspect", []types.ImageAttachment{{
		MediaType: "image/png",
		Data:      "AAECAwQ=",
	}})
	if len(blocks) != 2 || blocks[0].Source == nil {
		t.Fatalf("blocks = %#v, want image then text", blocks)
	}
	if blocks[0].Source.ContentHash == "" {
		t.Fatal("image block missing derived content hash")
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
		t.Fatalf("want 2 blocks (document + text), got %d", len(blocks))
	}
	if blocks[0].Type != "document" {
		t.Fatalf("PDF attachment: want first block type 'document', got %q", blocks[0].Type)
	}
	if blocks[0].Source == nil {
		t.Fatal("document block missing Source")
	}
	if blocks[0].Source.Type != "base64" {
		t.Fatalf("document source type: want 'base64', got %q", blocks[0].Source.Type)
	}
	if blocks[0].Source.MediaType != "application/pdf" {
		t.Fatalf("document media_type: want 'application/pdf', got %q", blocks[0].Source.MediaType)
	}
	if blocks[0].Source.Data != "PDFBASE64==" {
		t.Fatalf("document data mismatch: got %q", blocks[0].Source.Data)
	}
	if blocks[1].Type != "text" || blocks[1].Text != "summarize this" {
		t.Fatalf("text must follow document, got type=%q text=%q", blocks[1].Type, blocks[1].Text)
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
		t.Fatalf("want 3 blocks (image + document + text), got %d", len(blocks))
	}
	if blocks[0].Type != "image" {
		t.Fatalf("first block: want image, got %q", blocks[0].Type)
	}
	if blocks[1].Type != "document" {
		t.Fatalf("second block: want document, got %q", blocks[1].Type)
	}
	if blocks[2].Type != "text" || blocks[2].Text != "compare" {
		t.Fatalf("third block: want text/compare, got type=%q text=%q", blocks[2].Type, blocks[2].Text)
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
	// The unknown attachment is skipped; valid media still precedes text.
	if len(blocks) != 2 {
		t.Fatalf("want 2 blocks (image + text), got %d (csv should be skipped)", len(blocks))
	}
	if blocks[0].Type != "image" {
		t.Fatalf("first block should be image (csv skipped), got %q", blocks[0].Type)
	}
	if blocks[1].Type != "text" || blocks[1].Text != "data" {
		t.Fatalf("text must follow image, got type=%q text=%q", blocks[1].Type, blocks[1].Text)
	}
}
