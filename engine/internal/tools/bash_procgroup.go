// Package tools: process-group configuration shared across platforms.
//
// The unix and windows implementations both delegate to
// engine/internal/procctl, which owns the actual mechanism (process groups
// on unix, Job Objects on windows). This file exists only so the shared doc
// comment lives in one place instead of being duplicated across the two
// build-tagged files.
package tools
