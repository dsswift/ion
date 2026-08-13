package utils

import "unicode/utf8"

// FirstLineUTF8 returns the first line of value, bounded without splitting a
// UTF-8 rune. Empty and short strings pass through unchanged.
func FirstLineUTF8(value string, maxBytes int) string {
	for i, r := range value {
		if r == '\n' || r == '\r' {
			value = value[:i]
			break
		}
	}
	if maxBytes < 0 || len(value) <= maxBytes {
		return value
	}
	cut := value[:maxBytes]
	for len(cut) > 0 {
		r, size := utf8.DecodeLastRuneInString(cut)
		if r != utf8.RuneError || size > 1 {
			break
		}
		cut = cut[:len(cut)-1]
	}
	return cut
}
