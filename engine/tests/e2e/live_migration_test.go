//go:build e2e

package e2e

import (
	"crypto/rand"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/dsswift/ion/engine/internal/backend"
	"github.com/dsswift/ion/engine/internal/conversation"
	"github.com/dsswift/ion/engine/internal/types"
)

// defaultConvDir returns the default Ion conversation directory (~/.ion/conversations).
func defaultConvDir(t *testing.T) string {
	t.Helper()
	home, err := os.UserHomeDir()
	if err != nil {
		t.Fatalf("UserHomeDir: %v", err)
	}
	return filepath.Join(home, ".ion", "conversations")
}

// claudeProjectDir returns the Claude CLI session directory for a given project path.
// Claude CLI resolves symlinks and encodes by replacing '/', '.', and '_' with '-'.
func claudeProjectDir(t *testing.T, projectPath string) string {
	t.Helper()
	home, err := os.UserHomeDir()
	if err != nil {
		t.Fatalf("UserHomeDir: %v", err)
	}
	realPath, err := filepath.EvalSymlinks(projectPath)
	if err != nil {
		realPath = projectPath
	}
	replacer := strings.NewReplacer("/", "-", ".", "-", "_", "-")
	encoded := replacer.Replace(realPath)
	return filepath.Join(home, ".claude", "projects", encoded)
}

// findSessionFile finds a .jsonl session file in a directory.
func findSessionFile(t *testing.T, dir string) (sessionID, filePath string) {
	t.Helper()
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatalf("ReadDir(%s): %v", dir, err)
	}
	for _, f := range entries {
		if strings.HasSuffix(f.Name(), ".jsonl") {
			id := strings.TrimSuffix(f.Name(), ".jsonl")
			return id, filepath.Join(dir, f.Name())
		}
	}
	t.Fatalf("No .jsonl session file found in %s", dir)
	return "", ""
}

