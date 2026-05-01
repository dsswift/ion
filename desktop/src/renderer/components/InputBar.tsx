import React, { useState, useRef, useCallback, useEffect, useLayoutEffect } from 'react'
import { AnimatePresence } from 'framer-motion'
import { create } from 'zustand'
import { useSessionStore } from '../stores/sessionStore'
import { AttachmentChips } from './AttachmentChips'
import { SlashCommandMenu, getFilteredCommandsWithExtras, type SlashCommand } from './SlashCommandMenu'
import { useColors } from '../theme'
import { usePreferencesStore } from '../preferences'
import type { DiscoveredCommand } from '../../shared/types'
import { useVoiceRecording, VoiceButtons } from './InputBarVoiceButton'
import { SendButton } from './InputBarSendButton'
import { executeBuiltinCommand, resolveModelSwitch } from './InputBarCommandHandlers'

/** Shared transient state for bash command mode (consumed by App.tsx for pill styling) */
export const useBashModeStore = create<{ active: boolean; set: (v: boolean) => void }>((set) => ({
  active: false,
  set: (v) => set({ active: v }),
}))

const INPUT_MIN_HEIGHT = 20
const INPUT_MAX_HEIGHT = 140
const MULTILINE_ENTER_HEIGHT = 52
const MULTILINE_EXIT_HEIGHT = 50
const INLINE_CONTROLS_RESERVED_WIDTH = 104

/**
 * InputBar renders inside a glass-surface rounded-full pill provided by App.tsx.
 * It provides: textarea + mic/send buttons. Attachment chips render above when present.
 */
