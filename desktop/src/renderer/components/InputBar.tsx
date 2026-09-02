import React, { useState, useRef, useCallback, useEffect, useMemo } from 'react'
import { AnimatePresence } from 'framer-motion'
import { create } from 'zustand'
import { useSessionStore } from '../stores/sessionStore'
import { activeInstance } from '../stores/conversation-instance'
import { resolveClearingCommand, clearingCommandMessage, type ClearingCommandPrompt } from './InputBarClearingCommand'
import { resolveContextInputs } from './context-usage'
import { useInputAutoResize } from '../hooks/useInputAutoResize'
import { ConfirmDialog } from './git/ConfirmDialog'
import { AttachmentChips } from './AttachmentChips'
import { SlashCommandMenu, getFilteredCommandsWithExtras, slashMenuEnterAction, ExtensionCommandIcon, type SlashCommand } from './SlashCommandMenu'
import { useColors } from '../theme'
import { usePreferencesStore } from '../preferences'
import type { DiscoveredCommand } from '../../shared/types'
import { getRendererExtensionCommands } from '../stores/slices/engine-event-slice'
import { useVoiceRecording, VoiceButtons } from './InputBarVoiceButton'
import { SendButton } from './InputBarSendButton'
import { UpdateButton } from './UpdateButton'
import { rDebug, rError, rInfo, rWarn } from '../rendererLogger'
import { dispatchSend } from './InputBarSend'
import { dispatchBashCommand } from './InputBarBash'
import { useModelStore } from '../stores/model-store'
import { useActiveContextCapacity } from '../hooks/useActiveContextCapacity'
import { ComposerControls } from './ComposerControls'
import { InputLockNotice } from './InputLockNotice'
import { ContextCapacityNotice } from './ContextCapacityNotice'
import { ImageModelNotice } from './ImageModelNotice'
import { INLINE_CONTROLS_RESERVED_WIDTH, INPUT_MAX_HEIGHT, INPUT_MIN_HEIGHT, MULTILINE_ENTER_HEIGHT, MULTILINE_EXIT_HEIGHT } from './input-bar-layout'
/** Shared transient state for bash command mode (consumed by App.tsx for pill styling) */
export const useBashModeStore = create<{ active: boolean; set: (v: boolean) => void }>((set) => ({
  active: false,
  set: (v) => set({ active: v }),
}))

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

  const submit = useSessionStore((s) => s.submit)
  // (clearTab/addSystemMessage/addEngineSystemMessage were used by the
  // pre-pipeline renderer slash dispatch; they remain available on the
  // store and are now driven by engine_command_result subscribers in
  // engine-event-slice.ts.)
  const startBashCommand = useSessionStore((s) => s.startBashCommand)
  const completeBashCommand = useSessionStore((s) => s.completeBashCommand)
  const addAttachments = useSessionStore((s) => s.addAttachments)
  const removeAttachment = useSessionStore((s) => s.removeAttachment)
  const setDraftInput = useSessionStore((s) => s.setDraftInput)
  const clearPendingInput = useSessionStore((s) => s.clearPendingInput)

  const activeTabId = useSessionStore((s) => s.activeTabId)
  const tab = useSessionStore((s) => s.tabs.find((t) => t.id === s.activeTabId))
  const bashExecuting = tab?.bashExecuting ?? false
  const tabsReady = useSessionStore((s) => s.tabsReady)
  const initProgress = useSessionStore((s) => s.initProgress)
  const bashCommandEntry = usePreferencesStore((s) => s.bashCommandEntry)
  const colors = useColors()

  // Determine whether the active conversation instance has an image-generation
  // model selected. Image models (modelKind === "image") use a single-prompt
  // API with no conversation history — the InputBar shows a disclosure banner.
  const modelOverride = useSessionStore((s) => {
    const tabId = s.activeTabId ?? ''
    return activeInstance(s.conversationPanes, tabId)?.modelOverride ?? null
  })
  const preferredModel = usePreferencesStore((s) => s.preferredModel)
  const findModel = useModelStore((s) => s.findModel)
  const effectiveModelId = modelOverride ?? preferredModel ?? ''
  const { state: contextCapacityStatus } = useActiveContextCapacity(effectiveModelId)
  const isImageModel = effectiveModelId !== '' && findModel(effectiveModelId)?.modelKind === 'image'
  const isBusy = tab?.status === 'running' || tab?.status === 'connecting'
  const isConnecting = tab?.status === 'connecting' || !tabsReady
  const hasContent = input.trim().length > 0 || (tab?.attachments?.length ?? 0) > 0
  const canSend = !!tab && !isConnecting && hasContent
  const attachments = tab?.attachments || []
  const showSlashMenu = slashFilter !== null && !isConnecting
  const [discoveredCommands, setDiscoveredCommands] = useState<DiscoveredCommand[]>([])
  // A clearing command the operator submitted but has not confirmed yet. Held
  // here so the send is not performed until they accept losing the history.
  const [pendingClear, setPendingClear] = useState<ClearingCommandPrompt | null>(null)
  const workingDir = tab?.workingDirectory || '~'

  const appendTranscript = useCallback((transcript: string) => {
    setInput((prev) => (prev ? `${prev} ${transcript}` : transcript))
  }, [])

  const { voiceState, voiceError, stopRecording, cancelRecording, toggleRecording } =
    useVoiceRecording(appendTranscript)

  // Discover slash commands from the engine. Fires on mount, when the working
  // directory changes, AND whenever the slash menu opens (slashFilter goes
  // non-null). The menu-open trigger matters on a FRESH tab: the engine's first
  // discover call after startup is cold (extension/skill loading adds latency),
  // so the initial mount fetch may still be in flight when the user first types
  // `/`. Re-fetching on open guarantees the list refreshes as soon as the
  // (now-warm) engine responds, instead of showing only the built-ins until
  // some unrelated re-render. The result updates state, so an open menu
  // re-renders with the commands the moment they arrive.
  const slashMenuOpen = slashFilter !== null
  useEffect(() => {
    let cancelled = false
    window.ion.discoverCommands(workingDir).then((cmds) => {
      if (!cancelled) setDiscoveredCommands(cmds)
    }).catch((err) => rDebug("commands", "discoverCommands failed", { workingDir, error: String(err) }))
    return () => { cancelled = true }
  }, [workingDir, slashMenuOpen])

  const discoveredExtra: SlashCommand[] = discoveredCommands.map((dc) => ({
    command: `/${dc.name}`,
    description: dc.description || `${dc.source}: ${dc.name}`,
    icon: <span className="text-[11px]">{dc.scope === 'project' ? '◆' : '✦'}</span>,
    group: dc.scope === 'project' ? 'project' as const : 'user' as const,
  }))

  // Merge extension-registered commands from the engine's command registry.
  // The registry is keyed by the bare tabId (the engine session key for every
  // conversation post-#256), so there is no tab-type fork: a plain tab simply
  // has no registered extension commands and getRendererExtensionCommands
  // returns an empty list.
  const extraCommands: SlashCommand[] = useMemo(() => {
    const extensionExtra: SlashCommand[] = activeTabId
      ? getRendererExtensionCommands(activeTabId).map((ec) => ({
        command: `/${ec.name}`,
        description: ec.description || ec.name,
        icon: <ExtensionCommandIcon />,
        group: 'extension' as const,
      }))
      : []
    return [...discoveredExtra, ...extensionExtra]
  }, [activeTabId, discoveredExtra])

  // ─── Per-tab draft input sync ───
  // Save current input to departing tab, restore arriving tab's draft.
  // inputRef tracks the latest input value so the effect only depends on
  // activeTabId (not input itself, which would re-run on every keystroke).
  const prevTabIdRef = useRef(activeTabId)
  const inputRef = useRef(input)
  inputRef.current = input
  useEffect(() => {
    const prevId = prevTabIdRef.current
    if (prevId && prevId !== activeTabId) {
      // Save what was typed to the tab we're leaving
      setDraftInput(prevId, inputRef.current)
      // Load the arriving tab's draft (now stored on its `main` instance)
      const arrivingDraft = activeInstance(useSessionStore.getState().conversationPanes, activeTabId)?.draftInput ?? ''
      setInput(arrivingDraft)
      setSlashFilter(null)
    }
    prevTabIdRef.current = activeTabId
    textareaRef.current?.focus()
    setBashMode(false)
  }, [activeTabId, setDraftInput, setBashMode])

  // ─── Rewind: restore user message to input bar ───
  const pendingInput = tab?.pendingInput
  useEffect(() => {
    if (pendingInput && activeTabId) {
      setInput(pendingInput)
      clearPendingInput(activeTabId)
      textareaRef.current?.focus()
    }
  }, [pendingInput, activeTabId, clearPendingInput])

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

  // Textarea sizing + multiline detection live in their own hook: a
  // self-contained DOM concern with its own hidden measurement node.
  useInputAutoResize({
    value: input,
    isMultiLine,
    setIsMultiLine,
    textareaRef,
    wrapperRef,
    metrics: {
      minHeight: INPUT_MIN_HEIGHT,
      maxHeight: INPUT_MAX_HEIGHT,
      multilineEnterHeight: MULTILINE_ENTER_HEIGHT,
      multilineExitHeight: MULTILINE_EXIT_HEIGHT,
      inlineControlsReservedWidth: INLINE_CONTROLS_RESERVED_WIDTH,
    },
  })

  // ─── Slash command detection ───
  const updateSlashFilter = useCallback((value: string) => {
    const match = value.match(/^(\/[a-zA-Z0-9_:-]*)$/)
    if (match) {
      setSlashFilter(match[1])
      setSlashIndex(0)
    } else {
      setSlashFilter(null)
    }
  }, [])

  // ─── Slash commands ───
  // The slash menu only sets the input text; the real dispatch happens
  // inside handleSend below, which hands the raw text (including any leading
  // "/") to the main process via window.ion.prompt (the single unified prompt IPC).
  // The unified prompt pipeline (desktop/src/main/prompt-pipeline.ts) owns
  // all slash routing: extension-command dispatch, .md template expansion,
  // and the /clear short-circuit for sessions that haven't started yet.
  // Slash commands are never sent to the LLM as a literal prompt.

  const handleSlashSelect = useCallback((cmd: SlashCommand) => {
    setInput(`${cmd.command} `)
    setSlashFilter(null)
    requestAnimationFrame(() => textareaRef.current?.focus())
  }, [])

  // ─── Send ───
  /**
   * `skipClearConfirm` is set only by the confirmation dialog's accept path, so
   * the second pass performs the send the operator already approved instead of
   * re-asking. Every other caller leaves it false.
   */
  const handleSend = useCallback((skipClearConfirm = false) => {
    if (showSlashMenu) {
      const filtered = getFilteredCommandsWithExtras(slashFilter!, extraCommands)
      if (filtered.length > 0) {
        handleSlashSelect(filtered[slashIndex])
        return
      }
    }
    // Bash command mode: execute directly and store result as pending context
    // (ordering and refusal rules live in InputBarBash.ts).
    if (bashMode) {
      dispatchBashCommand({
        command: input.trim(),
        bashExecuting,
        isConnecting,
        cwd: tab?.workingDirectory || '~',
        activeTabId,
        clearInput: () => {
          setInput('')
          if (textareaRef.current) {
            textareaRef.current.style.height = `${INPUT_MIN_HEIGHT}px`
          }
        },
        clearDraft: (tabId) => setDraftInput(tabId, ''),
        exitBashMode: () => setBashMode(false),
        startBashCommand,
        completeBashCommand,
        executeBash: (execId, cmd, cwd) => window.ion.executeBash(execId, cmd, cwd),
        onSettled: () => requestAnimationFrame(() => textareaRef.current?.focus()),
      })
      return
    }
    const prompt = input.trim()
    if (!prompt && attachments.length === 0) return

    // A command that clears the conversation is destructive from the operator's
    // seat: they typed a command and their history goes away. The engine does
    // the clear unconditionally and never asks (it does not block for user
    // input), so the confirmation has to happen here, before the prompt is
    // sent. resolveClearingCommand returns null whenever there is nothing to
    // lose or anything is uncertain — see its doc comment on failing open.
    if (!skipClearConfirm) {
      const clearing = resolveClearingCommand(prompt, {
        hasHistory: (resolveContextInputs(activeInstance(useSessionStore.getState().conversationPanes, activeTabId ?? '')).tokens ?? 0) > 0,
        commands: discoveredCommands,
      })
      if (clearing) {
        rInfo('input-bar', 'confirming clearing command before send', { command: clearing.command })
        setPendingClear(clearing)
        return
      }
    }

    // Decide, then clear, then submit — the ordering lives in dispatchSend
    // (InputBarSend.ts) so it is pinned by a unit test rather than by this
    // component's render path.
    //
    // Slash-command routing is NOT done here — see the "Slash commands" note
    // above: raw text (leading "/" included) goes to the main-process prompt
    // pipeline, which makes the desktop and remote (iOS) paths identical. The
    // `/clear` divider likewise comes back from the engine as an
    // engine_command_result event rather than being drawn locally.
    //
    // submit() is unified for EVERY tab — plain or extension-backed. No
    // tab-type fork: it reads tab.attachments internally and resolves the
    // tab's extensions from its profile (data).
    const outcome = dispatchSend(prompt, attachments.length, {
      getSnapshot: () => {
        const s = useSessionStore.getState()
        return {
          tabs: s.tabs,
          activeTabId: s.activeTabId,
          tabsReady: s.tabsReady,
        }
      },
      clearInput: () => {
        setInput('')
        setSlashFilter(null)
        if (textareaRef.current) {
          textareaRef.current.style.height = `${INPUT_MIN_HEIGHT}px`
        }
      },
      clearDraft: (tabId) => setDraftInput(tabId, ''),
      submit,
      // Put the text back when the authoritative guard refused it. The
      // pre-check above reads THIS window's store; in the Studio presentation
      // the owner decides, and only its answer is final.
      restoreInput: (text) => {
        setInput((prev) => (prev ? prev : text))
        const target = useSessionStore.getState().activeTabId
        if (target) setDraftInput(target, text)
      },
      warn: (msg, fields) => rWarn('input-bar', msg, fields),
    })
    if (!outcome.accepted) return
    // Refocus after React re-renders from the state update
    requestAnimationFrame(() => textareaRef.current?.focus())
  }, [input, submit, attachments.length, showSlashMenu, slashFilter, slashIndex, handleSlashSelect, bashMode, bashExecuting, tab?.workingDirectory, startBashCommand, completeBashCommand, extraCommands, isConnecting, activeTabId, setDraftInput, setBashMode, discoveredCommands])

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
      // Tab always completes from the menu (no-op when there are no matches).
      if (e.key === 'Tab') { e.preventDefault(); if (filtered.length > 0) handleSlashSelect(filtered[slashIndex]); return }
      // Enter: if the menu has a match, complete it. If the typed text matches
      // NO known command (filtered empty), do NOT swallow Enter — close the
      // menu and submit the raw text. The prompt pipeline forwards it to the
      // engine with resolveSlash=true; the engine resolves the template or
      // surfaces "Unknown command". Swallowing Enter here would make an
      // unknown/typed slash command unsendable.
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault()
        if (slashMenuEnterAction(filtered.length) === 'complete') {
          handleSlashSelect(filtered[slashIndex])
        } else {
          setSlashFilter(null)
          handleSend()
        }
        return
      }
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
          ? (initProgress || 'Initializing…')
          : voiceState === 'recording'
            ? 'Recording... ✓ to confirm, ✕ to cancel'
            : voiceState === 'transcribing'
              ? 'Transcribing...'
              : isBusy
                ? 'Type to queue a message...'
                : 'Ask Ion anything...'

  const sendVisible = canSend && voiceState !== 'recording'

  // A locked conversation (auto-generated conflict fix) accepts no further
  // prompts: its entire instruction is the one machine-sent message. Replace
  // the whole input surface with a static notice — rendering a disabled
  // textarea would look like a transient state the operator can wait out.
  // The store's submit() guard is the enforcement; this is the honest UI.
  if (tab?.inputLocked) {
    return (
      <div ref={wrapperRef} data-ion-ui data-testid="input-locked-notice" className="flex items-center w-full" style={{ minHeight: 50 }}>
        <span style={{ fontSize: 12, color: colors.textTertiary, paddingLeft: 2 }}>
          <InputLockNotice tab={tab} accent={colors.accent} />
        </span>
      </div>
    )
  }

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

      <ImageModelNotice visible={isImageModel} border={colors.containerBorder} text={colors.textTertiary} hasAttachments={hasAttachments} />

      <ContextCapacityNotice
        state={contextCapacityStatus}
        colors={colors}
        onNewConversation={() => window.dispatchEvent(new CustomEvent('ion:open-new-conversation-picker'))}
      />

      {/* Preview cards stay above conversation-scoped controls in both hosts. */}
      {hasAttachments && (
        <div style={{ paddingTop: 6, marginLeft: -6 }}>
          <AttachmentChips attachments={attachments} onRemove={removeAttachment} />
          <div
            data-testid="attachment-composer-divider"
            aria-hidden="true"
            style={{ borderTop: `1px solid ${colors.containerBorder}`, margin: '8px 0 0 6px' }}
          />
        </div>
      )}

      {/* Conversation-scoped controls stay with composer in both clients. */}
      <ComposerControls />

      {/* Single-line: inline controls. Multi-line: controls in bottom row */}
      <div className="w-full" style={{ minHeight: 50 }}>
        {isMultiLine ? (
          <div className="w-full">
            <textarea
              ref={textareaRef}
              value={input}
              onChange={handleInputChange}
              onKeyDown={handleKeyDown}
              onPaste={(e) => { void handlePaste(e).catch((err) => rError('InputBar', 'paste handler failed', { error: String(err) })) }}
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
              <UpdateButton />
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
              onPaste={(e) => { void handlePaste(e).catch((err) => rError('InputBar', 'paste handler failed', { error: String(err) })) }}
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
              <UpdateButton />
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

      {pendingClear && (
        <ConfirmDialog
          title="Clear the conversation first?"
          message={clearingCommandMessage(pendingClear.command)}
          confirmLabel="Clear and run"
          cancelLabel="Cancel"
          initialFocus="cancel"
          danger
          onConfirm={() => { setPendingClear(null); handleSend(true) }}
          onCancel={() => { rInfo('input-bar', 'operator declined a clearing command', { command: pendingClear.command }); setPendingClear(null) }}
        />
      )}
    </div>
  )
}
