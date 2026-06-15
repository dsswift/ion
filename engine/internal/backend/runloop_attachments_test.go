package backend

import (
	"testing"

	"github.com/dsswift/ion/engine/internal/types"
)

// buildUserContentBlocks is the seam the runloop uses to convert a text
// prompt + pre-encoded image attachments into structured content blocks.
// The provider formatters (anthropic, openai, google, bedrock) already
// handle image blocks; these tests pin the conversion contract.

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
		{MediaType: "", Data: "AAA="},            // missing media type
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
