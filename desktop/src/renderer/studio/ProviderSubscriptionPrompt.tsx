/**
 * ProviderSubscriptionPrompt — the Provider Subscription Prompt: tells the
 * operator, outside Settings, that an environment's subscription lookup needs
 * them. With several subscriptions and none chosen it lists them by label and
 * applies the one picked. With no subscription it says so and offers to look
 * up again. Dismissing hides it until the environment enters the state again;
 * the Settings control is unchanged.
 */
import React, { useCallback, useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { motion } from 'framer-motion'
import { ArrowClockwise } from '@phosphor-icons/react'
import { LOCAL_ENVIRONMENT_ID } from '@ion/shared/types-environments'
import type { SubscriptionOption } from '@ion/shared/types-engine-event'
import { subscriptionFailureText, subscriptionProviderName, type ProviderSubscriptionResult } from '@ion/shared/provider-subscription'
import { usePopoverLayer } from '../components/PopoverLayer'
import { useColors } from '../theme'
import { transitions } from '../theme-tokens'
import { useInteractiveState, interactiveBg } from '../hooks/useInteractiveState'
import { action } from '../host/host-instance'
import { rError, rInfo, rWarn } from '../rendererLogger'
import { subscriptionAttentionStore, useSubscriptionPrompt, type SubscriptionPrompt } from './connection/provider-subscription-attention'
import { useEnvironmentLabel } from './transfer/environment-label-cache'

export function ProviderSubscriptionPrompt(): React.JSX.Element | null {
  const popoverLayer = usePopoverLayer()
  const prompt = useSubscriptionPrompt()

  useEffect(() => subscriptionAttentionStore.start(), [])

  if (!popoverLayer || !prompt) return null
  return createPortal(
    <PromptDialog key={`${prompt.environmentId}:${prompt.attention.state}`} prompt={prompt} />,
    popoverLayer,
  )
}

function PromptDialog({ prompt }: { prompt: SubscriptionPrompt }): React.JSX.Element {
  const colors = useColors()
  const { environmentId, attention } = prompt
  const { status } = attention
  const choosing = attention.state === 'selection_required'
  const name = subscriptionProviderName(status)
  const serverLabel = useEnvironmentLabel(environmentId === LOCAL_ENVIRONMENT_ID ? null : environmentId)
  const [choice, setChoice] = useState('')
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  const [failure, setFailure] = useState<string | null>(null)

  useEffect(() => {
    rInfo('subscription-prompt', 'prompt shown', { environment_id: environmentId, state: attention.state })
  }, [environmentId, attention.state])

  const dismiss = useCallback(() => subscriptionAttentionStore.dismiss(environmentId), [environmentId])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      dismiss()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [dismiss])

  const run = async (verb: 'select' | 'refresh', actionName: string, args: unknown[]): Promise<void> => {
    setBusy(true)
    setFailure(null)
    setNote(null)
    try {
      const result = await action(environmentId, actionName, args) as ProviderSubscriptionResult
      if (!result.ok) {
        rWarn('subscription-prompt', 'action refused', { environment_id: environmentId, action: verb, error: result.error ?? '' })
        setFailure(result.error ?? `Could not ${verb} the subscription.`)
      } else {
        rInfo('subscription-prompt', 'action settled', { environment_id: environmentId, action: verb, state: result.subscription.state })
        if (verb === 'refresh' && result.subscription.state === attention.state) {
          setNote(choosing ? 'Looked up again. Choose a subscription.' : 'Looked up again. There is still no subscription.')
        }
      }
      subscriptionAttentionStore.apply(environmentId, result.subscription, 'action')
    } catch (err) {
      rError('subscription-prompt', 'action failed', { environment_id: environmentId, action: verb, error: String(err) })
      setFailure(err instanceof Error ? err.message : `Could not ${verb} the subscription.`)
    } finally {
      setBusy(false)
    }
  }

  const options = status.options ?? []

  return (
    <motion.div
      data-ion-ui
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.15 }}
      onClick={dismiss}
      style={{
        position: 'fixed',
        inset: 0,
        background: colors.scrim,
        pointerEvents: 'auto',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 16,
        boxSizing: 'border-box',
        overflowY: 'auto',
      }}
    >
      <motion.div
        data-ion-ui
        role="dialog"
        aria-label={choosing ? `Choose a ${name} subscription` : `No ${name} subscription`}
        initial={{ opacity: 0, scale: 0.96 }}
        animate={{ opacity: 1, scale: 1 }}
        exit={{ opacity: 0, scale: 0.96 }}
        onClick={(e) => e.stopPropagation()}
        className="glass-surface"
        style={{
          width: 380,
          maxWidth: '100%',
          maxHeight: '100%',
          minWidth: 0,
          boxSizing: 'border-box',
          overflowY: 'auto',
          borderRadius: 16,
          padding: 20,
          display: 'flex',
          flexDirection: 'column',
          gap: 12,
        }}
      >
        <div style={{ fontSize: 13, fontWeight: 600, color: colors.textPrimary }}>
          {choosing ? `Choose a ${name} subscription` : `No ${name} subscription`}
        </div>
        <div style={{ fontSize: 11, color: colors.textSecondary, lineHeight: 1.5, overflowWrap: 'anywhere' }}>
          {choosing
            ? `Choose the ${name} subscription this account uses. Requests to ${name} fail until one is chosen.`
            : subscriptionFailureText(status, `The signed-in account has no ${name} subscription. Requests to ${name} fail until it has one. Contact your administrator for access.`)}
          {serverLabel && <div style={{ color: colors.textTertiary, marginTop: 4 }}>Server: {serverLabel}</div>}
        </div>
        {choosing && (
          <div role="radiogroup" aria-label="Subscription" style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            {options.map((option) => (
              <OptionRow key={option.id} option={option} checked={choice === option.id} disabled={busy} onPick={() => setChoice(option.id)} />
            ))}
          </div>
        )}
        {note && <div style={{ fontSize: 11, color: colors.textSecondary }}>{note}</div>}
        {failure && <div role="alert" style={{ fontSize: 11, color: colors.dangerFg, overflowWrap: 'anywhere' }}>{failure}</div>}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, flexWrap: 'wrap', marginTop: 4 }}>
          <PromptButton label={choosing ? 'Not now' : 'Dismiss'} onClick={dismiss} />
          <PromptButton
            label="Look up again"
            icon={<ArrowClockwise size={12} />}
            primary={!choosing}
            disabled={busy}
            onClick={() => { void run('refresh', 'provider.refreshSubscription', []) }}
          />
          {choosing && (
            <PromptButton
              label="Use subscription"
              primary
              disabled={busy || choice === ''}
              onClick={() => { void run('select', 'provider.selectSubscription', [{ id: choice }]) }}
            />
          )}
        </div>
      </motion.div>
    </motion.div>
  )
}

