/**
 * AppearancePage — how Studio looks on this device: the color theme (and an
 * organization's lock on it), conversation layout, editor and data text
 * sizes, the terminal font, and the interface scale.
 *
 * Theme-pack diagnostics follow the live theme registry, so a pack that
 * loads or fails while the page is open shows up without a reopen.
 */
import React, { useEffect, useState } from 'react'
import { Minus, Plus } from '@phosphor-icons/react'
import { resolveEffectiveThemeId } from '@ion/shared/enterprise-theme-policy'
import { resolveSettingMutability } from '@ion/shared/enterprise-settings-policy'
import { rDebug } from '../../../rendererLogger'
import { getTheme } from '../../../theme-tokens'
import { useAllThemes } from '../../../hooks/useThemeRegistry'
import { host } from '../../../host/host-instance'
import { useSettingsPreferences } from '../settings-target'
import { Button, FormGroup, FormRow, IconButton, Inline, KIT, Muted, Notice, Select, Stack, ToggleRow } from '../kit'

const FONT_MIN = 8
const FONT_MAX = 24

let fontCache: string[] | null = null
// Installed OS fonts come from the native shell only. A browser client has
// no source for them, so it keeps the built-in stack. This stays a promise
// either way: the effect below chains on it unconditionally.
const fontPromise: Promise<void> = host.capabilities().includes('nativeShell')
  ? host.shell.listFonts()
      .then((fonts) => { fontCache = fonts })
      .catch((err: unknown) => rDebug('appearance', 'listFonts failed', { error: String(err) }))
  : Promise.resolve(rDebug('appearance', 'no OS font list in this client; using the built-in stack'))

/** − value + on one compact row. */
function Stepper({ label, value, display, onStep }: { label: string; value: number; display?: string; onStep(delta: number): void }): React.JSX.Element {
  return (
    <Inline gap={4}>
      <IconButton icon={Minus} label={`Decrease ${label}`} onClick={() => onStep(-1)} />
      <span aria-label={label} style={{ minWidth: 40, textAlign: 'center', fontSize: KIT.fontSmall, fontVariantNumeric: 'tabular-nums' }}>{display ?? value}</span>
      <IconButton icon={Plus} label={`Increase ${label}`} onClick={() => onStep(1)} />
    </Inline>
  )
}

const clampFont = (v: number): number => Math.min(FONT_MAX, Math.max(FONT_MIN, v))

