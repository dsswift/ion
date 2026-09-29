package providers

import (
	"os"
	"os/exec"
	"testing"
)

// Local token counts must work with no network and no download cache. The
// check runs in a child process so no encoder loaded earlier in this one can
// satisfy it.
func TestLocalTokenCount_NeedsNoNetwork(t *testing.T) {
	if os.Getenv("ION_TOKENIZER_OFFLINE_CHILD") == "1" {
		for _, model := range []string{"gpt-4o", "gpt-4"} {
			n, tier, err := LocalTokenCount(model, "count these tokens offline")
			if err != nil || tier != TierLocal || n == 0 {
				t.Fatalf("%s: n=%d tier=%s err=%v", model, n, tier, err)
			}
		}
		return
	}
	cmd := exec.Command(os.Args[0], "-test.run=^TestLocalTokenCount_NeedsNoNetwork$", "-test.count=1")
	cmd.Env = append(os.Environ(),
		"ION_TOKENIZER_OFFLINE_CHILD=1",
		"TIKTOKEN_CACHE_DIR="+t.TempDir(),
		"HTTP_PROXY=http://127.0.0.1:1",
		"HTTPS_PROXY=http://127.0.0.1:1",
		"NO_PROXY=",
	)
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("offline token count failed: %v\n%s", err, out)
	}
}
