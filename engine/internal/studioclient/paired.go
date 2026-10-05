package studioclient

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/url"
	"os"
	"strings"

	"github.com/coder/websocket"

	"github.com/dsswift/ion/engine/internal/utils"
)

// A paired client at the server's own address. The listener is plain ws://,
// so every frame is sealed with the pairing secret: `?client=<clientId>`
// tells the server which secret to open them with, and the hello proves the
// secret with an HMAC over the nonce the server published.

// Binary frame channels (packages/shared/src/studio-wire/channels.ts).
const (
	binaryFileChunk = 0x03
	binaryFileEnd   = 0x04
)

// fileChunkBytes is how much of a file one binary frame carries.
const fileChunkBytes = 256 * 1024

// pairedAuthConfig is the part of /auth/config a paired client needs.
type pairedAuthConfig struct {
	Nonce string `json:"nonce"`
}

// helloClientID names this process to the server. A second connection that
// reuses a live connection's id displaces it, so one pairing shared by two
// programs (Studio and this one) needs an id per program instance.
func helloClientID() string {
	host, _ := os.Hostname() //nolint:errcheck // an unknown hostname names the client less precisely
	b := make([]byte, 4)
	if _, err := rand.Read(b); err != nil {
		return fmt.Sprintf("ion-fleet-%s-%d", host, os.Getpid())
	}
	return "ion-fleet-" + host + "-" + hex.EncodeToString(b)
}

func pairedHello(p Pairing, proof string) map[string]any {
	return map[string]any{
		"type": "studio_hello", "protocolVersion": studioProtocolVersion, "clientId": helloClientID(),
		"clientKind": "desktop", "capabilities": []string{}, "view": "thin",
		"credential": map[string]any{"kind": "paired", "clientId": p.ClientID, "proof": proof},
	}
}

// ConnectPaired opens a sealed Studio connection at the server's address
// with a pairing, in the thin view, and waits for the welcome.
func ConnectPaired(ctx context.Context, base string, p Pairing) (*Session, error) {
	base = strings.TrimSuffix(base, "/")
	var cfg pairedAuthConfig
	if err := getJSON(ctx, base+"/auth/config", &cfg); err != nil {
		return nil, err
	}
	if cfg.Nonce == "" {
		return nil, fmt.Errorf("%s published no nonce for a paired client", base)
	}
	proof, err := AuthProof(cfg.Nonce, p.SharedSecret)
	if err != nil {
		return nil, err
	}
	wsURL, err := studioURL(base)
	if err != nil {
		return nil, err
	}
	u, err := url.Parse(wsURL)
	if err != nil {
		return nil, err
	}
	q := u.Query()
	q.Set("client", p.ClientID)
	u.RawQuery = q.Encode()
	conn, resp, err := websocket.Dial(ctx, u.String(), nil)
	if err != nil {
		status := 0
		if resp != nil {
			status = resp.StatusCode
		}
		utils.LogWithFields(utils.LevelWarn, logTag, "paired studio connection failed", map[string]any{"url": wsURL, "http_status": status, "error": err.Error()})
		return nil, fmt.Errorf("connect to %s: %w", wsURL, err)
	}
	conn.SetReadLimit(16 << 20)
	s := &Session{conn: conn, secret: p.SharedSecret}
	if err := s.handshake(ctx, pairedHello(p, proof), wsURL); err != nil {
		return nil, err
	}
	return s, nil
}

// SendFile streams a file to the server as FILE_CHUNK frames keyed by
// transferId, then the end marker. The action that registered the transfer
// must already be on the wire.
func (s *Session) SendFile(ctx context.Context, transferID string, r io.Reader) error {
	buf := make([]byte, fileChunkBytes)
	for {
		n, err := io.ReadFull(r, buf)
		if n > 0 {
			if sendErr := s.sendBinary(ctx, binaryFileChunk, transferID, buf[:n]); sendErr != nil {
				return sendErr
			}
		}
		if errors.Is(err, io.EOF) || errors.Is(err, io.ErrUnexpectedEOF) {
			return s.sendBinary(ctx, binaryFileEnd, transferID, nil)
		}
		if err != nil {
			return err
		}
	}
}