export function AppearancePage(): React.JSX.Element {
  const p = useSettingsPreferences
  const selectedTheme = p((s) => s.selectedTheme)
  const setSelectedTheme = p((s) => s.setSelectedTheme)
  const expandToolResults = p((s) => s.expandToolResults)
  const setExpandToolResults = p((s) => s.setExpandToolResults)
  const unifiedTurnView = p((s) => s.unifiedTurnView)
  const setUnifiedTurnView = p((s) => s.setUnifiedTurnView)
  const editorWordWrap = p((s) => s.editorWordWrap)
  const setEditorWordWrap = p((s) => s.setEditorWordWrap)
  const editorFontSize = p((s) => s.editorFontSize)
  const setEditorFontSize = p((s) => s.setEditorFontSize)
  const dataViewFontSize = p((s) => s.dataViewFontSize)
  const setDataViewFontSize = p((s) => s.setDataViewFontSize)
  const openMarkdownInPreview = p((s) => s.openMarkdownInPreview)
  const setOpenMarkdownInPreview = p((s) => s.setOpenMarkdownInPreview)
  const terminalFontFamily = p((s) => s.terminalFontFamily)
  const setTerminalFontFamily = p((s) => s.setTerminalFontFamily)
  const terminalFontSize = p((s) => s.terminalFontSize)
  const setTerminalFontSize = p((s) => s.setTerminalFontSize)
  const uiZoom = p((s) => s.uiZoom)
  const setUiZoom = p((s) => s.setUiZoom)
  const enterprisePolicy = p((s) => s.enterprisePolicy)

  const allThemes = useAllThemes()
  // Sealed with or without a policy theme: either way the picker is off.
  const themeLocked = resolveSettingMutability(enterprisePolicy, 'selectedTheme').class === 'sealed'
  // A lock shows the enforced theme; the saved pick is kept for when it lifts.
  const displayedThemeId = resolveEffectiveThemeId(enterprisePolicy, selectedTheme)
  const activeTheme = getTheme(displayedThemeId)

  const nativeFonts = host.capabilities().includes('nativeShell')
  const [availableFonts, setAvailableFonts] = useState<string[]>(fontCache ?? [])
  useEffect(() => {
    if (fontCache) return
    fontPromise.then(() => { if (fontCache) setAvailableFonts(fontCache) }).catch((err: unknown) => rDebug('settings', 'load fonts failed', { error: String(err) }))
  }, [])

  const diagnostics = allThemes.flatMap((theme) => ([['ios', theme.iosDiagnostics], ['desktop', theme.desktopDiagnostics]] as const)
    .flatMap(([surface, list]) => (list ?? []).map((diagnostic, index) => ({ key: `${surface}-${theme.id}-${index}`, theme: theme.displayName, surface, diagnostic }))))

  return (
    <Stack gap={KIT.groupGap}>
      <FormGroup title="Theme" anchor="theme">
        <FormRow label="Color theme" description={themeLocked ? 'Theme is managed by your organization.' : 'Choose a visual theme for the app.'}>
          {activeTheme.logoUrl && <img src={activeTheme.logoUrl} alt={`${activeTheme.displayName} logo`} style={{ maxHeight: KIT.controlHeight, maxWidth: 120, objectFit: 'contain' }} />}
          <Select aria-label="Color theme" width={200} value={displayedThemeId} disabled={themeLocked} onChange={(e) => setSelectedTheme(e.target.value)}>
            {allThemes.filter((t) => t.selectable !== false).map((t) => <option key={t.id} value={t.id}>{t.displayName}</option>)}
          </Select>
        </FormRow>
      </FormGroup>
      {diagnostics.length > 0 && (
        <Stack gap={6}>
          {diagnostics.map(({ key, theme, surface, diagnostic }) => (
            <Notice key={key} tone="warn">
              <strong>{theme}: {surface === 'ios' ? 'iOS' : 'Desktop'} theme {diagnostic.fatal ? 'not loaded' : 'loaded with defaults'}</strong>
              <div>{diagnostic.fatal ? `This ${surface} component was rejected.` : `This ${surface} component loaded with fallback values.`} {diagnostic.message}</div>
            </Notice>
          ))}
        </Stack>
      )}

      <FormGroup title="Conversation">
        <ToggleRow anchor="tool-output" label="Expand tool output" settingKey="expandToolResults" description="Auto-expand file write and edit results inline." checked={expandToolResults} onChange={setExpandToolResults} />
        <ToggleRow anchor="unified-turn" label="Unified turn view" settingKey="unifiedTurnView" description="Group tool calls into one collapsible panel and show the assistant's text as one continuous block, instead of interleaving them."checked={unifiedTurnView} onChange={setUnifiedTurnView} />
      </FormGroup>

      <FormGroup title="Editor & files">
        <ToggleRow anchor="markdown-preview" label="Open Markdown in Preview" settingKey="openMarkdownInPreview" description="Saved .md files open in preview. New unsaved files always open in edit mode." checked={openMarkdownInPreview} onChange={setOpenMarkdownInPreview} />
        <ToggleRow anchor="word-wrap" label="Word wrap" settingKey="editorWordWrap" description="Wrap long lines in the editor instead of scrolling sideways." checked={editorWordWrap} onChange={setEditorWordWrap} />
        <FormRow anchor="editor-font" label="Editor font size" settingKey="editorFontSize" description="Edit and preview text, in pixels.">
          <Stepper label="Editor font size" value={editorFontSize} onStep={(d) => setEditorFontSize(clampFont(editorFontSize + d))} />
        </FormRow>
        <FormRow anchor="data-font" label="Data view font size" settingKey="dataViewFontSize" description="Conversation, plan, resource, Markdown preview, and diff text, in pixels.">
          <Stepper label="Data view font size" value={dataViewFontSize} onStep={(d) => setDataViewFontSize(clampFont(dataViewFontSize + d))} />
        </FormRow>
      </FormGroup>

      <FormGroup title="Terminal" anchor="terminal-font">
        <FormRow label="Terminal font" settingKey="terminalFontFamily" description="Prompt icons render with any font: Studio bundles the Nerd Font symbols as a fallback.">
          {nativeFonts ? (
            <Select aria-label="Terminal font" width={220} value={availableFonts.includes(terminalFontFamily) ? terminalFontFamily : ''} onChange={(e) => setTerminalFontFamily(e.target.value)}>
              {!availableFonts.includes(terminalFontFamily) && <option value="">{terminalFontFamily}</option>}
              {availableFonts.map((font) => <option key={font} value={font}>{font}</option>)}
            </Select>
          ) : <Muted mono>{terminalFontFamily}</Muted>}
        </FormRow>
        <FormRow label="Terminal font size" settingKey="terminalFontSize" description="In pixels.">
          <Stepper label="Terminal font size" value={terminalFontSize} onStep={(d) => setTerminalFontSize(clampFont(terminalFontSize + d))} />
        </FormRow>
      </FormGroup>

      <FormGroup title="Interface scale">
        <FormRow anchor="ui-zoom" label="Interface scale" settingKey="uiZoom" description="Scales controls, menus, panels, and spacing. Data, editor, and terminal text keep their own sizes.">
          <Stepper label="Interface scale" value={uiZoom} display={`${Math.round(uiZoom * 100)}%`} onStep={(d) => setUiZoom(uiZoom + d * 0.1)} />
          <Button variant="ghost" disabled={uiZoom === 1} onClick={() => setUiZoom(1)}>Reset</Button>
        </FormRow>
      </FormGroup>
    </Stack>
  )
}
