package extcontext

import (
	"strings"
	"testing"
	"unicode/utf8"
)

func TestDispatchTaskLabel_BoundsFirstLineWithoutCorruptingUTF8(t *testing.T) {
	label := dispatchTaskLabel(strings.Repeat("🙂", 100) + "\nsecond line")
	if len(label) > dispatchTaskLabelMaxBytes {
		t.Fatalf("label bytes=%d", len(label))
	}
	if !utf8.ValidString(label) {
		t.Fatal("label is invalid UTF-8")
	}
	if strings.Contains(label, "second line") {
		t.Fatal("label includes second line")
	}
}
