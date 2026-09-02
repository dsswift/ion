package cliprobe

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"slices"
	"testing"
	"time"
)

func TestLoginClaudeCodeCompletesFromBrowserCallback(t *testing.T) {
	restoreFinder := claudeLoginFinder
	restoreCommand := claudeLoginCommand
	claudeLoginFinder = func() (string, error) { return os.Args[0], nil }
	claudeLoginCommand = func(ctx context.Context, bin string) *exec.Cmd {
		cmd := exec.CommandContext(ctx, bin, "-test.run=TestClaudeLoginHelperProcess")
		cmd.Env = append(os.Environ(), "ION_CLAUDE_LOGIN_HELPER=browser-success")
		return cmd
	}
	t.Cleanup(func() {
		claudeLoginFinder = restoreFinder
		claudeLoginCommand = restoreCommand
	})

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	ctx = WithAuthCodeChannel(ctx, make(chan string))
	var stages []string

	if err := loginClaudeCode(ctx, func(stage LoginStage) {
		stages = append(stages, stage.Stage)
	}); err != nil {
		t.Fatalf("loginClaudeCode() error = %v", err)
	}

	want := []string{"started", "await_browser", "await_auth_code", "completed"}
	if !slices.Equal(stages, want) {
		t.Fatalf("stages = %v, want %v", stages, want)
	}
}

func TestClaudeLoginHelperProcess(t *testing.T) {
	if os.Getenv("ION_CLAUDE_LOGIN_HELPER") != "browser-success" {
		return
	}
	if _, err := os.Stdout.WriteString("Open https://claude.com/cai/oauth/authorize?flow=test\n"); err != nil {
		os.Exit(2)
	}
	time.Sleep(50 * time.Millisecond)
	os.Exit(0)
}

func TestWaitForClaudeLoginInputAcceptsCode(t *testing.T) {
	codes := make(chan string, 1)
	codes <- "auth-code"
	ctx := WithAuthCodeChannel(context.Background(), codes)

	code, childExited, err := waitForClaudeLoginInput(ctx, make(chan error))
	if err != nil {
		t.Fatalf("waitForClaudeLoginInput() error = %v", err)
	}
	if childExited {
		t.Fatal("childExited = true, want false for an authorization code")
	}
	if code != "auth-code" {
		t.Fatalf("code = %q, want auth-code", code)
	}
}

func TestWaitForClaudeLoginInputAcceptsBrowserCallbackCompletion(t *testing.T) {
	ctx := WithAuthCodeChannel(context.Background(), make(chan string))
	waitErr := make(chan error, 1)
	waitErr <- nil

	code, childExited, err := waitForClaudeLoginInput(ctx, waitErr)
	if err != nil {
		t.Fatalf("waitForClaudeLoginInput() error = %v", err)
	}
	if !childExited {
		t.Fatal("childExited = false, want true after browser callback completion")
	}
	if code != "" {
		t.Fatalf("code = %q, want empty after browser callback completion", code)
	}
}

func TestWaitForClaudeLoginInputReportsBrowserCallbackFailure(t *testing.T) {
	ctx := WithAuthCodeChannel(context.Background(), make(chan string))
	waitErr := make(chan error, 1)
	wantErr := errors.New("login process failed")
	waitErr <- wantErr

	_, childExited, err := waitForClaudeLoginInput(ctx, waitErr)
	if !childExited {
		t.Fatal("childExited = false, want true after child failure")
	}
	if !errors.Is(err, wantErr) {
		t.Fatalf("error = %v, want %v", err, wantErr)
	}
}

func TestWaitForClaudeLoginInputHonorsCancellation(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	ctx = WithAuthCodeChannel(ctx, make(chan string))
	cancel()

	_, childExited, err := waitForClaudeLoginInput(ctx, make(chan error))
	if childExited {
		t.Fatal("childExited = true, want false on cancellation")
	}
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("error = %v, want context.Canceled", err)
	}
}

func TestWaitForClaudeLoginInputRequiresCodeChannel(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()

	_, childExited, err := waitForClaudeLoginInput(ctx, make(chan error))
	if childExited {
		t.Fatal("childExited = true, want false without an auth-code channel")
	}
	if !errors.Is(err, errNoAuthCodeChannel) {
		t.Fatalf("error = %v, want %v", err, errNoAuthCodeChannel)
	}
}
