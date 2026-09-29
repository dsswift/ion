import { describe, it, expect } from 'vitest'
import {
  thinkingOptionsForMode,
  defaultEffortForMode,
  isEffortValidForMode,
  resolveEffortForModel,
  thinkingEffortLabel,
  isThinkingEffort,
  THINKING_EFFORT_VALUES,
} from '../thinking-options'

/**
 * thinking-options — the per-model thinking menu.
 *
 * The rule these tests pin: an ADAPTIVE model (Anthropic) reasons on its own
 * whether or not the client asks, so "Off" would misrepresent it. Its neutral
 * choice is `Adaptive`, meaning "reason, but pick your own depth". An
 * effort-based model (reasoning_effort / gemini / budget) has no
 * self-regulation to defer to, so `Off` is real and meaningful there.
 *
 * Why it matters beyond labelling: pinning an explicit effort on an adaptive
 * model emits output_config and overrides the model's per-turn judgment on
 * EVERY turn. With a default of "high" that produced multi-minute thinking
 * streams on trivial prompts. `Adaptive` is what lets the default request
 * reasoning without pinning depth.
 *
 * Revert proof: returning a fixed off/low/medium/high list regardless of mode
 * fails the adaptive cases.
 */
describe('thinkingOptionsForMode', () => {
  const all = ['low', 'medium', 'high']

  it('leads with Adaptive for an adaptive model, never Off', () => {
    const opts = thinkingOptionsForMode('adaptive', all)
    expect(opts[0]).toEqual({ value: 'adaptive', label: 'Adaptive' })
    expect(opts.map((o) => o.value)).not.toContain('off')
  })

  it('leads with Off for an effort-based model, never Adaptive', () => {
    for (const mode of ['reasoning_effort', 'gemini', 'budget']) {
      const opts = thinkingOptionsForMode(mode, all)
      expect(opts[0]).toEqual({ value: 'off', label: 'Off' })
      expect(opts.map((o) => o.value)).not.toContain('adaptive')
    }
  })

  it('offers the explicit levels on an adaptive model too (pinning stays available)', () => {
    const values = thinkingOptionsForMode('adaptive', all).map((o) => o.value)
    expect(values).toEqual(['adaptive', 'low', 'medium', 'high'])
  })

  // A model may advertise a subset — grok-mini supports low/high but not
  // medium. Offering an unadvertised level yields a control that silently does
  // nothing, because the engine rejects an effort outside the model's list.
  it('omits levels the model does not advertise', () => {
    const values = thinkingOptionsForMode('reasoning_effort', ['low', 'high']).map((o) => o.value)
    expect(values).toEqual(['off', 'low', 'high'])
    expect(values).not.toContain('medium')
  })

  it('falls back to Off-only when the model advertises no efforts', () => {
    expect(thinkingOptionsForMode(undefined, []).map((o) => o.value)).toEqual(['off'])
  })

  it('an adaptive model with no advertised levels still offers Adaptive', () => {
    expect(thinkingOptionsForMode('adaptive', []).map((o) => o.value)).toEqual(['adaptive'])
  })
})

describe('defaultEffortForMode', () => {
  it('defaults an adaptive model to adaptive, ignoring the configured level', () => {
    expect(defaultEffortForMode('adaptive', 'high')).toBe('adaptive')
    expect(defaultEffortForMode('adaptive', 'low')).toBe('adaptive')
  })

  it('uses the configured default for effort-based models', () => {
    expect(defaultEffortForMode('reasoning_effort', 'high')).toBe('high')
    expect(defaultEffortForMode('gemini', 'medium')).toBe('medium')
    expect(defaultEffortForMode('budget', 'low')).toBe('low')
  })

  it('uses the configured default when the mode is unknown', () => {
    expect(defaultEffortForMode(undefined, 'high')).toBe('high')
    expect(defaultEffortForMode('', 'high')).toBe('high')
  })
})

describe('isEffortValidForMode', () => {
  const all = ['low', 'medium', 'high']

  // The repair case: an instance holding 'adaptive' after the conversation's
  // model changes to an effort-based one. The engine would reject 'adaptive'
  // as an unadvertised effort, so the client must detect and correct it.
  it("rejects 'adaptive' on an effort-based model", () => {
    expect(isEffortValidForMode('adaptive', 'reasoning_effort', all)).toBe(false)
  })

  it("rejects 'off' on an adaptive model", () => {
    expect(isEffortValidForMode('off', 'adaptive', all)).toBe(false)
  })

  it('accepts each mode its own neutral value', () => {
    expect(isEffortValidForMode('adaptive', 'adaptive', all)).toBe(true)
    expect(isEffortValidForMode('off', 'reasoning_effort', all)).toBe(true)
  })

  it('rejects a level the model does not advertise', () => {
    expect(isEffortValidForMode('medium', 'reasoning_effort', ['low', 'high'])).toBe(false)
    expect(isEffortValidForMode('high', 'reasoning_effort', ['low', 'high'])).toBe(true)
  })
})

/**
 * resolveEffortForModel — repairs a stale stored effort against the model in use.
 *
 * The reported symptom was cosmetic: the status bar rendered a PURPLE "Think:
 * Off" on gpt-5.6-terra. Label and color disagreed because they read different
 * things — the label fell back to the model's first option ("Off") while the
 * active color asked `effort !== 'off'`, which is true for a stored 'adaptive'.
 *
 * The real defect was underneath. The stored 'adaptive' was sent to the engine
 * verbatim, which maps it to {Enabled:true, Effort:""} → resolveThinking yields
 * reasoning_effort with an empty effort → the directive is DROPPED. So an
 * effort-based model, where the level is the only way to get reasoning at all,
 * silently got none while the UI implied thinking was engaged.
 *
 * Revert proof: removing the repair returns 'adaptive' for the first case,
 * which is both the wrong label and the silent-no-reasoning wire value.
 */
