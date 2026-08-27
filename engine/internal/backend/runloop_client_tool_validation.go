package backend

import (
	"encoding/json"
	"fmt"

	"github.com/google/jsonschema-go/jsonschema"

	"github.com/dsswift/ion/engine/internal/conversation"
	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

const clientToolValidationDiagnosticLimit = 200

// CompileClientToolInputValidator prepares one client-declared JSON Schema for
// repeated calls. A malformed declaration produces a validator that rejects
// calls with a normal tool error instead of letting invalid input reach the
// client. An empty schema accepts every JSON object.
func CompileClientToolInputValidator(schemaMap map[string]any) func(map[string]interface{}) error {
	if len(schemaMap) == 0 {
		resolved, err := (&jsonschema.Schema{}).Resolve(nil)
		if err != nil {
			return clientToolSchemaErrorValidator(err)
		}
		return func(input map[string]interface{}) error { return resolved.Validate(input) }
	}
	data, err := json.Marshal(schemaMap)
	if err != nil {
		return clientToolSchemaErrorValidator(err)
	}
	var schema jsonschema.Schema
	if err := json.Unmarshal(data, &schema); err != nil {
		return clientToolSchemaErrorValidator(err)
	}
	resolved, err := schema.Resolve(nil)
	if err != nil {
		return clientToolSchemaErrorValidator(err)
	}
	return func(input map[string]interface{}) error { return resolved.Validate(input) }
}

func clientToolSchemaErrorValidator(err error) func(map[string]interface{}) error {
	diagnostic := boundedClientToolValidationDiagnostic(err)
	return func(map[string]interface{}) error {
		return fmt.Errorf("client tool declaration has an invalid input schema: %s", diagnostic)
	}
}

func boundedClientToolValidationDiagnostic(err error) string {
	if err == nil {
		return ""
	}
	return truncatePreview(err.Error(), clientToolValidationDiagnosticLimit)
}

// validateClientToolCall rejects invalid client-tool input before the call can
// reach client routing or human-wait parking. Non-client tools have no entry
// and pass through unchanged.
func (b *ApiBackend) validateClientToolCall(
	run *activeRun,
	block types.LlmContentBlock,
	results []conversation.ToolResultEntry,
	i int,
) bool {
	if run.cfg == nil {
		return false
	}
	validate := run.cfg.ClientToolInputValidators[block.Name]
	if validate == nil {
		return false
	}
	if err := validate(block.Input); err != nil {
		diagnostic := boundedClientToolValidationDiagnostic(err)
		content := fmt.Sprintf("Invalid input for client tool %q: %s", block.Name, diagnostic)
		utils.LogWithFields(utils.LevelWarn, "backend.runloop", "client tool input validation failed", map[string]any{
			"run_id": run.requestID,
			"tool":   block.Name,
			"error":  diagnostic,
		})
		results[i] = conversation.ToolResultEntry{ToolUseID: block.ID, Content: content, IsError: true}
		emitToolFailure(run.cfg.Telemetry, run, toolFailureBlock{Name: block.Name, ID: block.ID}, "input_validation", diagnostic)
		b.emit(run, types.NormalizedEvent{Data: &types.ToolResultEvent{
			ToolID: block.ID, Content: content, IsError: true,
		}})
		return true
	}
	return false
}

func clientToolCallIsValid(run *activeRun, block types.LlmContentBlock) bool {
	if run.cfg == nil {
		return true
	}
	validate := run.cfg.ClientToolInputValidators[block.Name]
	return validate == nil || validate(block.Input) == nil
}
