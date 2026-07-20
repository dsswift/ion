package cliprobe

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"time"

	"github.com/dsswift/ion/engine/internal/acp"
	"github.com/dsswift/ion/engine/internal/codexrpc"
	"github.com/dsswift/ion/engine/internal/rpcstdio"
	"github.com/dsswift/ion/engine/internal/utils"
)

// loginTimeout bounds an interactive login when the caller's context carries no
// deadline of its own.
const loginTimeout = 10 * time.Minute

// logoutTimeout bounds a logout when the caller's context carries no deadline of
// its own. Logout spawns the CLI's app-server and issues a single Logout RPC; a
// wedged CLI must not block the server goroutine (and the RefreshProviderProbes
// call sequenced after it) indefinitely.
const logoutTimeout = 30 * time.Second

// LoginStage is one transition of an interactive login, reported via LoginEmit.
type LoginStage struct {
	Stage           string
	AuthURL         string
	UserCode        string
	VerificationURL string
	Error           string
	LoginID         string
}

// LoginEmit receives login stage transitions.
type LoginEmit func(LoginStage)

// LoginFunc drives an interactive login for a backend kind, emitting stages,
// and blocks until the flow terminates or ctx is done.
type LoginFunc func(ctx context.Context, kind string, emit LoginEmit) error

// LogoutFunc clears the stored credential for a backend kind.
type LogoutFunc func(ctx context.Context, kind string) error

// Login drives the interactive login for a backend kind. codex uses the
// account/login flow (browser or device code); the ACP agents use authenticate
// (the CLI drives its own browser). Blocks until a terminal stage or ctx done.
func Login(ctx context.Context, kind string, emit LoginEmit) error {
	if _, ok := ctx.Deadline(); !ok {
		var cancel context.CancelFunc
		ctx, cancel = context.WithTimeout(ctx, loginTimeout)
		defer cancel()
	}
	switch kind {
	case "codex":
		return loginCodex(ctx, emit)
	case "grok":
		return loginACP(ctx, kind, "grok", []string{"agent", "stdio"}, []string{"GROK_OAUTH2_REFERRER=ion"}, grokAuthMethod(), emit)
	case "cursor":
		return loginACP(ctx, kind, "agent", []string{"acp"}, nil, "cursor_login", emit)
	default:
		return fmt.Errorf("login not supported for backend %q", kind)
	}
}

// Logout clears the stored credential for a backend kind (codex only; the ACP
// agents manage their own credential store).
func Logout(ctx context.Context, kind string) error {
	if kind != "codex" {
		return fmt.Errorf("logout not supported for backend %q", kind)
	}
	if _, ok := ctx.Deadline(); !ok {
		var cancel context.CancelFunc
		ctx, cancel = context.WithTimeout(ctx, logoutTimeout)
		defer cancel()
	}
	bin, err := Find("codex", nil)
	if err != nil {
		return err
	}
	proc, err := rpcstdio.Spawn(ctx, bin, []string{"app-server"}, nil, rpcstdio.Options{Tag: "cliprobe.logout"})
	if err != nil {
		return err
	}
	defer proc.Kill()
	client := codexrpc.NewClientFromRPC(proc.Client, codexrpc.Handlers{})
	if _, err := client.Initialize(ctx, codexrpc.ClientInfo{Name: "ion-engine-logout", Version: "1"}); err != nil {
		return err
	}
	return client.Logout(ctx)
}

// grokAuthMethod mirrors the grok backend's auth-method selection.
func grokAuthMethod() string {
	if os.Getenv("XAI_API_KEY") != "" {
		return "xai.api_key"
	}
	return "cached_token"
}

