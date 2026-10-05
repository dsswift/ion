package skills

import (
	"context"
	"fmt"
	"regexp"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/dsswift/ion/engine/internal/utils"
)

// Skill shell injection.
//
// A skill body may carry shell commands the engine runs when the skill is
// invoked. The command's output replaces the placeholder, so the model sees
// the data and never the command. Two forms:
//
//	- Inline:  !`git status --short`      (the `!` at line start or after whitespace)
//	- Fenced:  a block opened by a line ```! and closed by a line ```
//
// Substitution is one pass over the body: output is inserted verbatim and is
// never scanned again, so a command cannot inject a further command. Inline
// placeholders inside an ordinary ``` code block are left as written, because
// a skill that documents the syntax would otherwise run its own examples.

// ShellDisabledMarker replaces every placeholder when shell execution is off.
const ShellDisabledMarker = "[shell command execution disabled by policy]"

// DefaultCommandTimeout bounds one injected command.
const DefaultCommandTimeout = 2 * time.Minute

// DefaultOutputBudget caps the characters one command contributes.
const DefaultOutputBudget = 30000

// Invocation names how a skill was reached.
const (
	InvocationTool  = "tool"  // the model called the Skill tool
	InvocationSlash = "slash" // the user typed /<skill>
)

// inlineCmdRE matches !`cmd` preceded by line start or whitespace. The leading
// whitespace is captured so it survives substitution.
var inlineCmdRE = regexp.MustCompile("(^|[ \\t])!`([^`\\n]+)`")

// LoadEvent is what a skill_load observer sees before anything runs.
type LoadEvent struct {
	Name        string
	Source      string
	BaseDir     string
	Args        string
	Invocation  string
	Frontmatter map[string]any
	// Commands are the shell commands the body would run, in order.
	Commands []string
}

// LoadDecision is an observer's answer. A nil Allow abstains.
type LoadDecision struct {
	Allow  *bool
	Reason string
	// Content, when non-empty, replaces the body before rendering. The
	// replacement is scanned for commands like the original.
	Content string
	// AppendContent is added after the rendered body, verbatim.
	AppendContent string
}

// ExecOutcome is the result of one injected command.
type ExecOutcome struct {
	ExitCode int
	// Output is stdout followed by stderr.
	Output   string
	TimedOut bool
}

// RenderInput is everything Render needs. The function fields are injected
// so the skills package stays free of the tool, permission, and extension
// packages; callers adapt their own.
type RenderInput struct {
	Name        string
	Source      string
	BaseDir     string
	Args        string
	Invocation  string
	Frontmatter map[string]any
	// Body is the skill body with arguments already substituted.
	Body string

	// OnLoad fires the skill_load hook. Nil means no observers.
	OnLoad func(LoadEvent) LoadDecision
	// Permit decides whether one command may run. Nil allows everything.
	Permit func(command string) (ok bool, reason string)
	// Exec runs one command in BaseDir. Required when the body has commands
	// and shell execution is enabled.
	Exec func(ctx context.Context, command, cwd string, timeout time.Duration) (ExecOutcome, error)
	// DisableShell replaces every placeholder with ShellDisabledMarker.
	DisableShell bool
	// Timeout and OutputBudget default to DefaultCommandTimeout and
	// DefaultOutputBudget when zero.
	Timeout      time.Duration
	OutputBudget int
}

// RenderError explains why a skill invocation was aborted.
type RenderError struct {
	// Kind is "denied_by_hook", "permission", "command_failed", or
	// "cancelled".
	Kind    string
	Command string
	Message string
}

func (e *RenderError) Error() string { return e.Message }

// segment is one piece of the parsed body: literal text or a command.
type segment struct {
	text    string
	command string
	isCmd   bool
}

