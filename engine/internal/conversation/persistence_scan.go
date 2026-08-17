package conversation

import (
	"bufio"
	"strings"
)

// scanNonEmptyLines splits JSONL bytes into non-empty trimmed lines using a
// buffered scanner with a 32 MB per-line limit (maxScanTokenSize).
func scanNonEmptyLines(data []byte) ([]string, error) {
	scanner := bufio.NewScanner(strings.NewReader(string(data)))
	scanner.Buffer(make([]byte, 0, 64*1024), maxScanTokenSize)
	var lines []string
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line != "" {
			lines = append(lines, line)
		}
	}
	if err := scanner.Err(); err != nil {
		return nil, err
	}
	return lines, nil
}
