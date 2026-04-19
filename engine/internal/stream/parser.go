package stream

import (
	"bufio"
	"encoding/json"
	"io"
)

// Parser reads NDJSON from a reader and emits parsed JSON objects one at a time.
// Each line is expected to be a standalone JSON value. Empty lines are skipped.
// Lines that fail to parse are silently skipped (matching the TS behavior of
// emitting a parse-error event without crashing).
type Parser struct {
	scanner *bufio.Scanner
	err     error
}

// NewParser creates a Parser that reads NDJSON lines from r.
func NewParser(r io.Reader) *Parser {
	return &Parser{scanner: bufio.NewScanner(r)}
}

// Next returns the next parsed JSON line as a json.RawMessage.
// Returns (nil, false) at EOF or on scanner error.
// Non-JSON lines are skipped.
func (p *Parser) Next() (json.RawMessage, bool) {
	for p.scanner.Scan() {
		line := p.scanner.Bytes()
		// Skip empty / whitespace-only lines
		trimmed := trimSpace(line)
		if len(trimmed) == 0 {
			continue
		}
		// Validate JSON before returning
		if !json.Valid(trimmed) {
			continue
		}
		// Return a copy so the caller owns the bytes
		out := make(json.RawMessage, len(trimmed))
		copy(out, trimmed)
		return out, true
	}
	p.err = p.scanner.Err()
	return nil, false
}

// Err returns the first non-EOF error encountered by the scanner.
func (p *Parser) Err() error {
	return p.err
}

// trimSpace trims leading and trailing ASCII whitespace bytes.
func trimSpace(b []byte) []byte {
	start := 0
	for start < len(b) && isSpace(b[start]) {
		start++
	}
	end := len(b)
	for end > start && isSpace(b[end-1]) {
		end--
	}
	return b[start:end]
}

func isSpace(c byte) bool {
	return c == ' ' || c == '\t' || c == '\r' || c == '\n'
}
