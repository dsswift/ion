/**
 * ProviderIcon — a model provider's own mark, so a provider is recognised
 * before its name is read. A provider with no mark here (a custom one) gets
 * its initial on a tile of a colour that is always the same for its id.
 */
import React from 'react'
import { getProviderDisplayName } from '@ion/shared/types-models'
import { useColors } from '../theme'
import anthropic from '../assets/providers/anthropic.svg?raw'
import azure from '../assets/providers/azure.svg?raw'
import bedrock from '../assets/providers/bedrock.svg?raw'
import cerebras from '../assets/providers/cerebras.svg?raw'
import deepseek from '../assets/providers/deepseek.svg?raw'
import fireworks from '../assets/providers/fireworks.svg?raw'
import google from '../assets/providers/google.svg?raw'
import groq from '../assets/providers/groq.svg?raw'
import mistral from '../assets/providers/mistral.svg?raw'
import ollama from '../assets/providers/ollama.svg?raw'
import openai from '../assets/providers/openai.svg?raw'
import openrouter from '../assets/providers/openrouter.svg?raw'
import together from '../assets/providers/together.svg?raw'
import xai from '../assets/providers/xai.svg?raw'

/** Each mark is an SVG one em square; a single-colour one takes the text colour around it. */
const FILES: Record<string, string> = { anthropic, azure, bedrock, cerebras, deepseek, fireworks, google, groq, mistral, ollama, openai, openrouter, together, xai }

/** The marks without their `<title>`: the name is already written beside each one, and a title would be read and hovered twice. */
const MARKS: Record<string, string> = Object.fromEntries(Object.entries(FILES).map(([id, svg]) => [id, svg.replace(/<title>[^<]*<\/title>/, '')]))

/** A hue that is always the same for one provider id. */
function hue(provider: string): number {
  let hash = 0
  for (const char of provider) hash = (hash * 31 + char.charCodeAt(0)) >>> 0
  // The golden angle keeps ids whose hashes are close from landing on close hues.
  return Math.round((hash % 997) * 137.508) % 360
}

export function ProviderIcon({ provider, size = 16 }: { provider: string; size?: number }): React.JSX.Element {
  const colors = useColors()
  const mark = MARKS[provider]
  if (mark) {
    return <span aria-hidden data-provider-icon={provider} style={{ display: 'inline-flex', width: size, height: size, fontSize: size, lineHeight: 1, flexShrink: 0, color: colors.textPrimary }} dangerouslySetInnerHTML={{ __html: mark }} />
  }
  const chip = `hsl(${hue(provider)} 55% 42%)` // hardcoded-ok: the provider's own hue, generated from its name
  const letter = '#ffffff' // hardcoded-ok: a white initial on that hue, in either theme
  return (
    <span aria-hidden data-provider-icon="initial" style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: size, height: size, borderRadius: Math.round(size / 4), flexShrink: 0, background: chip, color: letter, fontSize: Math.round(size * 0.62), fontWeight: 700, lineHeight: 1 }}>
      {getProviderDisplayName(provider).charAt(0).toUpperCase()}
    </span>
  )
}
