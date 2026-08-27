/**
 * AskUserQuestions — the desktop's guided-questions client-tool declaration.
 *
 * Declared on every desktop engine session through toolGateSessionConfig()
 * (the universal main-owned start_session seam), never registered in the
 * engine's built-in tool set: the tool exists exactly when a client that can
 * render the wizard owns the session. humanWait PARKS the run on invocation:
 * the engine records the request as a retained denial, terminates the run,
 * and the session goes idle — the user answers at their own pace (across
 * stop, navigation, and restarts) and the answers resume the conversation as
 * the next prompt. planModeSafe keeps it callable during planning, which is
 * its primary habitat.
 */
import type { ClientToolDef } from '../../shared/types-tool-gate'

/**
 * Reusable harness guidance: when the model should reach for the wizard vs
 * the single-question fallback. Referenced by the tool description here and
 * by the system-prompt addenda (prompt-pipeline) so the policy is stated
 * once. Kept as one constant so remote bounce-back idempotency checks can
 * match it exactly.
 */
export const ASK_USER_QUESTIONS_GUIDANCE =
  'Prefer AskUserQuestions whenever two or more related questions can be anticipated — planning, design, requirements, discovery, and tradeoff reviews are the primary cases. Batch the round into one page instead of asking serially. Reserve AskUserQuestion for a single isolated decision.'

/**
 * JSON schema for the QuestionsRequest input (shared/questions-schema.ts is
 * the authoritative TS shape; this is its JSON-Schema projection for the
 * provider tool declaration).
 */
const INPUT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  required: ['title', 'questions'],
  properties: {
    title: {
      type: 'string',
      minLength: 1,
      description: 'Short page title shown as the wizard heading.',
    },
    description: {
      type: 'string',
      description: 'Optional context for the page, such as the evidence summary motivating this round.',
    },
    workflowId: {
      type: 'string',
      minLength: 1,
      description:
        'Continuation id. Omit on the first call. When a previous result carried requestMore: true, call again with the workflowId from that result to continue the same round; answers accumulate under it.',
    },
    questions: {
      type: 'array',
      minItems: 1,
      description: "The page's questions, ordered.",
      items: {
        type: 'object',
        required: ['id', 'prompt', 'mode'],
        properties: {
          id: { type: 'string', minLength: 1, description: 'Stable id, unique within the request.' },
          prompt: { type: 'string', minLength: 1, description: 'The question.' },
          guidance: { type: 'string', description: 'Optional longer guidance rendered under the prompt.' },
          mode: {
            type: 'string',
            enum: ['single', 'multiple', 'text'],
            description:
              "'single' = choose one option; 'multiple' = choose any; 'text' = pure free-form answer with no options.",
          },
          display: {
            type: 'string',
            enum: ['radio', 'checkbox', 'pills'],
            description:
              "Optional rendering hint ('radio'/'pills' for single, 'checkbox'/'pills' for multiple). Omit to let the client pick: pills for >5 undescribed options, else radio/checkbox. Rendering only — never changes the answer shape.",
          },
          options: {
            type: 'array',
            minItems: 1,
            description: "Labeled options for single/multiple modes. Do NOT add an 'Other' option — the client always renders a free-text 'Other' alongside the options.",
            items: {
              type: 'object',
              required: ['id', 'label'],
              properties: {
                id: { type: 'string', minLength: 1 },
                label: { type: 'string', minLength: 1 },
                description: { type: 'string', description: 'Optional per-option trade-off/explanation.' },
              },
            },
          },
        },
      },
    },
  },
}

export const ASK_USER_QUESTIONS_TOOL: ClientToolDef = {
  name: 'AskUserQuestions',
  description:
    'Present a structured page of questions to the user and wait for their answers. ' +
    ASK_USER_QUESTIONS_GUIDANCE +
    ' Calling this tool ENDS the current run: the questions are handed to the user and the user\'s answers arrive as their next message, which carries every answer with selected option labels, free-form text, explicit skips ("Agent decides"), an optional page comment, and possibly a request for more questions. When the user asks for more questions you MUST call AskUserQuestions again with the workflowId their message names — the user, not you, decides when a topic is exhausted. This call must be the LAST thing you do in a turn: it is a handoff, not one step among several, so any other tool call you make in the same turn is refused unexecuted. The user is never obliged to answer — they may reply with an ordinary message instead, which dismisses the panel. That is not an error and not a refusal: read what they actually sent, do what it asks, and afterwards decide for yourself whether you still need an answer. If you do, ask again (the same questions or better ones); if their message already told you what you needed, carry on without asking.',
  inputSchema: INPUT_SCHEMA,
  planModeSafe: true,
  humanWait: true,
}
