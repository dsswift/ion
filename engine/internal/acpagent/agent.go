package acpagent

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"sync"

	"github.com/dsswift/ion/engine/internal/rpcstdio"
	"github.com/dsswift/ion/engine/internal/utils"
)

// Options configures an Agent.
type Options struct {
	// Version is the engine build version reported as agentInfo.version.
	Version string
	// Profile is the engine profile (name or id) every new session loads
	// unless the client picks another through the profile config option.
	// Empty loads no extensions.
	Profile string
	// Model is the model every new session starts on. Empty uses the
	// engine's default.
	Model string
	// Profiles is the profile catalog the config option offers.
	Profiles []Profile
	// DefaultModel is the engine's configured default, shown as the model
	// option's current value when the session names none.
	DefaultModel string
	// Harness, when set, pins every session to one extension. The agent
	// reports the harness as itself in agentInfo and offers no profile
	// option, so a client sees the harness, not the engine. Profile and
	// Profiles are ignored.
	Harness *Harness
	// SignIn, when set, offers clients the engine's operator sign-in.
	SignIn *SignIn
}

// Profile is one engine profile the agent can load.
type Profile struct {
	ID         string
	Name       string
	Extensions []string
}

// Harness is the one extension a pinned agent serves.
type Harness struct {
	// Name is the agentInfo name: the extension's manifest name.
	Name string
	// Title is the agentInfo title a client shows. Empty falls back to Name.
	Title string
	// Path is the extension path every session loads.
	Path string
}

// harnessName is the pinned harness's name for log lines, empty when the
// agent serves the profile catalog.
func (o Options) harnessName() string {
	if o.Harness == nil {
		return ""
	}
	return o.Harness.Name
}

// agentInfo is the implementation the agent reports on initialize: the
// pinned harness, else the engine.
func (o Options) agentInfo() Implementation {
	if h := o.Harness; h != nil {
		title := h.Title
		if title == "" {
			title = h.Name
		}
		return Implementation{Name: h.Name, Title: title, Version: o.Version}
	}
	return Implementation{Name: "ion", Title: "Ion Engine", Version: o.Version}
}

// Agent is one ACP agent process: a JSON-RPC peer over stdio and a
// connection to the engine.
type Agent struct {
	engine *EngineConn
	rpc    *rpcstdio.Client
	opts   Options

	mu       sync.Mutex
	client   ClientCapabilities
	sessions map[string]*Session
	models   []SelectOption
	done     chan struct{}
}

// New builds an Agent over the given stdio pair. out is the pipe the
// client reads (our stdout); in is the pipe the client writes (our stdin).
func New(engine *EngineConn, out io.WriteCloser, in io.Reader, opts Options) *Agent {
	a := &Agent{engine: engine, opts: opts, sessions: map[string]*Session{}, done: make(chan struct{})}
	a.rpc = rpcstdio.NewClient(out, in, rpcstdio.Options{
		Tag:             "acp.agent",
		OnRequestWithID: a.handleRequest,
		OnNotification:  a.handleNotification,
		OnClosed: func(err error) {
			utils.LogWithFields(utils.LevelInfo, "acp", "client connection ended", map[string]any{"error": utils.ErrStr(err)})
			close(a.done)
		},
	})
	return a
}

// Done is closed when the client ends the stdio conversation.
func (a *Agent) Done() <-chan struct{} { return a.done }

// Shutdown stops every session this agent opened. Sessions are stopped,
// not settled: the conversations stay on disk for session/load.
func (a *Agent) Shutdown(ctx context.Context) {
	a.mu.Lock()
	sessions := make([]*Session, 0, len(a.sessions))
	for _, s := range a.sessions {
		sessions = append(sessions, s)
	}
	a.mu.Unlock()
	for _, s := range sessions {
		s.stop(ctx)
	}
}

func (a *Agent) session(id string) (*Session, *rpcstdio.RPCError) {
	a.mu.Lock()
	s, ok := a.sessions[id]
	a.mu.Unlock()
	if !ok {
		return nil, &rpcstdio.RPCError{Code: -32602, Message: "unknown session: " + id}
	}
	return s, nil
}