function OptionRow({ option, checked, disabled, onPick }: {
  option: SubscriptionOption
  checked: boolean
  disabled: boolean
  onPick: () => void
}): React.JSX.Element {
  const colors = useColors()
  const ix = useInteractiveState()
  return (
    <button
      role="radio"
      aria-checked={checked}
      disabled={disabled}
      onClick={onPick}
      {...ix.handlers}
      className="ion-focusable"
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        textAlign: 'left',
        padding: '8px 10px',
        borderRadius: 8,
        fontSize: 12,
        fontWeight: checked ? 500 : 400,
        color: colors.textPrimary,
        background: interactiveBg(colors, { ...ix, selected: checked }, colors.surfacePrimary),
        border: `1px solid ${checked ? colors.accent : colors.containerBorder}`,
        cursor: disabled ? 'default' : 'pointer',
        transition: `background ${transitions.base}`,
      }}
    >
      <span
        aria-hidden
        style={{
          width: 10,
          height: 10,
          flexShrink: 0,
          borderRadius: '50%',
          border: `1px solid ${checked ? colors.accent : colors.textTertiary}`,
          background: checked ? colors.accent : 'transparent',
        }}
      />
      <span style={{ minWidth: 0, overflowWrap: 'anywhere' }}>{option.label}</span>
    </button>
  )
}

function PromptButton({ label, icon, primary = false, disabled = false, onClick }: {
  label: string
  icon?: React.ReactNode
  primary?: boolean
  disabled?: boolean
  onClick: () => void
}): React.JSX.Element {
  const colors = useColors()
  const ix = useInteractiveState()
  const primaryBg = ix.pressed ? colors.accentPressed : ix.hover ? colors.accentHover : colors.accent
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      {...ix.handlers}
      className="ion-focusable px-3 py-1 rounded-lg text-[11px]"
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        color: primary ? colors.textOnAccent : colors.textSecondary,
        background: primary ? primaryBg : interactiveBg(colors, ix, colors.surfacePrimary),
        border: primary ? 'none' : `1px solid ${colors.containerBorder}`,
        opacity: disabled ? 0.5 : 1,
        cursor: disabled ? 'default' : 'pointer',
        transition: `background ${transitions.base}`,
      }}
    >
      {icon}
      {label}
    </button>
  )
}
