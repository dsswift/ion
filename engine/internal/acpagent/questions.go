package acpagent

import (
	"fmt"
	"strings"

	"github.com/dsswift/ion/engine/internal/utils"
)

// A question the model asks ends its run: the engine records the call as a
// retained denial on the idle status and treats the next prompt as the
// answer. The bridge keeps the client's turn open across that gap. It puts
// the question to the client as a form, sends the answer as the next
// prompt, and the turn ends on the run the answer starts. A client that
// renders no forms gets the question as text and the turn ends; the
// person answers in the prompt box, which is the same next prompt.

// questionToolNames are the engine's question tools, bare; a delegated CLI
// calls them through the MCP bridge prefix bareToolName strips.
var questionToolNames = map[string]bool{"AskUserQuestion": true, "AskUserQuestions": true}

// askedQuestion is one question put to the client.
type askedQuestion struct {
	id       string
	header   string
	question string
	options  []string
}

// questionDenials picks the question tool calls out of an idle status's
// retained denials.
func questionDenials(fields map[string]any) []map[string]any {
	raw, ok := fields["permissionDenials"].([]any)
	if !ok {
		return nil
	}
	var out []map[string]any
	for _, item := range raw {
		d, ok := item.(map[string]any)
		if !ok || !questionToolNames[bareToolName(str(d, "toolName"))] {
			continue
		}
		out = append(out, d)
	}
	return out
}

// askPendingQuestions puts the questions an idle status carries to the
// client, once each, and reports whether the turn now waits on an answer.
func (s *Session) askPendingQuestions(t *turn, fields map[string]any) bool {
	var fresh []map[string]any
	s.mu.Lock()
	for _, d := range questionDenials(fields) {
		id := str(d, "toolUseId")
		if t.answered[id] {
			continue
		}
		if t.answered == nil {
			t.answered = map[string]bool{}
		}
		t.answered[id] = true
		fresh = append(fresh, d)
	}
	var a *ask
	if len(fresh) > 0 {
		a = t.beginAsk()
	}
	s.mu.Unlock()
	if a == nil {
		return false
	}
	go s.runQuestionRound(t, a, parseQuestions(fresh))
	return true
}

// parseQuestions reads the questions out of the denials' tool inputs: one
// per AskUserQuestion call, every entry of an AskUserQuestions batch.
func parseQuestions(denials []map[string]any) []askedQuestion {
	var out []askedQuestion
	for _, d := range denials {
		input, _ := d["toolInput"].(map[string]any) //nolint:errcheck // absent input asks nothing
		id := str(d, "toolUseId")
		if q := str(input, "question"); q != "" {
			out = append(out, askedQuestion{id: id, header: str(input, "header"), question: q, options: optionLabels(input["options"])})
			continue
		}
		batch, _ := input["questions"].([]any) //nolint:errcheck // absent batch asks nothing
		for i, item := range batch {
			q, ok := item.(map[string]any)
			if !ok || str(q, "question") == "" {
				continue
			}
			out = append(out, askedQuestion{id: fmt.Sprintf("%s:%d", id, i), header: str(q, "header"), question: str(q, "question"), options: optionLabels(q["options"])})
		}
	}
	return out
}

// optionLabels reads a question's options, given as strings or as objects
// with a label.
func optionLabels(raw any) []string {
	items, ok := raw.([]any)
	if !ok {
		return nil
	}
	var labels []string
	for _, item := range items {
		switch v := item.(type) {
		case string:
			if v != "" {
				labels = append(labels, v)
			}
		case map[string]any:
			if label := str(v, "label"); label != "" {
				labels = append(labels, label)
			}
		}
	}
	return labels
}

// questionForm is the form schema for a round of questions: one string
// property per question, titled by its header, described by its text, with
// its options as the allowed values.
func questionForm(questions []askedQuestion) map[string]any {
	properties := map[string]any{}
	required := make([]string, 0, len(questions))
	for i, q := range questions {
		key := fmt.Sprintf("q%d", i+1)
		header := q.header
		if header == "" {
			header = "Question"
			if len(questions) > 1 {
				header = fmt.Sprintf("Question %d", i+1)
			}
		}
		field := map[string]any{"type": "string", "title": header, "description": q.question}
		if len(q.options) > 0 {
			field["enum"] = q.options
		}
		properties[key] = field
		required = append(required, key)
	}
	return map[string]any{"type": "object", "properties": properties, "required": required}
}

// runQuestionRound asks the client and feeds the answers back to the
// engine as the turn's next prompt.
func (s *Session) runQuestionRound(t *turn, a *ask, questions []askedQuestion) {
	defer s.endAsk(a)
	if len(questions) == 0 {
		return
	}
	if !s.agent.clientSupportsForms() {
		s.chunk(UpdateAgentMessageChunk, "\n"+questionText(questions))
		utils.LogWithFields(utils.LevelInfo, "acp", "question shown as text; client renders no forms", map[string]any{"session_id": s.id, "questions": len(questions)})
		s.finishTurn(StopEndTurn, nil)
		return
	}
	answer, ok := s.askForm(questions[0].question, questionForm(questions))
	if !ok || answer.Action != "accept" {
		utils.LogWithFields(utils.LevelInfo, "acp", "question not answered; turn ends", map[string]any{"session_id": s.id, "answered": ok, "action": answer.Action})
		s.chunk(UpdateAgentMessageChunk, "\n"+questionText(questions))
		s.finishTurn(StopEndTurn, nil)
		return
	}
	text := answerText(questions, answer.Content)
	utils.LogWithFields(utils.LevelInfo, "acp", "question answered", map[string]any{"session_id": s.id, "questions": len(questions), "chars": len(text)})
	s.continueTurn(t, a, text, "structured_answer")
}

// answerText renders the client's answers as the prompt the engine treats
// as the reply: the bare answer to one question, a list for several.
func answerText(questions []askedQuestion, content map[string]any) string {
	answers := make([]string, 0, len(questions))
	for i, q := range questions {
		value := answerValue(content[fmt.Sprintf("q%d", i+1)])
		if value == "" {
			value = "(no answer)"
		}
		if len(questions) == 1 {
			return value
		}
		answers = append(answers, "Q: "+q.question+"\nA: "+value)
	}
	return strings.Join(answers, "\n\n")
}

func answerValue(v any) string {
	switch value := v.(type) {
	case string:
		return strings.TrimSpace(value)
	case []any:
		parts := make([]string, 0, len(value))
		for _, item := range value {
			if s, ok := item.(string); ok && s != "" {
				parts = append(parts, s)
			}
		}
		return strings.Join(parts, ", ")
	case bool:
		if value {
			return "yes"
		}
		return "no"
	case float64:
		return fmt.Sprintf("%g", value)
	}
	return ""
}

// questionText renders questions as prose for a client without forms.
func questionText(questions []askedQuestion) string {
	var b strings.Builder
	for _, q := range questions {
		b.WriteString(q.question)
		if len(q.options) > 0 {
			b.WriteString(" (" + strings.Join(q.options, " / ") + ")")
		}
		b.WriteString("\n")
	}
	return b.String()
}
