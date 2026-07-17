// Package session — plan slug generator.
//
// Plan files used to be named with a 32-char hex hash, which is unique but
// awful for users (impossible to remember, impossible to read in an
// attachment list, indistinguishable from one plan to the next). We name
// them with a three-word slug instead: "adjective-verb-noun", e.g.
// "happy-jumping-rabbit.md".
//
// Design rules (see the plan that introduced this file for the full list):
//
//   - Common English only. Every word must be one a typical English speaker
//     recognises, can pronounce on sight, and can spell from memory.
//   - No duplicates within a list.
//   - No duplicates across lists.
//   - Lowercase ASCII letters only.
//   - Family-friendly and professional. The resulting filename should be
//     appropriate to share in a PR, a screenshot, or a support chat.
//
// Combinatorial space: ~108 * ~111 * ~166 ≈ 2 million unique slugs.
// Plenty for any single user's lifetime of plans, and small enough that
// a human can review the lists end-to-end. Exact counts drift as the
// lists are tuned; the test suite (TestPlanSlugLists_TargetSizes,
// TestPlanSlugLists_CombinatorialSpace) enforces a band around these
// numbers and a hard floor of 1M.
//
// Randomness: we use crypto/rand (already imported elsewhere in this
// package) instead of math/rand. There is no security argument here —
// the slug is not a secret — but it avoids needing to seed and makes
// generation deterministic-free across goroutines.
//
// Collision handling: generatePlanSlugUnique probes the target directory
// with os.Stat up to 10 times. With ~2M slugs and (in practice) a
// handful of plans per directory, the chance of needing even one retry
// is negligible. If all 10 attempts collide we accept the last candidate
// anyway — the existing file would be reused, matching the prior
// (hash-based) generator's implicit behaviour of "if you somehow
// collide, oh well".
package session

import (
	"crypto/rand"
	"encoding/binary"
	"fmt"
	"os"
	"path/filepath"

	"github.com/dsswift/ion/engine/internal/backend"
	"github.com/dsswift/ion/engine/internal/types"
)

// planSlugAdjectives — ~100 entries.
//
// Authored fresh for Ion. Picked for: easy to say, easy to spell,
// neutral-to-positive connotation, no overlap with the verb or noun
// list. The handful that also exist in Claude Code's list (e.g.
// "happy", "calm") are common-English unavoidables, not lifts.
var planSlugAdjectives = [...]string{
	"amber", "ample", "balmy", "blue", "bold", "brave", "breezy", "bright",
	"brisk", "calm", "cheery", "chipper", "clean", "clear", "clever",
	"cool", "cosy", "crisp", "daring", "dewy", "dusky", "early", "easy",
	"eager", "fancy", "fast", "fine", "firm", "fond", "frosty", "gentle",
	"giddy", "gilded", "glad", "golden", "good", "grand", "grassy",
	"green", "happy", "hardy", "hazel", "honest", "humble", "jolly",
	"jovial", "joyful", "keen", "kind", "lavish", "leafy", "light",
	"lively", "lofty", "lucky", "mellow", "merry", "mild", "minty",
	"misty", "modest", "neat", "nimble", "noble", "olive", "peachy",
	"perky", "plain", "plucky", "plush", "polite", "proud", "quick",
	"quiet", "rapid", "ready", "rosy", "ruby", "rustic", "safe", "sage",
	"sandy", "shady", "sharp", "shiny", "silky", "silver", "simple",
	"smooth", "snug", "soft", "solid", "spry", "steady", "still",
	"sturdy", "sunny", "swift", "tender", "tidy", "tiny", "trusty",
	"vivid", "warm", "wise", "witty", "young", "zesty",
}

