//go:build !unix

package ion

import (
	"errors"
	"os"
	"os/exec"
)

// execEngine runs argv with this process's stdio and returns its exit code:
// a platform without exec(2) keeps this process as a pass-through parent.
func execEngine(argv []string) (int, error) {
	cmd := exec.Command(argv[0], argv[1:]...)
	cmd.Stdin, cmd.Stdout, cmd.Stderr = os.Stdin, os.Stdout, os.Stderr
	err := cmd.Run()
	var exit *exec.ExitError
	if errors.As(err, &exit) {
		return exit.ExitCode(), nil
	}
	if err != nil {
		return 0, err
	}
	return 0, nil
}