// Render runs the skill_load hook, then the body's shell commands, and
// returns the body the model receives.
func Render(ctx context.Context, in RenderInput) (string, error) {
	body := in.Body
	appendContent := ""
	if in.OnLoad != nil {
		decision := in.OnLoad(LoadEvent{
			Name: in.Name, Source: in.Source, BaseDir: in.BaseDir, Args: in.Args,
			Invocation: in.Invocation, Frontmatter: in.Frontmatter, Commands: ExtractCommands(body),
		})
		if decision.Allow != nil && !*decision.Allow {
			reason := decision.Reason
			if reason == "" {
				reason = "blocked by an extension"
			}
			utils.LogWithFields(utils.LevelInfo, "skills.render", "skill blocked by skill_load hook", map[string]any{"skill": in.Name, "reason": reason, "invocation": in.Invocation})
			return "", &RenderError{Kind: "denied_by_hook", Message: fmt.Sprintf("Skill %q was blocked: %s", in.Name, reason)}
		}
		if decision.Content != "" {
			utils.LogWithFields(utils.LevelInfo, "skills.render", "skill body replaced by skill_load hook", map[string]any{"skill": in.Name, "bytes": len(decision.Content)})
			body = decision.Content
		}
		appendContent = decision.AppendContent
	}

	body = expandSkillDir(body, in.BaseDir)
	segments := parseSegments(body)

	var out strings.Builder
	ran := 0
	for _, seg := range segments {
		if !seg.isCmd {
			out.WriteString(seg.text)
			continue
		}
		if in.DisableShell {
			out.WriteString(ShellDisabledMarker)
			continue
		}
		output, err := runCommand(ctx, in, seg.command)
		if err != nil {
			return "", err
		}
		ran++
		out.WriteString(output)
	}
	if appendContent != "" {
		out.WriteString("\n\n" + appendContent)
	}

	utils.LogWithFields(utils.LevelInfo, "skills.render", "skill rendered", map[string]any{
		"skill": in.Name, "invocation": in.Invocation, "commands_run": ran,
		"shell_disabled": in.DisableShell, "bytes": out.Len(),
	})
	return out.String(), nil
}

func runCommand(ctx context.Context, in RenderInput, command string) (string, error) {
	if in.Permit != nil {
		if ok, reason := in.Permit(command); !ok {
			utils.LogWithFields(utils.LevelInfo, "skills.render", "skill command refused by permission policy", map[string]any{"skill": in.Name, "command": command, "reason": reason})
			return "", &RenderError{Kind: "permission", Command: command, Message: fmt.Sprintf("Skill %q command not permitted: %s (%s)", in.Name, command, reason)}
		}
	}
	if err := ctx.Err(); err != nil {
		utils.LogWithFields(utils.LevelInfo, "skills.render", "skill render cancelled before command", map[string]any{"skill": in.Name, "command": command})
		return "", &RenderError{Kind: "cancelled", Command: command, Message: fmt.Sprintf("Skill %q was cancelled", in.Name)}
	}
	if in.Exec == nil {
		return "", &RenderError{Kind: "command_failed", Command: command, Message: fmt.Sprintf("Skill %q has shell commands but no executor is available", in.Name)}
	}
	timeout := in.Timeout
	if timeout <= 0 {
		timeout = DefaultCommandTimeout
	}
	started := time.Now()
	res, err := in.Exec(ctx, command, in.BaseDir, timeout)
	if ctx.Err() != nil {
		utils.LogWithFields(utils.LevelInfo, "skills.render", "skill command cancelled", map[string]any{"skill": in.Name, "command": command})
		return "", &RenderError{Kind: "cancelled", Command: command, Message: fmt.Sprintf("Skill %q was cancelled while running: %s", in.Name, command)}
	}
	if err != nil {
		utils.LogWithFields(utils.LevelWarn, "skills.render", "skill command could not run", map[string]any{"skill": in.Name, "command": command, "error": err})
		return "", &RenderError{Kind: "command_failed", Command: command, Message: fmt.Sprintf("Skill %q command failed to start: %s: %v", in.Name, command, err)}
	}
	if res.TimedOut {
		utils.LogWithFields(utils.LevelWarn, "skills.render", "skill command timed out", map[string]any{"skill": in.Name, "command": command, "timeout_ms": timeout.Milliseconds()})
		return "", &RenderError{Kind: "command_failed", Command: command, Message: fmt.Sprintf("Skill %q command timed out after %s: %s\n%s", in.Name, timeout, command, tail(res.Output, 2000))}
	}
	if res.ExitCode != 0 {
		utils.LogWithFields(utils.LevelWarn, "skills.render", "skill command exited non-zero", map[string]any{"skill": in.Name, "command": command, "exit_code": res.ExitCode})
		return "", &RenderError{Kind: "command_failed", Command: command, Message: fmt.Sprintf("Skill %q command exited %d: %s\n%s", in.Name, res.ExitCode, command, tail(res.Output, 2000))}
	}
	utils.LogWithFields(utils.LevelInfo, "skills.render", "skill command ran", map[string]any{"skill": in.Name, "command": command, "duration_ms": time.Since(started).Milliseconds(), "bytes": len(res.Output)})
	return capOutput(strings.TrimRight(res.Output, "\n"), in.OutputBudget), nil
}

