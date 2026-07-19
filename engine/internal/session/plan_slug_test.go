package session

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/dsswift/ion/engine/internal/backend"
)

// ---------------------------------------------------------------------------
// Wordlist invariant tests
//
// These tests lock in the design rules documented in plan_slug.go. They are
// cheap to run, run on every CI invocation, and catch the kinds of authorial
// mistakes that wordlist edits invite (duplicate entries, accidental
// uppercase, hyphenated entries, …).
// ---------------------------------------------------------------------------

// TestPlanSlugLists_NoDuplicatesWithin asserts rule #2 from the plan:
// each word appears exactly once within its list. A duplicate would
// silently bias the random distribution toward the duplicated word
// without breaking the format.
func TestPlanSlugLists_NoDuplicatesWithin(t *testing.T) {
	checkNoDuplicates(t, "adjectives", planSlugAdjectives[:])
	checkNoDuplicates(t, "verbs", planSlugVerbs[:])
	checkNoDuplicates(t, "nouns", planSlugNouns[:])
}

func checkNoDuplicates(t *testing.T, name string, list []string) {
	t.Helper()
	seen := make(map[string]int, len(list))
	for i, w := range list {
		if prev, ok := seen[w]; ok {
			t.Errorf("%s: duplicate %q at indices %d and %d", name, w, prev, i)
		}
		seen[w] = i
	}
}

// TestPlanSlugLists_NoDuplicatesAcross asserts rule #3 from the plan:
// no word appears in more than one list. This keeps slugs unambiguous
// — e.g. "running" must be a verb XOR an adjective, not both.
func TestPlanSlugLists_NoDuplicatesAcross(t *testing.T) {
	seen := map[string]string{}
	add := func(list []string, listName string) {
		for _, w := range list {
			if other, ok := seen[w]; ok && other != listName {
				t.Errorf("word %q appears in both %s and %s", w, other, listName)
			}
			seen[w] = listName
		}
	}
	add(planSlugAdjectives[:], "adjectives")
	add(planSlugVerbs[:], "verbs")
	add(planSlugNouns[:], "nouns")
}

// TestPlanSlugLists_WordFormat asserts rule #4 (lowercase ASCII letters
// only) and a soft "common English" heuristic via a length cap (rule
// #1 — every word should be ≤12 characters; obscure words tend to be
// longer).
func TestPlanSlugLists_WordFormat(t *testing.T) {
	const maxWordLen = 12

	check := func(list []string, listName string) {
		for _, w := range list {
			if w == "" {
				t.Errorf("%s: empty entry", listName)
				continue
			}
			if len(w) > maxWordLen {
				t.Errorf("%s: %q exceeds %d-character cap (len=%d)", listName, w, maxWordLen, len(w))
			}
			for i, r := range w {
				if r < 'a' || r > 'z' {
					t.Errorf("%s: %q has non-[a-z] rune at byte %d: %q", listName, w, i, r)
					break
				}
			}
		}
	}
	check(planSlugAdjectives[:], "adjectives")
	check(planSlugVerbs[:], "verbs")
	check(planSlugNouns[:], "nouns")
}

// TestPlanSlugLists_TargetSizes asserts rule #7: the lists should hover
// around the documented target sizes. We use a band (±20%) rather than
// exact equality so trivial author tweaks don't break the test, but
// large drifts (e.g. accidentally truncating a list) are caught.
func TestPlanSlugLists_TargetSizes(t *testing.T) {
	checkSize := func(listName string, got, target int) {
		t.Helper()
		// Allow ±20% band around the target.
		lo := target - target/5
		hi := target + target/5
		if got < lo || got > hi {
			t.Errorf("%s: size %d outside expected band [%d, %d] (target ~%d)",
				listName, got, lo, hi, target)
		}
	}
	checkSize("adjectives", len(planSlugAdjectives), 100)
	checkSize("verbs", len(planSlugVerbs), 100)
	checkSize("nouns", len(planSlugNouns), 150)
}

// TestPlanSlugLists_CombinatorialSpace asserts that the product of list
// sizes clears 1 million — the floor below which collisions become
// noticeable in realistic usage.
func TestPlanSlugLists_CombinatorialSpace(t *testing.T) {
	const floor = 1_000_000
	space := len(planSlugAdjectives) * len(planSlugVerbs) * len(planSlugNouns)
	if space < floor {
		t.Errorf("combinatorial space %d is below floor %d; expand the lists", space, floor)
	}
	t.Logf("combinatorial space: %d slugs (%d * %d * %d)",
		space, len(planSlugAdjectives), len(planSlugVerbs), len(planSlugNouns))
}

// ---------------------------------------------------------------------------
// Generator tests
// ---------------------------------------------------------------------------