// planSlugVerbs — ~100 entries, all in -ing form.
//
// Picked for: present-continuous reads naturally between adjective and
// noun ("happy-jumping-rabbit"), action-oriented, common.
var planSlugVerbs = [...]string{
	"baking", "beaming", "bouncing", "braiding", "brewing", "browsing",
	"building", "chasing", "cheering", "chirping", "circling", "clapping",
	"climbing", "cooking", "crafting", "cycling", "dancing", "darting",
	"dashing", "diving", "drawing", "dreaming", "drifting", "drumming",
	"exploring", "finding", "fishing", "fixing", "flipping", "floating",
	"flying", "folding", "frolicking", "gathering", "giggling", "gliding",
	"glowing", "greeting", "grinning", "growing", "guiding", "helping",
	"hiking", "hopping", "humming", "trekking", "jogging", "joking",
	"jumping", "juggling", "knitting", "laughing", "leaping", "marching",
	"mending", "mixing", "munching", "napping", "noodling", "painting",
	"pacing", "pedalling", "perching", "planting", "playing", "pouring",
	"prancing", "puzzling", "reading", "rhyming", "riding", "roaming",
	"rolling", "running", "sailing", "scribbling", "searching", "seeking",
	"sharing", "shining", "singing", "sketching", "skating", "skipping",
	"sledding", "sleeping", "smiling", "soaring", "splashing", "sprinting",
	"stargazing", "stomping", "strolling", "studying", "surfing",
	"swimming", "swinging", "thinking", "tiptoeing", "trotting",
	"twirling", "waddling", "walking", "wandering", "waving", "weaving",
	"whistling", "wiggling", "winking", "wishing", "yawning",
}

// planSlugNouns — ~150 entries.
//
// Buckets (no formal grouping in code, but used while authoring to keep
// variety): nature & weather, friendly creatures, food & drink, everyday
// objects, and a handful of abstract-but-common concepts.
//
// Excluded on purpose: anything obscure, anything that could be
// awkward when combined with a random adjective and verb, surnames of
// any kind, anything political or culturally loaded.
var planSlugNouns = [...]string{
	// Nature & weather
	"acorn", "bay", "beach", "bloom", "branch", "breeze", "brook",
	"canyon", "cave", "cloud", "cove", "creek", "crest", "dawn", "delta",
	"desert", "dew", "dune", "dusk", "field", "fjord", "flame", "forest",
	"frost", "garden", "glade", "glen", "grove", "harbor", "hill",
	"horizon", "island", "lagoon", "lake", "leaf", "marsh", "meadow",
	"mist", "moon", "mountain", "oasis", "ocean", "orchard", "petal",
	"pine", "pond", "rainbow", "reef", "ridge", "river", "shore", "sky",
	"snow", "spring", "star", "stream", "summit", "sunbeam", "sunrise",
	"sunset", "thicket", "tide", "trail", "tree", "valley", "wave",
	"willow", "wind", "wood",
	// Friendly creatures
	"badger", "bear", "beaver", "bee", "bird", "bunny", "cat",
	"chipmunk", "deer", "dolphin", "dove", "duck", "eagle", "falcon",
	"finch", "fox", "frog", "goose", "hamster", "hare", "hedgehog",
	"heron", "horse", "kitten", "ladybug", "lamb", "lark", "moth",
	"otter", "owl", "panda", "parrot", "penguin", "pony", "puppy",
	"rabbit", "raccoon", "raven", "robin", "seal", "sparrow", "squirrel",
	"swan", "turtle", "whale", "wolf", "wren",
	// Food & drink (the friendly subset)
	"apple", "berry", "biscuit", "bread", "cherry", "cocoa", "cookie",
	"cupcake", "honey", "lemon", "mango", "muffin", "peach", "pear",
	"plum", "scone", "waffle",
	// Everyday objects & cosy things
	"anchor", "balloon", "beacon", "blanket", "boat", "book", "candle",
	"compass", "crayon", "cup", "feather", "kettle", "kite", "lantern",
	"map", "mitten", "nest", "notebook", "pebble", "pillow", "quilt",
	"ribbon", "sailboat", "shell", "teacup", "umbrella",
	// Common abstract concepts that pair naturally
	"dream", "echo", "haven", "melody", "puzzle", "story", "whisper",
}

// generatePlanSlug returns a random "adjective-verb-noun" slug, e.g.
// "happy-jumping-rabbit". Each call picks each word independently
// using crypto/rand, so two consecutive calls are extremely unlikely
// to collide (1 in ~2M).
//
// This is the lower-level primitive. Almost all callers should use
// generatePlanSlugUnique instead, which retries on filesystem
// collisions inside a target directory.
func generatePlanSlug() string {
	adj := planSlugAdjectives[randIndex(len(planSlugAdjectives))]
	verb := planSlugVerbs[randIndex(len(planSlugVerbs))]
	noun := planSlugNouns[randIndex(len(planSlugNouns))]
	return fmt.Sprintf("%s-%s-%s", adj, verb, noun)
}