// generateTestUUID creates a proper UUID v4 for Claude CLI session IDs.
func generateTestUUID() string {
	b := make([]byte, 16)
	_, _ = rand.Read(b)
	b[6] = (b[6] & 0x0f) | 0x40
	b[8] = (b[8] & 0x3f) | 0x80
	return fmt.Sprintf("%08x-%04x-%04x-%04x-%012x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:])
}

// collectText extracts all text chunk content from normalized events.
func collectText(events []types.NormalizedEvent) string {
	var b strings.Builder
	for _, ev := range events {
		if tc, ok := ev.Data.(*types.TextChunkEvent); ok {
			b.WriteString(tc.Text)
		}
	}
	return b.String()
}

// ─── Test 1: API → convert → resume on CLI → verify continuation ────────────
//
// 1. Create an API conversation with a unique code word
// 2. Convert to Claude Code JSONL in the correct project directory
// 3. Run Claude CLI with --resume on the converted session
// 4. Ask the CLI what the code word was — proving it can read and continue
func TestLiveMigrationAPIToCLIContinuation(t *testing.T) {
	model := setupAnthropicProvider(t)
	tmpDir := t.TempDir()
	convDir := defaultConvDir(t)

	apiSessionID := "e2e-mig-a2c-" + conversation.GenEntryID()

	// ── Step 1: Create API conversation with a code word ──
	t.Log("Step 1: Running API conversation with code word...")
	apiBackend := backend.NewApiBackend()
	ec := newEventCollector(apiBackend)

	apiBackend.StartRun("mig-a2c-1", types.RunOptions{
		Prompt:       "Remember this code word: FALCON73. Just confirm you have it, nothing else.",
		Model:        model,
		MaxTurns:     1,
		MaxBudgetUsd: 0.10,
		AllowedTools: []string{},
		SessionID:    apiSessionID,
		ProjectPath:  tmpDir,
	})

	ec.waitForExit(t, 30*time.Second)
	t.Cleanup(func() {
		os.Remove(filepath.Join(convDir, apiSessionID+".jsonl"))
	})

	apiText := collectText(ec.getNormalized())
	t.Logf("API response: %s", strings.TrimSpace(apiText))

	// ── Step 2: Convert to Claude Code format in the correct project dir ──
	t.Log("Step 2: Converting API → Claude Code...")
	apiConv, err := conversation.Load(apiSessionID, convDir)
	if err != nil {
		t.Fatalf("Load API conversation: %v", err)
	}
	sourceMsgs := conversation.ExtractValidationMsgs(apiConv)

	// Place the converted session where Claude CLI will find it
	cliProjDir := claudeProjectDir(t, tmpDir)
	cliSessionID := generateTestUUID()

	ccResult, err := conversation.ConvertIonToClaudeCode(apiConv, cliSessionID, cliProjDir)
	if err != nil {
		t.Fatalf("ConvertIonToClaudeCode: %v", err)
	}
	t.Cleanup(func() {
		os.RemoveAll(cliProjDir)
	})

	if err := conversation.ValidateConversion(sourceMsgs, ccResult.OutputPath, "claude_code"); err != nil {
		t.Fatalf("Validation: %v", err)
	}
	t.Logf("Converted %d messages to %s", ccResult.MessageCount, ccResult.OutputPath)

	// ── Step 3: Resume on CLI and ask for the code word ──
	t.Log("Step 3: Resuming on Claude CLI (--resume)...")
	cliBackend := backend.NewCliBackend()
	cliEc := newCliEventCollector(cliBackend)

	cliBackend.StartRun("mig-a2c-cli", types.RunOptions{
		Prompt:      "What was the code word I told you earlier? Reply with just the code word.",
		MaxTurns:    1,
		SessionID:   cliSessionID,
		ProjectPath: tmpDir,
	})

	cliEc.waitForExit(t, 90*time.Second)

	cliText := collectText(cliEc.getNormalized())
	t.Logf("CLI response: %s", strings.TrimSpace(cliText))

	if !strings.Contains(strings.ToUpper(cliText), "FALCON73") {
		t.Errorf("CLI should recall code word FALCON73, got: %q", cliText)
	}

	t.Log("API → CLI continuation verified!")
}

// ─── Test 2: CLI → convert → resume on API → verify continuation ────────────
//
// 1. Create a CLI conversation with a unique code word
// 2. Find the CLI session file and convert to Ion format
// 3. Continue the conversation on the API backend
// 4. Ask the API what the code word was — proving it can read and continue
func TestLiveMigrationCLIToAPIContinuation(t *testing.T) {
	model := setupAnthropicProvider(t)
	tmpDir := t.TempDir()
	convDir := defaultConvDir(t)

	// ── Step 1: Create CLI conversation with a code word ──
	t.Log("Step 1: Running CLI conversation with code word...")
	cliBackend := backend.NewCliBackend()
	cliEc := newCliEventCollector(cliBackend)

	cliBackend.StartRun("mig-c2a-cli", types.RunOptions{
		Prompt:      "Remember this code word: TIGER99. Just confirm you have it.",
		MaxTurns:    1,
		ProjectPath: tmpDir,
	})

	cliEc.waitForExit(t, 60*time.Second)
	cliText := collectText(cliEc.getNormalized())
	t.Logf("CLI response: %s", strings.TrimSpace(cliText))

	// ── Step 2: Find the CLI session and convert to Ion ──
	cliProjDir := claudeProjectDir(t, tmpDir)
	t.Logf("Looking for CLI session in: %s", cliProjDir)

	cliSessionID, cliConvPath := findSessionFile(t, cliProjDir)
	t.Logf("Found CLI session: %s", cliSessionID)
	t.Cleanup(func() { os.RemoveAll(cliProjDir) })

	t.Log("Step 2: Converting CLI → Ion format...")
	srcMsgs, err := conversation.ExtractValidationMsgsFromClaudeCode(cliConvPath)
	if err != nil {
		t.Fatalf("Extract CLI msgs: %v", err)
	}

	apiSessionID := "e2e-mig-c2a-api-" + conversation.GenEntryID()
	ionResult, err := conversation.ConvertClaudeCodeToIon(cliConvPath, apiSessionID, convDir)
	if err != nil {
		t.Fatalf("ConvertClaudeCodeToIon: %v", err)
	}
	t.Cleanup(func() {
		os.Remove(filepath.Join(convDir, apiSessionID+".jsonl"))
	})

	if err := conversation.ValidateConversion(srcMsgs, ionResult.OutputPath, "ion"); err != nil {
		t.Fatalf("Validation CLI→API: %v", err)
	}
	t.Logf("Converted %d messages to Ion format", ionResult.MessageCount)

	// ── Step 3: Continue on API and ask for the code word ──
	t.Log("Step 3: Continuing on API backend...")
	apiBackend := backend.NewApiBackend()
	ec := newEventCollector(apiBackend)

	apiBackend.StartRun("mig-c2a-api", types.RunOptions{
		Prompt:       "What was the code word I told you? Reply with just the code word.",
		Model:        model,
		MaxTurns:     1,
		MaxBudgetUsd: 0.10,
		AllowedTools: []string{},
		SessionID:    apiSessionID,
	})

	ec.waitForExit(t, 30*time.Second)

	apiText := collectText(ec.getNormalized())
	t.Logf("API response: %s", strings.TrimSpace(apiText))

	if !strings.Contains(strings.ToUpper(apiText), "TIGER99") {
		t.Errorf("API should recall code word TIGER99, got: %q", apiText)
	}

	t.Log("CLI → API continuation verified!")
}

// ─── Test 3: Full round-trip with continuation at every hop ──────────────────
//
// 1. API: "Remember ALPHA1"   → confirms
// 2. Convert API → CLI
// 3. CLI: "Also remember BETA2" → confirms (proves it has ALPHA1 context)
// 4. Convert CLI → API
// 5. API: "What were both code words?" → should respond with ALPHA1 and BETA2
func TestLiveMigrationFullRoundTripContinuation(t *testing.T) {
	model := setupAnthropicProvider(t)
	tmpDir := t.TempDir()
	convDir := defaultConvDir(t)

	apiSessionID1 := "e2e-mig-rt-" + conversation.GenEntryID()

	// ── Step 1: API establishes code word ALPHA1 ──
	t.Log("Step 1: API conversation — establish ALPHA1...")
	api1 := backend.NewApiBackend()
	ec1 := newEventCollector(api1)

	api1.StartRun("mig-rt-1", types.RunOptions{
		Prompt:       "Remember the code word: ALPHA1. Confirm you have it, nothing else.",
		Model:        model,
		MaxTurns:     1,
		MaxBudgetUsd: 0.10,
		AllowedTools: []string{},
		SessionID:    apiSessionID1,
		ProjectPath:  tmpDir,
	})
	ec1.waitForExit(t, 30*time.Second)
	t.Cleanup(func() { os.Remove(filepath.Join(convDir, apiSessionID1+".jsonl")) })
	t.Logf("API step 1 response: %s", strings.TrimSpace(collectText(ec1.getNormalized())))

	// ── Step 2: Convert API → CLI ──
	t.Log("Step 2: Converting API → Claude Code...")
	apiConv1, err := conversation.Load(apiSessionID1, convDir)
	if err != nil {
		t.Fatalf("Load: %v", err)
	}

	cliProjDir := claudeProjectDir(t, tmpDir)
	cliSessID := generateTestUUID()

	_, err = conversation.ConvertIonToClaudeCode(apiConv1, cliSessID, cliProjDir)
	if err != nil {
		t.Fatalf("ConvertIonToClaudeCode: %v", err)
	}
	t.Cleanup(func() { os.RemoveAll(cliProjDir) })

	// ── Step 3: CLI — add second code word BETA2 ──
	t.Log("Step 3: CLI continuation — add BETA2...")
	cli := backend.NewCliBackend()
	cliEc := newCliEventCollector(cli)

	cli.StartRun("mig-rt-cli", types.RunOptions{
		Prompt:      "Also remember a second code word: BETA2. Confirm you have both code words.",
		MaxTurns:    1,
		SessionID:   cliSessID,
		ProjectPath: tmpDir,
	})
	cliEc.waitForExit(t, 90*time.Second)

	cliText := collectText(cliEc.getNormalized())
	t.Logf("CLI step 3 response: %s", strings.TrimSpace(cliText))

	// CLI should acknowledge both
	upperCli := strings.ToUpper(cliText)
	if !strings.Contains(upperCli, "ALPHA1") {
		t.Errorf("CLI should know ALPHA1 from migrated context, got: %q", cliText)
	}
	if !strings.Contains(upperCli, "BETA2") {
		t.Errorf("CLI should know BETA2, got: %q", cliText)
	}

	// ── Step 4: Convert CLI → API ──
	t.Log("Step 4: Converting CLI → Ion...")
	cliConvPath := filepath.Join(cliProjDir, cliSessID+".jsonl")
	if _, err := os.Stat(cliConvPath); err != nil {
		t.Fatalf("CLI session file not found: %v", err)
	}

	srcMsgs, err := conversation.ExtractValidationMsgsFromClaudeCode(cliConvPath)
	if err != nil {
		t.Fatalf("Extract CLI msgs: %v", err)
	}

	apiSessionID2 := "e2e-mig-rt-final-" + conversation.GenEntryID()
	ionResult, err := conversation.ConvertClaudeCodeToIon(cliConvPath, apiSessionID2, convDir)
	if err != nil {
		t.Fatalf("ConvertClaudeCodeToIon: %v", err)
	}
	t.Cleanup(func() { os.Remove(filepath.Join(convDir, apiSessionID2+".jsonl")) })

	if err := conversation.ValidateConversion(srcMsgs, ionResult.OutputPath, "ion"); err != nil {
		t.Fatalf("Validation: %v", err)
	}

	// ── Step 5: API — ask for both code words ──
	t.Log("Step 5: API continuation — recall both code words...")
	api2 := backend.NewApiBackend()
	ec2 := newEventCollector(api2)

	api2.StartRun("mig-rt-final", types.RunOptions{
		Prompt:       "What were the two code words I told you? Reply with just the two code words.",
		Model:        model,
		MaxTurns:     1,
		MaxBudgetUsd: 0.10,
		AllowedTools: []string{},
		SessionID:    apiSessionID2,
	})
	ec2.waitForExit(t, 30*time.Second)

	apiText := collectText(ec2.getNormalized())
	t.Logf("API step 5 response: %s", strings.TrimSpace(apiText))

	upperApi := strings.ToUpper(apiText)
	if !strings.Contains(upperApi, "ALPHA1") {
		t.Errorf("API should recall ALPHA1, got: %q", apiText)
	}
	if !strings.Contains(upperApi, "BETA2") {
		t.Errorf("API should recall BETA2, got: %q", apiText)
	}

	t.Logf("Full round-trip verified: API(ALPHA1) → CLI(+BETA2) → API(recalls both)")
}

// ─── Test 4: Plan mode survives migration ────────────────────────────────────
//
// 1. API in plan mode: create a plan file with specific content
// 2. Convert API → CLI
// 3. CLI resumes, asked to read the plan and add to it
// 4. Convert CLI → API
// 5. API resumes in plan mode with the same plan file — verifies it can
//    continue planning with the full conversation history + plan file
func TestLiveMigrationPlanModeSurvival(t *testing.T) {
	model := setupAnthropicProvider(t)
	tmpDir := t.TempDir()
	convDir := defaultConvDir(t)

	// Create a plan file
	planDir := filepath.Join(tmpDir, "plans")
	os.MkdirAll(planDir, 0o755)
	planPath := filepath.Join(planDir, "test-plan.md")
	planV1 := "# Calculator Plan\n\n## Phase 1: Basic Operations\n- Add\n- Subtract\n- Multiply\n- Divide\n"
	os.WriteFile(planPath, []byte(planV1), 0o644)

	apiSessionID1 := "e2e-mig-plan-" + conversation.GenEntryID()

	// ── Step 1: API in plan mode — discuss the plan ──
	t.Log("Step 1: API plan mode — establishing plan context...")
	api1 := backend.NewApiBackend()
	ec1 := newEventCollector(api1)

	api1.StartRun("mig-plan-1", types.RunOptions{
		Prompt:       "Read the plan at " + planPath + " and confirm you see the Calculator Plan with Phase 1 Basic Operations. Just confirm what you see, briefly.",
		Model:        model,
		MaxTurns:     3,
		MaxBudgetUsd: 0.30,
		SessionID:    apiSessionID1,
		ProjectPath:  tmpDir,
		PlanMode:     true,
		PlanFilePath: planPath,
	})
	ec1.waitForExit(t, 45*time.Second)
	t.Cleanup(func() { os.Remove(filepath.Join(convDir, apiSessionID1+".jsonl")) })

	apiText1 := collectText(ec1.getNormalized())
	t.Logf("API step 1: %s", strings.TrimSpace(apiText1))

	if !strings.Contains(strings.ToLower(apiText1), "calculator") {
		t.Errorf("API should reference the calculator plan, got: %q", apiText1)
	}

	// ── Step 2: Convert API → CLI ──
	t.Log("Step 2: Converting plan conversation API → CLI...")
	apiConv1, err := conversation.Load(apiSessionID1, convDir)
	if err != nil {
		t.Fatalf("Load: %v", err)
	}

	cliProjDir := claudeProjectDir(t, tmpDir)
	cliSessID := generateTestUUID()

	_, err = conversation.ConvertIonToClaudeCode(apiConv1, cliSessID, cliProjDir)
	if err != nil {
		t.Fatalf("ConvertIonToClaudeCode: %v", err)
	}
	t.Cleanup(func() { os.RemoveAll(cliProjDir) })

	// ── Step 3: CLI continues — reads and updates the plan ──
	t.Log("Step 3: CLI continuation — update the plan file...")
	cli := backend.NewCliBackend()
	cliEc := newCliEventCollector(cli)

	cli.StartRun("mig-plan-cli", types.RunOptions{
		Prompt:      "Read the plan file at " + planPath + " and add a Phase 2 for 'Advanced Operations' including square root and power. Write the updated plan back to the same file.",
		MaxTurns:    5,
		SessionID:   cliSessID,
		ProjectPath: tmpDir,
	})
	cliEc.waitForExit(t, 90*time.Second)

	cliText := collectText(cliEc.getNormalized())
	t.Logf("CLI step 3: %s", strings.TrimSpace(cliText)[:min(200, len(strings.TrimSpace(cliText)))])

	// Verify plan file was updated
	planV2, err := os.ReadFile(planPath)
	if err != nil {
		t.Fatalf("Read plan after CLI: %v", err)
	}
	planV2Lower := strings.ToLower(string(planV2))
	if !strings.Contains(planV2Lower, "phase 1") {
		t.Errorf("Plan V2 should still contain Phase 1, got: %s", string(planV2)[:min(200, len(planV2))])
	}
	if !strings.Contains(planV2Lower, "phase 2") {
		t.Errorf("Plan V2 should contain Phase 2, got: %s", string(planV2)[:min(200, len(planV2))])
	}
	t.Logf("Plan V2 (%d bytes): contains Phase 1 and Phase 2", len(planV2))

	// ── Step 4: Convert CLI → API ──
	t.Log("Step 4: Converting CLI → Ion...")
	cliConvPath := filepath.Join(cliProjDir, cliSessID+".jsonl")
	srcMsgs, err := conversation.ExtractValidationMsgsFromClaudeCode(cliConvPath)
	if err != nil {
		t.Fatalf("Extract CLI msgs: %v", err)
	}

	apiSessionID2 := "e2e-mig-plan-final-" + conversation.GenEntryID()
	ionResult, err := conversation.ConvertClaudeCodeToIon(cliConvPath, apiSessionID2, convDir)
	if err != nil {
		t.Fatalf("ConvertClaudeCodeToIon: %v", err)
	}
	t.Cleanup(func() { os.Remove(filepath.Join(convDir, apiSessionID2+".jsonl")) })

	if err := conversation.ValidateConversion(srcMsgs, ionResult.OutputPath, "ion"); err != nil {
		t.Fatalf("Validation: %v", err)
	}

	// ── Step 5: API resumes in plan mode ──
	t.Log("Step 5: API plan mode resume — continue working on the plan...")
	api2 := backend.NewApiBackend()
	ec2 := newEventCollector(api2)

	api2.StartRun("mig-plan-final", types.RunOptions{
		Prompt:       "Read the plan at " + planPath + " and add a Phase 3 for 'Testing Strategy' including unit tests and integration tests. Write the updated plan back to the same file. Then call ExitPlanMode.",
		Model:        model,
		MaxTurns:     5,
		MaxBudgetUsd: 0.50,
		SessionID:    apiSessionID2,
		ProjectPath:  tmpDir,
		PlanMode:     true,
		PlanFilePath: planPath,
	})
	ec2.waitForExit(t, 60*time.Second)

	apiText2 := collectText(ec2.getNormalized())
	t.Logf("API step 5: %s", strings.TrimSpace(apiText2)[:min(200, len(strings.TrimSpace(apiText2)))])

	// Verify plan file has all three phases
	planV3, err := os.ReadFile(planPath)
	if err != nil {
		t.Fatalf("Read plan after API resume: %v", err)
	}
	planV3Lower := strings.ToLower(string(planV3))
	for _, phase := range []string{"phase 1", "phase 2", "phase 3"} {
		if !strings.Contains(planV3Lower, phase) {
			t.Errorf("Final plan should contain %q, plan:\n%s", phase, string(planV3)[:min(500, len(planV3))])
		}
	}

	t.Logf("Plan migration verified: API(Phase1) → CLI(+Phase2) → API(+Phase3), plan file = %d bytes", len(planV3))
}

func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}