export function InputBar() {
  const [input, setInput] = useState('')
  const [slashFilter, setSlashFilter] = useState<string | null>(null)
  const [slashIndex, setSlashIndex] = useState(0)
  const bashMode = useBashModeStore((s) => s.active)
  const setBashMode = useBashModeStore((s) => s.set)
  const [isMultiLine, setIsMultiLine] = useState(false)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const wrapperRef = useRef<HTMLDivElement>(null)
  const measureRef = useRef<HTMLTextAreaElement | null>(null)

  const sendMessage = useSessionStore((s) => s.sendMessage)
  const submitEnginePrompt = useSessionStore((s) => s.submitEnginePrompt)
  const clearTab = useSessionStore((s) => s.clearTab)
  const addSystemMessage = useSessionStore((s) => s.addSystemMessage)
  const startBashCommand = useSessionStore((s) => s.startBashCommand)
  const completeBashCommand = useSessionStore((s) => s.completeBashCommand)
  const addAttachments = useSessionStore((s) => s.addAttachments)
  const removeAttachment = useSessionStore((s) => s.removeAttachment)
  const setDraftInput = useSessionStore((s) => s.setDraftInput)
  const clearPendingInput = useSessionStore((s) => s.clearPendingInput)

  const setPreferredModel = usePreferencesStore((s) => s.setPreferredModel)
  const staticInfo = useSessionStore((s) => s.staticInfo)
  const preferredModel = usePreferencesStore((s) => s.preferredModel)
  const activeTabId = useSessionStore((s) => s.activeTabId)
  const tab = useSessionStore((s) => s.tabs.find((t) => t.id === s.activeTabId))
  const bashExecuting = tab?.bashExecuting ?? false
  const tabsReady = useSessionStore((s) => s.tabsReady)
  const bashCommandEntry = usePreferencesStore((s) => s.bashCommandEntry)
  const colors = useColors()
  const isBusy = tab?.status === 'running' || tab?.status === 'connecting'
  const isConnecting = tab?.status === 'connecting' || !tabsReady
  const hasContent = input.trim().length > 0 || (tab?.attachments?.length ?? 0) > 0
  const canSend = !!tab && !isConnecting && hasContent
  const attachments = tab?.attachments || []
  const showSlashMenu = slashFilter !== null && !isConnecting
  const [discoveredCommands, setDiscoveredCommands] = useState<DiscoveredCommand[]>([])
  const workingDir = tab?.workingDirectory || '~'

  const appendTranscript = useCallback((transcript: string) => {
    setInput((prev) => (prev ? `${prev} ${transcript}` : transcript))
  }, [])

  const { voiceState, voiceError, stopRecording, cancelRecording, toggleRecording } =
    useVoiceRecording(appendTranscript)

  // Discover commands from filesystem on mount and when working directory changes
  useEffect(() => {
    let cancelled = false
    window.ion.discoverCommands(workingDir).then((cmds) => {
      if (!cancelled) setDiscoveredCommands(cmds)
    }).catch(() => {})
    return () => { cancelled = true }
  }, [workingDir])

  const extraCommands: SlashCommand[] = discoveredCommands.map((dc) => ({
    command: `/${dc.name}`,
    description: dc.description || `${dc.source}: ${dc.name}`,
    icon: <span className="text-[11px]">{dc.scope === 'project' ? '◆' : '✦'}</span>,
    group: dc.scope === 'project' ? 'project' as const : 'user' as const,
  }))

  // ─── Per-tab draft input sync ───
  // Save current input to departing tab, restore arriving tab's draft
  const prevTabIdRef = useRef(activeTabId)
  useEffect(() => {
    const prevId = prevTabIdRef.current
    if (prevId && prevId !== activeTabId) {
      // Save what was typed to the tab we're leaving
      setDraftInput(prevId, input)
      // Load the arriving tab's draft
      const arriving = useSessionStore.getState().tabs.find((t) => t.id === activeTabId)
      setInput(arriving?.draftInput ?? '')
      setSlashFilter(null)
    }
    prevTabIdRef.current = activeTabId
    textareaRef.current?.focus()
    setBashMode(false)
  }, [activeTabId])

  // ─── Rewind: restore user message to input bar ───
  const pendingInput = tab?.pendingInput
  useEffect(() => {
    if (pendingInput && activeTabId) {
      setInput(pendingInput)
      clearPendingInput(activeTabId)
      textareaRef.current?.focus()
    }
  }, [pendingInput, activeTabId])

  // Focus textarea when window is shown (shortcut toggle, screenshot return)
  // Skip if focus is inside the terminal panel (xterm manages its own focus)
  useEffect(() => {
    const unsub = window.ion.onWindowShown(() => {
      const active = document.activeElement
      if (active && active.closest('.xterm')) return
      textareaRef.current?.focus()
    })
    return unsub
  }, [])

  const measureInlineHeight = useCallback((value: string): number => {
    if (typeof document === 'undefined') return 0
    if (!measureRef.current) {
      const m = document.createElement('textarea')
      m.setAttribute('aria-hidden', 'true')
      m.tabIndex = -1
      m.style.position = 'absolute'
      m.style.top = '-99999px'
      m.style.left = '0'
      m.style.height = '0'
      m.style.minHeight = '0'
      m.style.overflow = 'hidden'
      m.style.visibility = 'hidden'
      m.style.pointerEvents = 'none'
      m.style.zIndex = '-1'
      m.style.resize = 'none'
      m.style.border = '0'
      m.style.outline = '0'
      m.style.boxSizing = 'border-box'
      document.body.appendChild(m)
      measureRef.current = m
    }

    const m = measureRef.current
    const hostWidth = wrapperRef.current?.clientWidth ?? 0
    const inlineWidth = Math.max(120, hostWidth - INLINE_CONTROLS_RESERVED_WIDTH)
    m.style.width = `${inlineWidth}px`
    m.style.fontSize = '14px'
    m.style.lineHeight = '20px'
    m.style.paddingTop = '15px'
    m.style.paddingBottom = '15px'
    m.style.paddingLeft = '0'
    m.style.paddingRight = '0'

    const computed = textareaRef.current ? window.getComputedStyle(textareaRef.current) : null
    if (computed) {
      m.style.fontFamily = computed.fontFamily
      m.style.letterSpacing = computed.letterSpacing
      m.style.fontWeight = computed.fontWeight
    }

    m.value = value || ' '
    return m.scrollHeight
  }, [])

  const autoResize = useCallback(() => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = `${INPUT_MIN_HEIGHT}px`
    const naturalHeight = el.scrollHeight
    const clampedHeight = Math.min(naturalHeight, INPUT_MAX_HEIGHT)
    el.style.height = `${clampedHeight}px`
    el.style.overflowY = naturalHeight > INPUT_MAX_HEIGHT ? 'auto' : 'hidden'
    if (naturalHeight <= INPUT_MAX_HEIGHT) {
      el.scrollTop = 0
    }
    // Decide multiline mode against fixed inline-width measurement to avoid
    // expand/collapse bounce when layout switches between modes.
    const inlineHeight = measureInlineHeight(input)
    setIsMultiLine((prev) => {
      if (!prev) return inlineHeight > MULTILINE_ENTER_HEIGHT
      return inlineHeight > MULTILINE_EXIT_HEIGHT
    })
  }, [input, measureInlineHeight])

  useLayoutEffect(() => { autoResize() }, [input, isMultiLine, autoResize])

  // Cleanup measurement DOM node on unmount
  useEffect(() => {
    return () => {
      if (measureRef.current) {
        measureRef.current.remove()
        measureRef.current = null
      }
    }
  }, [])

  // ─── Slash command detection ───
  const updateSlashFilter = useCallback((value: string) => {
    const match = value.match(/^(\/[a-zA-Z-]*)$/)
    if (match) {
      setSlashFilter(match[1])
      setSlashIndex(0)
    } else {
      setSlashFilter(null)
    }
  }, [])

  // ─── Handle slash commands ───
  const executeCommand = useCallback((cmd: SlashCommand) => {
    executeBuiltinCommand(cmd.command, {
      tab,
      staticInfo,
      preferredModel,
      discoveredCommands,
      clearTab,
      addSystemMessage,
    })
  }, [tab, clearTab, addSystemMessage, staticInfo, preferredModel, discoveredCommands])

  const handleSlashSelect = useCallback((cmd: SlashCommand) => {
    setInput(`${cmd.command} `)
    setSlashFilter(null)
    requestAnimationFrame(() => textareaRef.current?.focus())
  }, [])

  // ─── Send ───
  const handleSend = useCallback(() => {
    if (showSlashMenu) {
      const filtered = getFilteredCommandsWithExtras(slashFilter!, extraCommands)
      if (filtered.length > 0) {
        handleSlashSelect(filtered[slashIndex])
        return
      }
    }
    // Bash command mode: execute directly and store result as pending context
    if (bashMode) {
      const cmd = input.trim()
      if (!cmd) return
      if (bashExecuting) return
      if (isConnecting) return
      const cwd = tab?.workingDirectory || '~'
      const execId = crypto.randomUUID()
      setInput('')
      if (activeTabId) setDraftInput(activeTabId, '')
      setBashMode(false)
      if (textareaRef.current) {
        textareaRef.current.style.height = `${INPUT_MIN_HEIGHT}px`
      }
      const { toolMsgId, tabId } = startBashCommand(cmd, execId)
      window.ion.executeBash(execId, cmd, cwd).then((result) => {
        completeBashCommand(tabId, toolMsgId, cmd, result.stdout, result.stderr, result.exitCode)
        requestAnimationFrame(() => textareaRef.current?.focus())
      }).catch(() => {
        completeBashCommand(tabId, toolMsgId, cmd, '', 'IPC error: bash execution failed', 1)
      })
      return
    }
    const prompt = input.trim()
    const modelMatch = prompt.match(/^\/model\s+(\S+)/i)
    if (modelMatch) {
      const result = resolveModelSwitch(modelMatch[1])
      setInput('')
      setSlashFilter(null)
      if (result.ok && result.modelId && result.modelLabel) {
        setPreferredModel(result.modelId)
        addSystemMessage(`Model switched to ${result.modelLabel} (${result.modelId})`)
      } else {
        addSystemMessage(`Unknown model "${result.query}". Available: opus, sonnet, haiku`)
      }
      return
    }
    if (!prompt && attachments.length === 0) return
    if (isConnecting) return
    setInput('')
    if (activeTabId) setDraftInput(activeTabId, '')
    setSlashFilter(null)
    if (textareaRef.current) {
      textareaRef.current.style.height = `${INPUT_MIN_HEIGHT}px`
    }
    // Route to engine if this is an engine tab
    const currentTab = useSessionStore.getState().tabs.find(t => t.id === useSessionStore.getState().activeTabId)
    if (currentTab?.isEngine) {
      const text = prompt || ''
      // Check for slash commands (e.g. /agents-team cloudops-full)
      const slashMatch = text.match(/^\/(\S+)\s*(.*)$/)
      if (slashMatch) {
        const pane = useSessionStore.getState().enginePanes.get(currentTab.id)
        const instanceId = pane?.activeInstanceId
        if (instanceId) {
          const key = `${currentTab.id}:${instanceId}`
          window.ion.engineCommand(key, slashMatch[1], slashMatch[2])
        }
      } else {
        submitEnginePrompt(currentTab.id, text)
      }
      requestAnimationFrame(() => textareaRef.current?.focus())
      return
    }
    sendMessage(prompt || 'See attached files')
    // Refocus after React re-renders from the state update
    requestAnimationFrame(() => textareaRef.current?.focus())
  }, [input, isBusy, sendMessage, submitEnginePrompt, attachments.length, showSlashMenu, slashFilter, slashIndex, handleSlashSelect, bashMode, bashExecuting, tab?.workingDirectory, startBashCommand, completeBashCommand, extraCommands, isConnecting, activeTabId, setDraftInput, setBashMode, addSystemMessage, setPreferredModel])

  // ─── Keyboard ───
  const handleKeyDown = (e: React.KeyboardEvent) => {
    // Exit bash mode on backspace when input is empty
    if (bashMode && e.key === 'Backspace' && input === '') {
      e.preventDefault()
      setBashMode(false)
      return
    }
    if (showSlashMenu) {
      const filtered = getFilteredCommandsWithExtras(slashFilter!, extraCommands)
      if (e.key === 'ArrowDown') { e.preventDefault(); setSlashIndex((i) => (i + 1) % filtered.length); return }
      if (e.key === 'ArrowUp') { e.preventDefault(); setSlashIndex((i) => (i - 1 + filtered.length) % filtered.length); return }
      if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) { e.preventDefault(); if (filtered.length > 0) handleSlashSelect(filtered[slashIndex]); return }
      if (e.key === 'Escape') { e.preventDefault(); setSlashFilter(null); return }
    }
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend() }
  }

  const handleInputChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const value = e.target.value
    // Enter bash mode when ! is typed as first character on empty input
    if (!bashMode && bashCommandEntry && value === '!') {
      setBashMode(true)
      setInput('')
      return
    }
    setInput(value)
    if (!bashMode) updateSlashFilter(value)
  }

  // ─── Paste image ───
  const handlePaste = useCallback(async (e: React.ClipboardEvent) => {
    const items = e.clipboardData?.items
    if (!items) return
    for (const item of Array.from(items)) {
      if (item.type.startsWith('image/')) {
        e.preventDefault()
        const blob = item.getAsFile()
        if (!blob) return
        const reader = new FileReader()
        reader.onload = async () => {
          const dataUrl = reader.result as string
          const attachment = await window.ion.pasteImage(dataUrl)
          if (attachment) addAttachments([attachment])
        }
        reader.readAsDataURL(blob)
        return
      }
    }
  }, [addAttachments])

  const hasAttachments = attachments.length > 0
  const bashPlaceholder = 'Enter bash command...'

  const placeholder =
    tab?.bashExecuting
      ? 'Running...'
      : bashMode
        ? bashPlaceholder
        : isConnecting
          ? 'Initializing...'
          : voiceState === 'recording'
            ? 'Recording... ✓ to confirm, ✕ to cancel'
            : voiceState === 'transcribing'
              ? 'Transcribing...'
              : isBusy
                ? 'Type to queue a message...'
                : 'Ask Ion anything...'

  const sendVisible = canSend && voiceState !== 'recording'

  return (
    <div ref={wrapperRef} data-ion-ui className="flex flex-col w-full relative">
      {/* Slash command menu */}
      <AnimatePresence>
        {showSlashMenu && (
          <SlashCommandMenu
            filter={slashFilter!}
            selectedIndex={slashIndex}
            onSelect={handleSlashSelect}
            anchorRect={wrapperRef.current?.getBoundingClientRect() ?? null}
            extraCommands={extraCommands}
          />
        )}
      </AnimatePresence>

      {/* Attachment chips — renders inside the pill, above textarea */}
      {hasAttachments && (
        <div style={{ paddingTop: 6, marginLeft: -6 }}>
          <AttachmentChips attachments={attachments} onRemove={removeAttachment} />
        </div>
      )}

      {/* Single-line: inline controls. Multi-line: controls in bottom row */}
      <div className="w-full" style={{ minHeight: 50 }}>
        {isMultiLine ? (
          <div className="w-full">
            <textarea
              ref={textareaRef}
              value={input}
              onChange={handleInputChange}
              onKeyDown={handleKeyDown}
              onPaste={handlePaste}
              placeholder={placeholder}
              rows={1}
              className="w-full bg-transparent resize-none"
              style={{
                fontSize: 14,
                lineHeight: '20px',
                color: colors.textPrimary,
                minHeight: 20,
                maxHeight: INPUT_MAX_HEIGHT,
                paddingTop: 11,
                paddingBottom: 2,
              }}
            />

            <div className="flex items-center justify-end gap-1" style={{ marginTop: 0, paddingBottom: 4 }}>
              <VoiceButtons
                voiceState={voiceState}
                isConnecting={isConnecting}
                colors={colors}
                onToggle={toggleRecording}
                onCancel={cancelRecording}
                onStop={stopRecording}
              />
              <SendButton visible={sendVisible} isBusy={isBusy} colors={colors} onClick={handleSend} />
            </div>
          </div>
        ) : (
          <div className="flex items-center w-full" style={{ minHeight: 50 }}>
            <textarea
              ref={textareaRef}
              value={input}
              onChange={handleInputChange}
              onKeyDown={handleKeyDown}
              onPaste={handlePaste}
              placeholder={placeholder}
              rows={1}
              className="flex-1 bg-transparent resize-none"
              style={{
                fontSize: 14,
                lineHeight: '20px',
                color: colors.textPrimary,
                minHeight: 20,
                maxHeight: INPUT_MAX_HEIGHT,
                paddingTop: 15,
                paddingBottom: 15,
              }}
            />

            <div className="flex items-center gap-1 shrink-0 ml-2">
              <VoiceButtons
                voiceState={voiceState}
                isConnecting={isConnecting}
                colors={colors}
                onToggle={toggleRecording}
                onCancel={cancelRecording}
                onStop={stopRecording}
              />
              <SendButton visible={sendVisible} isBusy={isBusy} colors={colors} onClick={handleSend} />
            </div>
          </div>
        )}
      </div>

      {/* Voice error */}
      {voiceError && (
        <div className="px-1 pb-2 text-[11px]" style={{ color: colors.statusError }}>
          {voiceError}
        </div>
      )}
    </div>
  )
}
