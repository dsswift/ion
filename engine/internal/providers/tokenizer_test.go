package providers

import "testing"

func TestLocalTokenCount_KnownEncoding(t *testing.T) {
	count, tier, err := LocalTokenCount("gpt-4o", "hello world")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if tier != TierLocal {
		t.Fatalf("expected TierLocal, got %q", tier)
	}
	if count <= 0 {
		t.Fatalf("expected count > 0, got %d", count)
	}
}

func TestLocalTokenCount_ClaudeEncoding(t *testing.T) {
	count, tier, err := LocalTokenCount("claude-3-5-sonnet-20241022", "hello world")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if tier != TierLocal {
		t.Fatalf("expected TierLocal, got %q", tier)
	}
	if count <= 0 {
		t.Fatalf("expected count > 0, got %d", count)
	}
}

func TestLocalTokenCount_UnknownModel(t *testing.T) {
	// A model string that matches no prefix and contains neither
	// "anthropic." nor "claude".
	_, tier, err := LocalTokenCount("zzz-unknown-model-9000", "hello world")
	if err == nil {
		t.Fatalf("expected error for unknown model")
	}
	if tier != TierApproximate {
		t.Fatalf("expected TierApproximate, got %q", tier)
	}
}

func TestEncoderCacheReuse(t *testing.T) {
	// First call warms the cache; second call must hit the cache path
	// without error and produce the same count.
	c1, _, err := LocalTokenCount("gpt-4o", "the quick brown fox")
	if err != nil {
		t.Fatalf("first call error: %v", err)
	}
	c2, _, err := LocalTokenCount("gpt-4o", "the quick brown fox")
	if err != nil {
		t.Fatalf("second call error: %v", err)
	}
	if c1 != c2 {
		t.Fatalf("cache hit produced different count: %d != %d", c1, c2)
	}
}

func TestEstimateTokensChar4(t *testing.T) {
	cases := []struct {
		in   string
		want int
	}{
		{"hello", 1},       // 5 chars / 4 = 1
		{"hello world", 2}, // 11 chars / 4 = 2
		{"", 0},            // empty → 0
	}
	for _, c := range cases {
		if got := EstimateTokensChar4(c.in); got != c.want {
			t.Errorf("EstimateTokensChar4(%q) = %d, want %d", c.in, got, c.want)
		}
	}
}

func TestContentHashKey(t *testing.T) {
	a := ContentHashKey("hello", "gpt-4o/system")
	b := ContentHashKey("hello", "gpt-4o/system")
	if a != b {
		t.Fatalf("identical inputs produced different keys: %s != %s", a, b)
	}
	c := ContentHashKey("hello", "gpt-4o/file")
	if a == c {
		t.Fatalf("different scopeKey produced identical hash: %s", a)
	}
}
