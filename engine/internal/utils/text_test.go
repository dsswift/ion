package utils

import (
	"strings"
	"testing"
	"unicode/utf8"
)

func TestFirstLineUTF8_BoundsWithoutSplittingRune(t *testing.T) {
	got := FirstLineUTF8(strings.Repeat("🙂", 100)+"\nignored", 256)
	if len(got) > 256 || !utf8.ValidString(got) {
		t.Fatalf("invalid bounded output: %q", got)
	}
	if strings.Contains(got, "ignored") {
		t.Fatal("returned content after first line")
	}
}
