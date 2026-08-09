//go:build windows

package auth

import (
	"context"
	"os/exec"
)

func configureCredentialProcess(_ *exec.Cmd) {}

func runCredentialProcess(ctx context.Context, cmd *exec.Cmd) error {
	if err := cmd.Start(); err != nil {
		return err
	}
	done := make(chan error, 1)
	go func() { done <- cmd.Wait() }()
	select {
	case err := <-done:
		return err
	case <-ctx.Done():
		if cmd.Process != nil {
			if killErr := cmd.Process.Kill(); killErr != nil {
				<-done
				return killErr
			}
		}
		<-done
		return ctx.Err()
	}
}