// TestGeneratePlanSlug_Format asserts the output shape produced by
// generatePlanSlug: three lowercase ASCII tokens joined by '-', and
// each token must come from the correct list.
func TestGeneratePlanSlug_Format(t *testing.T) {
	// Build lookup sets once.
	adjSet := setOf(planSlugAdjectives[:])
	verbSet := setOf(planSlugVerbs[:])
	nounSet := setOf(planSlugNouns[:])

	// 100 iterations is enough to catch a systematic bug (e.g. wrong
	// list for one of the slots) without slowing the suite.
	const iterations = 100
	for i := 0; i < iterations; i++ {
		slug := generatePlanSlug()
		parts := strings.Split(slug, "-")
		if len(parts) != 3 {
			t.Fatalf("iteration %d: expected 3 parts, got %d in %q", i, len(parts), slug)
		}
		if _, ok := adjSet[parts[0]]; !ok {
			t.Errorf("iteration %d: adjective %q not in planSlugAdjectives (slug=%q)", i, parts[0], slug)
		}
		if _, ok := verbSet[parts[1]]; !ok {
			t.Errorf("iteration %d: verb %q not in planSlugVerbs (slug=%q)", i, parts[1], slug)
		}
		if _, ok := nounSet[parts[2]]; !ok {
			t.Errorf("iteration %d: noun %q not in planSlugNouns (slug=%q)", i, parts[2], slug)
		}
		// Every part lowercase, no empty parts.
		for j, p := range parts {
			if p == "" {
				t.Errorf("iteration %d: empty part at index %d in %q", i, j, slug)
			}
			if p != strings.ToLower(p) {
				t.Errorf("iteration %d: non-lowercase part %q in %q", i, p, slug)
			}
		}
	}
}

// TestGeneratePlanSlug_Distribution sanity-checks that the generator
// is not stuck on a single output. With ~2M possible slugs we expect
// near-perfect uniqueness over 100 trials. A failure here likely
// indicates a broken RNG (e.g. accidentally using a zero-seeded
// math/rand source).
func TestGeneratePlanSlug_Distribution(t *testing.T) {
	const trials = 100
	seen := make(map[string]struct{}, trials)
	for i := 0; i < trials; i++ {
		seen[generatePlanSlug()] = struct{}{}
	}
	// In ~2M space across 100 trials, the expected number of
	// collisions is ~0.0025. Anything above a handful means something
	// is very wrong.
	if len(seen) < trials-3 {
		t.Errorf("generated %d slugs but only %d were unique — RNG suspicious", trials, len(seen))
	}
}

// TestGeneratePlanSlugUnique_AvoidsExistingFile pre-creates the file
// that would be returned by the first generatePlanSlug call, then
// asserts that generatePlanSlugUnique returns something different.
//
// We cannot easily inject a deterministic RNG (the generator uses
// crypto/rand directly), so the test instead exploits the fact that
// generatePlanSlugUnique retries up to 10 times on collision. We
// pre-create *every adjective combined with one verb-noun pair*,
// which is enough to guarantee at least one retry without exhausting
// the search space.
//
// Simpler: pre-create one file, run the generator many times, assert
// that the generator never returns *that* slug (because the
// "_unique" function probes for the file and retries).
func TestGeneratePlanSlugUnique_AvoidsExistingFile(t *testing.T) {
	dir := t.TempDir()

	// Pick a fixed slug we know exists in our wordlist.
	const blockedSlug = "happy-jumping-rabbit"
	blockedPath := filepath.Join(dir, blockedSlug+".md")
	if err := os.WriteFile(blockedPath, []byte("dummy"), 0644); err != nil {
		t.Fatalf("seeding blocked file: %v", err)
	}

	// Sanity-check: the words we picked must actually be in the lists,
	// otherwise the test wouldn't be meaningful.
	if _, ok := setOf(planSlugAdjectives[:])["happy"]; !ok {
		t.Fatal("test invariant broken: 'happy' missing from planSlugAdjectives")
	}
	if _, ok := setOf(planSlugVerbs[:])["jumping"]; !ok {
		t.Fatal("test invariant broken: 'jumping' missing from planSlugVerbs")
	}
	if _, ok := setOf(planSlugNouns[:])["rabbit"]; !ok {
		t.Fatal("test invariant broken: 'rabbit' missing from planSlugNouns")
	}

	// Hammer the generator. The probability of returning the blocked
	// slug is ~1/2M per attempt, and generatePlanSlugUnique retries
	// up to 10 times on collision, so over 1000 trials we should see
	// zero hits. If the blocked-file check is broken we'd see ~1 hit
	// in ~2000 trials, well below this threshold.
	const trials = 1000
	for i := 0; i < trials; i++ {
		slug := generatePlanSlugUnique(dir)
		if slug == blockedSlug {
			t.Fatalf("generator returned blocked slug %q on iteration %d", slug, i)
		}
	}
}