// sendBinary writes one binary wire frame:
// [1 byte channel][2 bytes key length, big endian][key][payload].
func (s *Session) sendBinary(ctx context.Context, channel byte, key string, payload []byte) error {
	if len(key) > 0xffff {
		return errors.New("binary frame key too long")
	}
	frame := make([]byte, 0, 3+len(key)+len(payload))
	frame = append(frame, channel, byte(len(key)>>8), byte(len(key)))
	frame = append(frame, key...)
	frame = append(frame, payload...)
	if s.secret == nil {
		return s.conn.Write(ctx, websocket.MessageBinary, frame)
	}
	nonce, ct, err := encrypt(frame, s.secret)
	if err != nil {
		return err
	}
	sealed, err := json.Marshal(envelope{V: RelayEnvelopeVersion, Nonce: nonce, Ciphertext: ct, Bin: true})
	if err != nil {
		return err
	}
	return s.conn.Write(ctx, websocket.MessageText, sealed)
}

// Event is one `studio_event` a server pushed.
type Event struct {
	Channel string          `json:"channel"`
	Payload json.RawMessage `json:"payload"`
}

// StartAction sends a studio action without waiting for its result, so the
// caller can stream a file the action is waiting for. The id it returns is
// what WaitResult takes.
func (s *Session) StartAction(ctx context.Context, action string, args ...any) (string, error) {
	if args == nil {
		args = []any{}
	}
	id := s.nextActionID()
	return id, s.send(ctx, map[string]any{"type": "studio_action", "id": id, "action": action, "args": args})
}

// WaitResult waits for the result of the action StartAction sent. Every
// `studio_event` that arrives first goes to onEvent, when one is given.
func (s *Session) WaitResult(ctx context.Context, action, id string, onEvent func(Event)) (json.RawMessage, error) {
	for {
		raw, err := s.read(ctx)
		if err != nil {
			return nil, fmt.Errorf("waiting for %s: %w", action, err)
		}
		var f frame
		if json.Unmarshal(raw, &f) != nil {
			continue
		}
		if f.Type == "studio_event" && onEvent != nil {
			var e Event
			if json.Unmarshal(raw, &e) == nil {
				onEvent(e)
			}
			continue
		}
		if f.Type != "studio_action_result" || f.ID != id {
			continue
		}
		return f.result(action)
	}
}

// NextEvent waits for the next `studio_event` on channel.
func (s *Session) NextEvent(ctx context.Context, channel string) (Event, error) {
	for {
		raw, err := s.read(ctx)
		if err != nil {
			return Event{}, err
		}
		var f frame
		if json.Unmarshal(raw, &f) != nil || f.Type != "studio_event" {
			continue
		}
		var e Event
		if json.Unmarshal(raw, &e) == nil && e.Channel == channel {
			return e, nil
		}
	}
}

// ActionError is a studio action the server refused or failed. Code is the
// server's stable word for why.
type ActionError struct {
	Action  string
	Code    string
	Message string
	Refused bool
}

func (e *ActionError) Error() string {
	verb := "failed"
	if e.Refused {
		verb = "refused"
	}
	if e.Message == "" {
		return e.Action + " " + verb
	}
	return fmt.Sprintf("%s %s: %s", e.Action, verb, e.Message)
}

func (f frame) result(action string) (json.RawMessage, error) {
	if f.OK {
		return f.Value, nil
	}
	if f.Refusal != nil {
		return nil, &ActionError{Action: action, Code: f.Refusal.Code, Message: f.Refusal.Message, Refused: true}
	}
	if f.Error != nil {
		return nil, &ActionError{Action: action, Code: f.Error.Code, Message: f.Error.Message}
	}
	return nil, &ActionError{Action: action}
}
