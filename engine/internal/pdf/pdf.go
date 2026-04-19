// Package pdf provides PDF validation, encoding, and page extraction utilities.
package pdf

import (
	"encoding/base64"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
)

// ValidatePdf checks if a file is a valid PDF by reading its magic bytes.
func ValidatePdf(path string) error {
	f, err := os.Open(path)
	if err != nil {
		return fmt.Errorf("cannot open PDF: %w", err)
	}
	defer f.Close()

	header := make([]byte, 5)
	n, err := f.Read(header)
	if err != nil || n < 5 {
		return fmt.Errorf("cannot read PDF header")
	}
	if string(header) != "%PDF-" {
		return fmt.Errorf("not a valid PDF file (missing %%PDF- header)")
	}
	return nil
}

// EncodePdf reads a PDF file and returns its base64-encoded content.
func EncodePdf(path string) (string, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return "", fmt.Errorf("cannot read PDF: %w", err)
	}
	return base64.StdEncoding.EncodeToString(data), nil
}

// ExtractPdfPages extracts specific pages from a PDF using pdftoppm.
// Returns base64-encoded PNG images for each page.
// pageRange is "1-5" or "3" format.
func ExtractPdfPages(path string, pageRange string) ([]string, error) {
	if err := ValidatePdf(path); err != nil {
		return nil, err
	}

	// Check pdftoppm availability
	pdftoppm, err := exec.LookPath("pdftoppm")
	if err != nil {
		return nil, fmt.Errorf("pdftoppm not found: install poppler-utils")
	}

	// Parse page range
	var firstPage, lastPage int
	if strings.Contains(pageRange, "-") {
		parts := strings.SplitN(pageRange, "-", 2)
		firstPage, _ = strconv.Atoi(parts[0])
		lastPage, _ = strconv.Atoi(parts[1])
	} else {
		firstPage, _ = strconv.Atoi(pageRange)
		lastPage = firstPage
	}

	if firstPage <= 0 {
		firstPage = 1
	}
	if lastPage <= 0 {
		lastPage = firstPage
	}

	// Max 20 pages per request
	if lastPage-firstPage+1 > 20 {
		lastPage = firstPage + 19
	}

	// Create temp dir for output
	tmpDir, err := os.MkdirTemp("", "ion-pdf-*")
	if err != nil {
		return nil, fmt.Errorf("cannot create temp dir: %w", err)
	}
	defer os.RemoveAll(tmpDir)

	outPrefix := filepath.Join(tmpDir, "page")

	// Run pdftoppm
	args := []string{
		"-png",
		"-f", strconv.Itoa(firstPage),
		"-l", strconv.Itoa(lastPage),
		"-r", "150", // DPI
		path,
		outPrefix,
	}

	cmd := exec.Command(pdftoppm, args...)
	if output, err := cmd.CombinedOutput(); err != nil {
		return nil, fmt.Errorf("pdftoppm failed: %s: %s", err, string(output))
	}

	// Read generated PNG files
	var pages []string
	for p := firstPage; p <= lastPage; p++ {
		// pdftoppm names files as page-01.png, page-02.png, etc.
		patterns := []string{
			filepath.Join(tmpDir, fmt.Sprintf("page-%d.png", p)),
			filepath.Join(tmpDir, fmt.Sprintf("page-%02d.png", p)),
			filepath.Join(tmpDir, fmt.Sprintf("page-%03d.png", p)),
		}

		var data []byte
		for _, pat := range patterns {
			if d, err := os.ReadFile(pat); err == nil {
				data = d
				break
			}
		}
		if data != nil {
			pages = append(pages, base64.StdEncoding.EncodeToString(data))
		}
	}

	return pages, nil
}
