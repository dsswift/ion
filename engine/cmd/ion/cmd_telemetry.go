package main

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"time"

	"github.com/dsswift/ion/engine/internal/telemetryformat"
	"github.com/dsswift/ion/engine/internal/telemetryforwarder"
)

func cmdTelemetry(positional []string, flags map[string]string) {
	if len(positional) == 0 {
		telemetryUsage()
		return
	}
	switch positional[0] {
	case "expand":
		if len(positional) != 2 {
			telemetryUsage()
			return
		}
		if err := expandTelemetry(positional[1], os.Stdout); err != nil {
			fmt.Fprintf(os.Stderr, "telemetry expand: %v\n", err)
			os.Exit(1)
		}
	case "forward":
		if len(positional) != 1 {
			telemetryUsage()
			return
		}
		config := telemetryforwarder.Config{
			File:     valueOrDefault(flags["file"], telemetryforwarder.DefaultFile),
			Cursor:   valueOrDefault(flags["cursor"], telemetryforwarder.DefaultCursor),
			Endpoint: valueOrDefault(flags["endpoint"], telemetryforwarder.DefaultEndpoint),
		}
		forwarder, err := telemetryforwarder.New(config)
		if err != nil {
			fmt.Fprintf(os.Stderr, "telemetry forward: %v\n", err)
			os.Exit(1)
		}
		defer func() { _ = forwarder.Close() }() //nolint:errcheck // read-only telemetry file close
		if err := forwarder.Run(context.Background(), time.Second); err != nil && !errors.Is(err, context.Canceled) {
			fmt.Fprintf(os.Stderr, "telemetry forward: %v\n", err)
			os.Exit(1)
		}
	default:
		telemetryUsage()
	}
}

func expandTelemetry(path string, output io.Writer) error {
	input := io.Reader(os.Stdin)
	var closeInput func() error
	if path != "-" {
		file, err := os.Open(path)
		if err != nil {
			return err
		}
		input = file
		closeInput = file.Close
	}
	if closeInput != nil {
		defer func() { _ = closeInput() }() //nolint:errcheck // input is read to completion
	}
	scanner := bufio.NewScanner(input)
	buffer := make([]byte, 64*1024)
	scanner.Buffer(buffer, 8*1024*1024)
	lineNumber := 0
	for scanner.Scan() {
		lineNumber++
		events, err := telemetryformat.DecodeLine(scanner.Bytes())
		if err != nil {
			return fmt.Errorf("line %d: %w", lineNumber, err)
		}
		for _, event := range events {
			line, err := telemetryformat.EncodeEventLine(event)
			if err != nil {
				return fmt.Errorf("line %d: encode expanded event: %w", lineNumber, err)
			}
			if _, err := output.Write(line); err != nil {
				return err
			}
		}
	}
	if err := scanner.Err(); err != nil {
		return err
	}
	return nil
}

func telemetryUsage() {
	fmt.Fprintln(os.Stderr, "Usage: ion telemetry expand [FILE|-]")
	fmt.Fprintln(os.Stderr, "       ion telemetry forward [--file FILE] [--cursor FILE] [--endpoint URL]")
}

func valueOrDefault(value, fallback string) string {
	if value != "" {
		return value
	}
	return fallback
}