describe('resolveEffortForModel', () => {
  const all = ['low', 'medium', 'high']

  it("repairs 'adaptive' to 'off' on an effort-based model (the reported bug)", () => {
    expect(resolveEffortForModel('adaptive', 'reasoning_effort', all)).toBe('off')
  })

  it("repairs 'off' to 'adaptive' on an adaptive model", () => {
    expect(resolveEffortForModel('off', 'adaptive', all)).toBe('adaptive')
  })

  it('leaves a valid stored value alone', () => {
    expect(resolveEffortForModel('adaptive', 'adaptive', all)).toBe('adaptive')
    expect(resolveEffortForModel('off', 'reasoning_effort', all)).toBe('off')
    expect(resolveEffortForModel('high', 'reasoning_effort', all)).toBe('high')
    expect(resolveEffortForModel('high', 'adaptive', all)).toBe('high')
  })

  it('repairs a level the model does not advertise to its neutral entry', () => {
    expect(resolveEffortForModel('medium', 'reasoning_effort', ['low', 'high'])).toBe('off')
  })

  it('is idempotent — repairing twice changes nothing', () => {
    const once = resolveEffortForModel('adaptive', 'reasoning_effort', all)
    expect(resolveEffortForModel(once, 'reasoning_effort', all)).toBe(once)
  })

  // Model metadata arrives asynchronously. Repairing against an unknown
  // model's empty effort list would discard a valid stored level and silently
  // disable thinking for any prompt sent before the registry populates, so an
  // unknown model leaves the stored value untouched.
  it('leaves the stored value alone when the model is unknown', () => {
    expect(resolveEffortForModel('high', undefined, [])).toBe('high')
    expect(resolveEffortForModel('adaptive', undefined, [])).toBe('adaptive')
    expect(resolveEffortForModel('off', undefined, [])).toBe('off')
  })
})

/**
 * Extended rungs (xhigh, max).
 *
 * A gateway can advertise levels above "high"; the client must offer exactly
 * what each model declares and no more. The engine rejects an effort outside a
 * model's `thinkingEfforts`, so offering an unadvertised rung renders a control
 * that silently does nothing.
 */
describe('extended effort levels', () => {
  it('offers xhigh and max when the model advertises them', () => {
    const values = thinkingOptionsForMode('reasoning_effort', ['low', 'medium', 'high', 'xhigh']).map((o) => o.value)
    expect(values).toEqual(['off', 'low', 'medium', 'high', 'xhigh'])
  })

  it('offers the full ladder on an adaptive model that advertises it', () => {
    const values = thinkingOptionsForMode('adaptive', ['low', 'medium', 'high', 'xhigh', 'max']).map((o) => o.value)
    expect(values).toEqual(['adaptive', 'low', 'medium', 'high', 'xhigh', 'max'])
  })

  it('omits extended rungs a model does not advertise', () => {
    const values = thinkingOptionsForMode('reasoning_effort', ['low', 'medium', 'high']).map((o) => o.value)
    expect(values).not.toContain('xhigh')
    expect(values).not.toContain('max')
  })

  it('keeps a stored extended level when the model advertises it', () => {
    expect(resolveEffortForModel('max', 'adaptive', ['low', 'high', 'max'])).toBe('max')
  })

  it('repairs a stored extended level the model dropped', () => {
    expect(resolveEffortForModel('max', 'reasoning_effort', ['low', 'medium', 'high'])).toBe('off')
  })

  // Plain capitalization would render "Xhigh".
  it('labels xhigh as "Extra High" rather than capitalizing', () => {
    expect(thinkingEffortLabel('xhigh')).toBe('Extra High')
    expect(thinkingEffortLabel('max')).toBe('Max')
    expect(thinkingEffortLabel('adaptive')).toBe('Adaptive')
  })

  it('labels every value in the ladder', () => {
    for (const v of THINKING_EFFORT_VALUES) {
      expect(thinkingEffortLabel(v)).toBeTruthy()
    }
  })
})

/**
 * isThinkingEffort — the single runtime guard.
 *
 * Validators were previously inline lists, and one of them silently rejected
 * 'adaptive' after it was added to the type: the iOS set-effort command was
 * dropped with only a log line. Deriving validation from the shared ladder is
 * what stops a validator falling behind the union again.
 */
describe('isThinkingEffort', () => {
  it('accepts every value in the ladder', () => {
    for (const v of THINKING_EFFORT_VALUES) {
      expect(isThinkingEffort(v)).toBe(true)
    }
  })

  it("accepts 'adaptive' (the value an inline validator dropped)", () => {
    expect(isThinkingEffort('adaptive')).toBe(true)
  })

  it('accepts the extended rungs', () => {
    expect(isThinkingEffort('xhigh')).toBe(true)
    expect(isThinkingEffort('max')).toBe(true)
  })

  it('rejects unknown values and non-strings', () => {
    for (const v of ['', 'HIGH', 'higher', 'none', null, undefined, 3, {}]) {
      expect(isThinkingEffort(v)).toBe(false)
    }
  })
})