// loginCodex runs the codex account/login flow. It emits await_browser or
// await_device_code from the start response, then waits for the
// account/login/completed notification.
func loginCodex(ctx context.Context, emit LoginEmit) error {
	bin, err := Find("codex", nil)
	if err != nil {
		emit(LoginStage{Stage: "failed", Error: "codex CLI not installed"})
		return err
	}
	completed := make(chan codexrpc.LoginCompletedNotification, 1)
	handlers := codexrpc.Handlers{
		OnNotification: func(method string, params json.RawMessage) {
			if method != codexrpc.NotifLoginCompleted {
				return
			}
			var n codexrpc.LoginCompletedNotification
			if err := json.Unmarshal(params, &n); err != nil {
				utils.LogWithFields(utils.LevelWarn, "cliprobe", "login_completed notification decode failed", map[string]any{"error": utils.ErrStr(err)})
			}
			select {
			case completed <- n:
			default:
			}
		},
	}
	proc, err := rpcstdio.Spawn(ctx, bin, []string{"app-server"}, nil, codexrpc.SpawnHandlers(handlers))
	if err != nil {
		emit(LoginStage{Stage: "failed", Error: err.Error()})
		return err
	}
	defer proc.Kill()
	client := codexrpc.NewClientFromRPC(proc.Client, handlers)
	if _, err := client.Initialize(ctx, codexrpc.ClientInfo{Name: "ion-engine-login", Version: "1"}); err != nil {
		emit(LoginStage{Stage: "failed", Error: err.Error()})
		return err
	}

	emit(LoginStage{Stage: "started"})
	start, err := client.LoginStart(ctx)
	if err != nil {
		emit(LoginStage{Stage: "failed", Error: err.Error()})
		return err
	}
	switch start.Type {
	case "chatgpt":
		emit(LoginStage{Stage: "await_browser", AuthURL: start.AuthURL, LoginID: start.LoginID})
	case "chatgptDeviceCode":
		emit(LoginStage{Stage: "await_device_code", UserCode: start.UserCode, VerificationURL: start.VerificationURL, LoginID: start.LoginID})
	default:
		// apiKey / chatgptAuthTokens: already usable.
		emit(LoginStage{Stage: "completed"})
		return nil
	}

	select {
	case n := <-completed:
		if n.Success {
			emit(LoginStage{Stage: "completed", LoginID: n.LoginID})
			return nil
		}
		emit(LoginStage{Stage: "failed", Error: n.Error, LoginID: n.LoginID})
		return fmt.Errorf("codex login failed: %s", n.Error)
	case <-ctx.Done():
		client.LoginCancel(context.Background(), start.LoginID) //nolint:errcheck // best-effort cancel of an abandoned login
		emit(LoginStage{Stage: "cancelled", LoginID: start.LoginID})
		return ctx.Err()
	}
}

// loginACP runs an ACP authenticate flow. The CLI drives its own browser; the
// engine emits started, then completed or failed from the authenticate result.
func loginACP(ctx context.Context, kind, binary string, args, envExtra []string, methodID string, emit LoginEmit) error {
	bin, err := Find(binary, nil)
	if err != nil {
		emit(LoginStage{Stage: "failed", Error: kind + " CLI not installed"})
		return err
	}
	env := appendEnviron(envExtra)
	proc, err := rpcstdio.Spawn(ctx, bin, args, env, acp.SpawnOptions(kind, acp.Handlers{}))
	if err != nil {
		emit(LoginStage{Stage: "failed", Error: err.Error()})
		return err
	}
	defer proc.Kill()
	client := acp.NewClientFromRPC(proc.Client, kind, acp.Handlers{})
	if _, err := client.Initialize(ctx, acp.ClientInfo{Name: "ion-engine-login", Version: "1"}); err != nil {
		emit(LoginStage{Stage: "failed", Error: err.Error()})
		return err
	}
	emit(LoginStage{Stage: "started"})
	emit(LoginStage{Stage: "await_browser"})
	if err := client.Authenticate(ctx, methodID); err != nil {
		emit(LoginStage{Stage: "failed", Error: err.Error()})
		return err
	}
	emit(LoginStage{Stage: "completed"})
	utils.LogWithFields(utils.LevelInfo, "cliprobe", "acp login completed", map[string]any{"kind": kind})
	return nil
}