func (a *Agent) handleNotification(method string, params json.RawMessage) {
	switch method {
	case MethodSessionCancel:
		var req CancelNotification
		if err := json.Unmarshal(params, &req); err != nil {
			utils.LogWithFields(utils.LevelWarn, "acp", "cancel: bad params", map[string]any{"error": err.Error()})
			return
		}
		s, rpcErr := a.session(req.SessionID)
		if rpcErr != nil {
			utils.LogWithFields(utils.LevelWarn, "acp", "cancel: unknown session", map[string]any{"session_id": req.SessionID})
			return
		}
		s.cancel()
	default:
		utils.LogWithFields(utils.LevelDebug, "acp", "notification ignored", map[string]any{"method": method})
	}
}

func (a *Agent) handleRequest(method string, id, params json.RawMessage) (any, *rpcstdio.RPCError) {
	utils.LogWithFields(utils.LevelDebug, "acp", "request", map[string]any{"method": method})
	switch method {
	case MethodInitialize:
		return a.initialize(params)
	case MethodAuthenticate:
		return a.authenticate(id, params)
	case MethodLogout:
		return a.logout()
	case MethodSessionNew:
		return a.sessionNew(params)
	case MethodSessionLoad:
		return a.sessionLoad(params)
	case MethodSessionPrompt:
		return a.sessionPrompt(params)
	case MethodSessionSetMode:
		return a.sessionSetMode(params)
	case MethodSessionSetConfigOption:
		return a.sessionSetConfigOption(params)
	default:
		return nil, &rpcstdio.RPCError{Code: -32601, Message: "method not found: " + method}
	}
}

func (a *Agent) initialize(params json.RawMessage) (any, *rpcstdio.RPCError) {
	var req InitializeRequest
	if err := json.Unmarshal(params, &req); err != nil {
		return nil, badParams(err)
	}
	a.mu.Lock()
	a.client = req.ClientCapabilities
	a.mu.Unlock()
	clientName := ""
	if req.ClientInfo != nil {
		clientName = req.ClientInfo.Name + " " + req.ClientInfo.Version
	}
	utils.LogWithFields(utils.LevelInfo, "acp", "initialized", map[string]any{
		"client": clientName, "client_protocol": req.ProtocolVersion,
		"notices": a.clientSupportsNotices(), "form_elicitation": a.clientSupportsForms(),
	})
	return InitializeResponse{
		ProtocolVersion: ProtocolVersion,
		AgentCapabilities: AgentCapabilities{
			LoadSession:         true,
			PromptCapabilities:  PromptCapabilities{Image: true, EmbeddedContext: true},
			McpCapabilities:     map[string]bool{"http": false, "sse": false},
			SessionCapabilities: map[string]any{},
			Auth:                a.opts.authCapabilities(),
		},
		AuthMethods: a.opts.authMethods(),
		AgentInfo:   a.opts.agentInfo(),
	}, nil
}

func (a *Agent) clientSupportsNotices() bool {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.client.Session != nil && len(a.client.Session.Notices) > 0 && string(a.client.Session.Notices) != "null"
}

func (a *Agent) clientSupportsForms() bool {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.client.Elicitation != nil && len(a.client.Elicitation.Form) > 0 && string(a.client.Elicitation.Form) != "null"
}

// notify sends one session/update to the client.
func (a *Agent) notify(sessionID string, update SessionUpdate) {
	if err := a.rpc.Notify(NotifSessionUpdate, SessionNotification{SessionID: sessionID, Update: update}); err != nil {
		utils.LogWithFields(utils.LevelWarn, "acp", "session update not delivered", map[string]any{"session_id": sessionID, "update": update.SessionUpdate, "error": err.Error()})
	}
}

func badParams(err error) *rpcstdio.RPCError {
	return &rpcstdio.RPCError{Code: -32602, Message: "invalid params: " + err.Error()}
}

// JSON-RPC error codes the agent answers with. ACP reserves -32000 for
// "authentication required", which a client answers by signing in, so no
// other failure may use it.
const (
	codeAuthRequired  = -32000
	codeInternalError = -32603
)

// internalError answers a failed request. A refusal for want of an operator
// sign-in is authentication required, so the client can offer sign-in.
func internalError(err error) *rpcstdio.RPCError {
	if errors.Is(err, errAuthRequired) {
		return &rpcstdio.RPCError{Code: codeAuthRequired, Message: err.Error()}
	}
	return &rpcstdio.RPCError{Code: codeInternalError, Message: err.Error()}
}

func fmtErr(format string, args ...any) *rpcstdio.RPCError {
	return &rpcstdio.RPCError{Code: codeInternalError, Message: fmt.Sprintf(format, args...)}
}