// ExtractCommands lists the shell commands a body would run, in order.
func ExtractCommands(body string) []string {
	var cmds []string
	for _, seg := range parseSegments(body) {
		if seg.isCmd {
			cmds = append(cmds, seg.command)
		}
	}
	return cmds
}

// parseSegments splits a body into literal text and commands in one pass.
func parseSegments(body string) []segment {
	lines := strings.SplitAfter(body, "\n")
	var segs []segment
	var lit strings.Builder
	flushLit := func() {
		if lit.Len() > 0 {
			segs = append(segs, segment{text: lit.String()})
			lit.Reset()
		}
	}
	inPlainFence := false
	for i := 0; i < len(lines); i++ {
		line := lines[i]
		trimmed := strings.TrimSpace(line)
		if !inPlainFence && trimmed == "```!" {
			// Fenced command block: collect until the closing ``` line.
			var cmd []string
			j := i + 1
			for ; j < len(lines) && strings.TrimSpace(lines[j]) != "```"; j++ {
				cmd = append(cmd, strings.TrimRight(lines[j], "\r\n"))
			}
			if j >= len(lines) {
				// Unclosed: not a command block. Keep it literal.
				lit.WriteString(line)
				continue
			}
			flushLit()
			segs = append(segs, segment{isCmd: true, command: strings.Join(cmd, "\n")})
			if strings.HasSuffix(lines[j], "\n") {
				lit.WriteString("\n")
			}
			i = j
			continue
		}
		if strings.HasPrefix(trimmed, "```") {
			inPlainFence = !inPlainFence
			lit.WriteString(line)
			continue
		}
		if inPlainFence {
			lit.WriteString(line)
			continue
		}
		pos := 0
		for _, m := range inlineCmdRE.FindAllStringSubmatchIndex(line, -1) {
			// m[2:4] is the leading whitespace, m[4:6] the command.
			lit.WriteString(line[pos:m[3]])
			flushLit()
			segs = append(segs, segment{isCmd: true, command: line[m[4]:m[5]]})
			pos = m[1]
		}
		lit.WriteString(line[pos:])
	}
	flushLit()
	return segs
}

func capOutput(s string, budget int) string {
	if budget <= 0 {
		budget = DefaultOutputBudget
	}
	if len(s) <= budget {
		return s
	}
	cut := budget
	// Never split a multi-byte character: back up to the start of a rune.
	for cut > 0 && !utf8.RuneStart(s[cut]) {
		cut--
	}
	return s[:cut] + fmt.Sprintf("\n[output truncated: %d of %d characters shown]", cut, len(s))
}

func tail(s string, n int) string {
	if len(s) <= n {
		return s
	}
	start := len(s) - n
	for start < len(s) && !utf8.RuneStart(s[start]) {
		start++
	}
	return "..." + s[start:]
}