// generatePlanSlugUnique returns a plan slug that is not currently
// taken in plansDir. It probes the filesystem (os.Stat on
// "<plansDir>/<slug>.md") up to 10 times. If every attempt collides
// — which would require either an astronomically unlucky run or a
// directory packed with hundreds of thousands of plans — it accepts
// the last candidate anyway. In that pathological case the caller
// would reuse the existing file, which matches the prior (hash-based)
// generator's implicit behaviour.
//
// plansDir does not need to exist; os.Stat on a path inside a missing
// directory returns an error, which we treat as "no collision".
func generatePlanSlugUnique(plansDir string) string {
	const maxRetries = 10
	var slug string
	for i := 0; i < maxRetries; i++ {
		slug = generatePlanSlug()
		candidate := filepath.Join(plansDir, slug+".md")
		if _, err := os.Stat(candidate); os.IsNotExist(err) {
			return slug
		}
		// Any other error (permission denied, etc.) or a stat success
		// (file exists) → try again. Stat errors other than ENOENT are
		// rare and self-resolve on retry; we don't surface them
		// because the caller has no useful recovery.
	}
	return slug
}

// allocateNewPlanFilePath picks the right plans directory for the given
// backend + working directory, ensures the directory exists on disk, and
// returns a fresh non-colliding plan file path inside it.
//
// Backend-dependent directory choice:
//
//   - CLI and Hybrid backends place the plan file inside the project
//     working directory (".ion/plans/" beneath cwd). This is because the
//     native Claude CLI's plan mode restricts writes to paths within or
//     under the project root.
//   - API backend (and the fallback when no working directory is set)
//     places the plan file under "~/.ion/plans/" since it controls its
//     own tool execution and can write anywhere.
//   - Hybrid is treated like CLI here: at the point this is called the
//     model is not yet finalised, so we cannot dispatch by inner backend.
//     The common case for plan mode under hybrid is Claude (which
//     requires the project-relative path), so the CLI default is right.
//     See specs/feat-hybrid-backend-routing.md §"Edge Cases".
//
// This helper exists to keep the plan-file allocation logic in one
// place. Previously it was duplicated between RequestPlanModeEnter
// (plan_mode.go) and SendPrompt (prompt_dispatch.go); they cannot drift
// now that both call this function.
//
// mkdirAll failures are logged via the returned error but do NOT block
// path generation — the caller can still record the chosen path on the
// session; subsequent file writes will surface the directory error in
// their own context with better surrounding state.
func allocateNewPlanFilePath(b backend.RunBackend, workingDir string) string {
	var plansDir string
	_, isCli := b.(*backend.ClaudeCodeBackend)
	_, isHybrid := b.(*backend.HybridBackend)
	if (isCli || isHybrid) && workingDir != "" {
		plansDir = filepath.Join(workingDir, ".ion", "plans")
	} else {
		home, _ := os.UserHomeDir()
		plansDir = filepath.Join(home, ".ion", "plans")
	}
	// MkdirAll is idempotent; ignore the error here. If it failed
	// (permission, read-only fs, …) the subsequent file write will
	// surface a clear error and the user will see it then.
	_ = os.MkdirAll(plansDir, 0755)
	slug := generatePlanSlugUnique(plansDir)
	return filepath.Join(plansDir, slug+".md")
}

// planSlugFromPath is a session-package wrapper around
// types.PlanSlugFromPath, kept for callers in this package that prefer
// not to import the types package solely for the helper. The canonical
// definition lives in types/normalized_event.go alongside the
// PlanModeChangedEvent struct, so emitters and decoders share one
// source of truth.
func planSlugFromPath(path string) string {
	return types.PlanSlugFromPath(path)
}

// randIndex returns a uniform random integer in [0, n) using
// crypto/rand. Panics if n <= 0 (programmer error: empty word list).
//
// Implementation: read 4 random bytes, interpret as uint32, modulo n.
// The modulo bias for n on the order of a few hundred (our wordlist
// sizes) over a 2^32 range is ~n/2^32 ≈ 1e-7, well below anything
// observable in slug-name distribution.
func randIndex(n int) int {
	if n <= 0 {
		panic("randIndex: empty range")
	}
	var b [4]byte
	if _, err := rand.Read(b[:]); err != nil {
		// crypto/rand.Read on Unix and modern Windows essentially
		// never fails (it would mean the OS RNG is broken). If it
		// does, panicking is the right call — we have no fallback
		// that preserves the "secure-ish, unbiased" contract, and
		// silently degrading to a predictable RNG would be worse
		// than crashing.
		panic(fmt.Sprintf("randIndex: crypto/rand.Read failed: %v", err))
	}
	return int(binary.BigEndian.Uint32(b[:]) % uint32(n))
}
