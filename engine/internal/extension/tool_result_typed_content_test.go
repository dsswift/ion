package extension

import "testing"

func TestParseToolResultWithTypedContent(t *testing.T) {
	result, ok := parseToolResultWithImages([]byte(`{
		"content":"attachment.bin, 4 bytes",
		"isError":true,
		"contentItems":[
			{"type":"text","text":"attachment.bin, 4 bytes"},
			{"type":"resource","resource":{"uri":"attachment://example","mimeType":"application/octet-stream","blob":"AAECAw=="}}
		]
	}`), "test-ext")
	if !ok {
		t.Fatal("parseToolResultWithImages returned ok=false for typed content")
	}
	if result.Content != "attachment.bin, 4 bytes" || !result.IsError {
		t.Fatalf("result = %#v", result)
	}
	if len(result.ContentItems) != 2 || result.ContentItems[1].Resource == nil || result.ContentItems[1].Resource.Blob != "AAECAw==" {
		t.Fatalf("typed content lost: %#v", result.ContentItems)
	}
}
