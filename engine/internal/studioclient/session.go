package studioclient

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
	"sync/atomic"
	"time"

	"github.com/coder/websocket"

	"github.com/dsswift/ion/engine/internal/utils"
)

// studioProtocolVersion is the Studio wire version this client speaks.
const studioProtocolVersion = 1

// relayProofTag is the fixed nonce a relay hello's proof is an HMAC over. The
// sealed channel keyed by the shared secret is the real proof; the field keeps
// the credential's wire shape.
const relayProofTag = "relay"

// Welcome is the part of `studio_welcome` a status reader uses.
type Welcome struct {
	EnvironmentID string   `json:"environmentId"`
	Label         string   `json:"label"`
	Platform      string   `json:"platform"`
	ServerVersion string   `json:"serverVersion"`
	EngineVersion string   `json:"engineVersion"`
	Scopes        []string `json:"scopes"`
	Relays        []Relay  `json:"relays,omitempty"`
}

// Session is one Studio connection: sealed over a relay channel, or plain
// over a server's own TLS address (secret nil).
type Session struct {
	conn    *websocket.Conn
	secret  []byte
	nextID  atomic.Int64
	Welcome Welcome
}

type frame struct {
	Type    string          `json:"type"`
	ID      string          `json:"id,omitempty"`
	OK      bool            `json:"ok,omitempty"`
	Value   json.RawMessage `json:"value,omitempty"`
	Reason  string          `json:"reason,omitempty"`
	Detail  string          `json:"detail,omitempty"`
	Refusal *struct {
		Code    string `json:"code"`
		Message string `json:"message"`
	} `json:"refusal,omitempty"`
	Error *struct {
		Code    string `json:"code"`
		Message string `json:"message"`
	} `json:"error,omitempty"`
}

// Connect joins the pairing's channel on `relay`, says hello with the paired
// credential in the thin view, and waits for the welcome.
func Connect(ctx context.Context, relay Relay, bearer string, p Pairing) (*Session, error) {
	conn, err := dialRelay(ctx, relay.URL, ChannelID(p.SharedSecret), bearer)
	if err != nil {
		return nil, err
	}
	s := &Session{conn: conn, secret: p.SharedSecret}
	proof := RelayProof(p.SharedSecret)
	hello := map[string]any{
		"type": "studio_hello", "protocolVersion": studioProtocolVersion, "clientId": p.ClientID,
		"clientKind": "desktop", "capabilities": []string{}, "view": "thin",
		"credential": map[string]any{"kind": "paired", "clientId": p.ClientID, "proof": proof},
	}
	if err := s.handshake(ctx, hello, relay.URL); err != nil {
		return nil, err
	}
	return s, nil
}

// handshake says hello and waits for the welcome; on a refusal or an error
// the session is closed.
func (s *Session) handshake(ctx context.Context, hello map[string]any, where string) error {
	if err := s.send(ctx, hello); err != nil {
		s.Close()
		return err
	}
	for {
		raw, err := s.read(ctx)
		if err != nil {
			s.Close()
			return fmt.Errorf("waiting for studio_welcome: %w", err)
		}
		var f frame
		if json.Unmarshal(raw, &f) != nil {
			continue
		}
		switch f.Type {
		case "studio_welcome":
			if err := json.Unmarshal(raw, &s.Welcome); err != nil {
				s.Close()
				return fmt.Errorf("decode studio_welcome: %w", err)
			}
			utils.LogWithFields(utils.LevelInfo, logTag, "studio session welcomed", map[string]any{"where": where, "sealed": s.secret != nil, "environment_id": s.Welcome.EnvironmentID, "server_version": s.Welcome.ServerVersion})
			return nil
		case "studio_refused":
			s.Close()
			utils.LogWithFields(utils.LevelWarn, logTag, "studio session refused", map[string]any{"where": where, "reason": f.Reason, "detail": f.Detail})
			return fmt.Errorf("the server refused the connection: %s %s", f.Reason, f.Detail)
		}
	}
}

// RelayProof is the proof a relay hello carries: the HMAC the TypeScript
// client computes over Node's base64 reading of the literal "relay", which
// ignores the trailing character that does not fill a byte.
func RelayProof(secret []byte) string {
	tag := relayProofTag[:len(relayProofTag)-len(relayProofTag)%4]
	nonce, _ := base64.RawStdEncoding.DecodeString(tag) //nolint:errcheck // a fixed, valid four-character tag
	mac := hmac.New(sha256.New, secret)
	mac.Write(nonce) //nolint:errcheck // hash writes never fail
	return base64.StdEncoding.EncodeToString(mac.Sum(nil))
}

// Action runs one studio action and returns its value.
func (s *Session) Action(ctx context.Context, action string, args ...any) (json.RawMessage, error) {
	if args == nil {
		args = []any{}
	}
	id := "fleet-" + strconv.FormatInt(s.nextID.Add(1), 10)
	if err := s.send(ctx, map[string]any{"type": "studio_action", "id": id, "action": action, "args": args}); err != nil {
		return nil, err
	}
	for {
		raw, err := s.read(ctx)
		if err != nil {
			return nil, fmt.Errorf("waiting for %s: %w", action, err)
		}
		var f frame
		if json.Unmarshal(raw, &f) != nil || f.Type != "studio_action_result" || f.ID != id {
			continue
		}
		if f.OK {
			return f.Value, nil
		}
		if f.Refusal != nil {
			return nil, fmt.Errorf("%s refused: %s", action, f.Refusal.Message)
		}
		if f.Error != nil {
			return nil, fmt.Errorf("%s failed: %s", action, f.Error.Message)
		}
		return nil, fmt.Errorf("%s failed", action)
	}
}

// Close ends the session.
func (s *Session) Close() {
	s.conn.Close(websocket.StatusNormalClosure, "done") //nolint:errcheck // one-shot session teardown
}

func (s *Session) send(ctx context.Context, v any) error {
	data, err := json.Marshal(v)
	if err != nil {
		return err
	}
	if s.secret == nil {
		return s.conn.Write(ctx, websocket.MessageText, data)
	}
	sealed, err := SealFrame(data, s.secret)
	if err != nil {
		return err
	}
	return s.conn.Write(ctx, websocket.MessageText, []byte(sealed))
}

// read returns the next opened text frame, skipping relay control frames,
// binary frames, and anything that does not open with this secret.
func (s *Session) read(ctx context.Context) ([]byte, error) {
	for {
		kind, data, err := s.conn.Read(ctx)
		if err != nil {
			return nil, err
		}
		if s.secret == nil {
			if kind == websocket.MessageText {
				return data, nil
			}
			continue
		}
		if isRelayControl(string(data)) {
			continue
		}
		opened, isBinary, err := OpenFrame(string(data), s.secret)
		if err != nil {
			if !errors.Is(err, errNotEnvelope) {
				utils.LogWithFields(utils.LevelWarn, logTag, "dropped a relay frame that did not open", map[string]any{"error": err.Error()})
			}
			continue
		}
		if isBinary {
			continue
		}
		return opened, nil
	}
}

// ReadTimeout bounds a whole status read through the relay.
const ReadTimeout = 20 * time.Second
