/**
 * The launch argument that asks a running Ion to quit by force: the SIGUSR2
 * forced quit, for Windows, which has no signals. A remote deploy launches
 * `Ion.exe --ion-force-quit` in the operator's session; the single-instance
 * lock hands the argv to the running Ion, which quits, and the new process
 * exits. With no Ion running, the launch exits without starting anything.
 */
export const FORCE_QUIT_ARG = '--ion-force-quit'
