/**
 * UsageLimitsGroup — what a server does by itself about provider usage
 * limits: resume a conversation a limit stopped, and treat weekly quota that
 * is about to reset unused as worth spending.
 */
import React from 'react'
import { useSettingsPreferences } from '../../settings-target'
import { FormGroup, FormRow, NumberInput, TextInput, ToggleRow } from '../../kit'

export function UsageLimitsGroup(): React.JSX.Element {
  const autoResume = useSettingsPreferences((s) => s.usageLimitAutoResume)
  const setAutoResume = useSettingsPreferences((s) => s.setUsageLimitAutoResume)
  const prompt = useSettingsPreferences((s) => s.usageLimitResumePrompt)
  const setPrompt = useSettingsPreferences((s) => s.setUsageLimitResumePrompt)
  const hours = useSettingsPreferences((s) => s.quotaExpiryAlertHours)
  const setHours = useSettingsPreferences((s) => s.setQuotaExpiryAlertHours)
  const percent = useSettingsPreferences((s) => s.quotaExpiryUnusedPercent)
  const setPercent = useSettingsPreferences((s) => s.setQuotaExpiryUnusedPercent)

  return (
    <FormGroup title="Usage limits" anchor="usage-limits">
      <ToggleRow
        label="Resume when a usage limit resets" settingKey="usageLimitAutoResume"
        description="When an account's usage limit stops a conversation, the server holds a prompt and sends it once the limit resets, with every app closed. You can also choose this per conversation from its Inbox menu."
        checked={autoResume}
        onChange={setAutoResume}
      />
      <FormRow label="Resume prompt" settingKey="usageLimitResumePrompt" description="What a resume at reset sends.">
        {/* Saved when the field is left, not on every keystroke. */}
        <TextInput key={prompt} aria-label="Resume prompt" defaultValue={prompt} onBlur={(event) => { if (event.target.value !== prompt) setPrompt(event.target.value) }} />
      </FormRow>
      <ToggleRow
        label="Watch for quota that will reset unused" settingKey="quotaExpiryAlertHours"
        description="Rings your phone once when a weekly limit is close to its reset with quota left, and sends prompts you queued for spare quota."
        checked={hours > 0}
        onChange={(enabled) => setHours(enabled ? 12 : 0)}
      />
      {hours > 0 && (
        <>
          <FormRow label="Hours before reset" settingKey="quotaExpiryAlertHours" description="How close to its reset a weekly limit must be.">
            <NumberInput label="Hours before a weekly reset" value={hours} min={1} max={72} onChange={setHours} />
          </FormRow>
          <FormRow label="Percent unused" settingKey="quotaExpiryUnusedPercent" description="How much of the weekly limit must still be unused.">
            <NumberInput label="Percent of the weekly limit unused" value={percent} min={1} max={100} onChange={setPercent} />
          </FormRow>
        </>
      )}
    </FormGroup>
  )
}