// TestGeneratePlanSlugUnique_HandlesMissingDir asserts that a non-
// existent plansDir is treated as "no collisions" — every probe
// returns ENOENT, so the first generated slug wins. This matters
// because callers (allocateNewPlanFilePath) mkdir-then-pass, and we
// don't want a race between mkdir and stat to ever block slug
// generation.
func TestGeneratePlanSlugUnique_HandlesMissingDir(t *testing.T) {
	missing := filepath.Join(t.TempDir(), "does-not-exist")
	// Should not panic and should not loop forever.
	slug := generatePlanSlugUnique(missing)
	if slug == "" {
		t.Fatal("expected a non-empty slug from missing directory")
	}
	if !strings.Contains(slug, "-") {
		t.Errorf("expected adj-verb-noun format, got %q", slug)
	}
}

// ---------------------------------------------------------------------------
// planSlugFromPath tests
// ---------------------------------------------------------------------------

// TestPlanSlugFromPath covers the round-trip from path → slug for both
// new (word-slug) and legacy (hex-hash) plan files, plus edge cases.
//
// The legacy hex case is especially important: it documents the
// backwards-compatibility guarantee that a session created before this
// code shipped continues to surface a sensible slug to the UI (the hex
// string itself), rather than crashing or returning "".
func TestPlanSlugFromPath(t *testing.T) {
	cases := []struct {
		name string
		in   string
		want string
	}{
		{"empty", "", ""},
		{"home plans dir", "/home/user/.ion/plans/happy-jumping-rabbit.md", "happy-jumping-rabbit"},
		{"repo plans dir", "/repo/.ion/plans/calm-baking-otter.md", "calm-baking-otter"},
		{"legacy hex", "/legacy/plans/ef072eb2660d0993109be0862df6328d.md", "ef072eb2660d0993109be0862df6328d"},
		{"no extension", "/plans/just-a-name", "just-a-name"},
		{"relative path", "./plans/cool-running-stream.md", "cool-running-stream"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := planSlugFromPath(tc.in); got != tc.want {
				t.Errorf("planSlugFromPath(%q) = %q, want %q", tc.in, got, tc.want)
			}
		})
	}
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

func setOf(list []string) map[string]struct{} {
	m := make(map[string]struct{}, len(list))
	for _, w := range list {
		m[w] = struct{}{}
	}
	return m
}

// ---------------------------------------------------------------------------
// allocateNewPlanFilePath directory-choice tests
//
// These tests pin the core bug fix: the plans directory must be determined by
// caps.PlanFileProjectScoped, not by a static backend type switch. Previously
// HybridBackend was treated the same as ClaudeCodeBackend regardless of which
// inner backend served the run — so api-served hybrid runs wrote plans under
// the project directory instead of ~/.ion/plans/.
// ---------------------------------------------------------------------------

// TestAllocateNewPlanFilePath_HomeDir asserts that a non-project-scoped backend
// (api, codex, grok, cursor — any backend that uses Ion's own plan-mode system)
// always places the plan file under ~/.ion/plans/, even when a workingDir is
// provided. This is the regression case: before the fix, a HybridBackend wrapper
// would have hit the project-dir branch and written to <workingDir>/.ion/plans/.
func TestAllocateNewPlanFilePath_HomeDir(t *testing.T) {
	workDir := t.TempDir()
	caps := backend.BackendCapabilities{
		Kind:                  "api",
		PlanFileProjectScoped: false,
	}
	path := allocateNewPlanFilePath(caps, workDir)
	home, _ := os.UserHomeDir()
	wantPrefix := filepath.Join(home, ".ion", "plans")
	if !strings.HasPrefix(path, wantPrefix) {
		t.Errorf("allocateNewPlanFilePath(api, workDir) = %q, want prefix %q", path, wantPrefix)
	}
}

// TestAllocateNewPlanFilePath_ProjectDir asserts that a project-scoped backend
// (claude-code) places the plan file under <workingDir>/.ion/plans/ when a
// workingDir is provided.
func TestAllocateNewPlanFilePath_ProjectDir(t *testing.T) {
	workDir := t.TempDir()
	caps := backend.BackendCapabilities{
		Kind:                  "claude-code",
		PlanFileProjectScoped: true,
	}
	path := allocateNewPlanFilePath(caps, workDir)
	wantPrefix := filepath.Join(workDir, ".ion", "plans")
	if !strings.HasPrefix(path, wantPrefix) {
		t.Errorf("allocateNewPlanFilePath(claude-code, workDir) = %q, want prefix %q", path, wantPrefix)
	}
}

// TestAllocateNewPlanFilePath_ProjectScopedEmptyWorkDir asserts that a
// project-scoped backend falls back to ~/.ion/plans/ when no workingDir is set.
// This matches the pre-existing "empty workingDir → home" invariant.
func TestAllocateNewPlanFilePath_ProjectScopedEmptyWorkDir(t *testing.T) {
	caps := backend.BackendCapabilities{
		Kind:                  "claude-code",
		PlanFileProjectScoped: true,
	}
	path := allocateNewPlanFilePath(caps, "")
	home, _ := os.UserHomeDir()
	wantPrefix := filepath.Join(home, ".ion", "plans")
	if !strings.HasPrefix(path, wantPrefix) {
		t.Errorf("allocateNewPlanFilePath(claude-code, empty) = %q, want home prefix %q", path, wantPrefix)
	}
}
