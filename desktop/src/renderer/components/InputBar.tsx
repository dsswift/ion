import React, { useState, useRef, useCallback, useEffect, useMemo } from 'react'
import { AnimatePresence } from 'framer-motion'
import { create } from 'zustand'
import { useSessionStore } from '@ion/server/store/sessionStore'
import { activeInstance } from '@ion/server/store/conversation-instance'
import { resolveClearingCommand, clearingCommandMessage, type ClearingCommandPrompt } from './InputBarClearingCommand'
import { resolveContextInputs } from './context-usage'
import { ConfirmDialog } from './git/ConfirmDialog'
import { AttachmentChips } from './AttachmentChips'
import { SlashCommandMenu, getFilteredCommandsWithExtras, slashMenuEnterAction, ExtensionCommandIcon, type SlashCommand } from './SlashCommandMenu'
import { useColors } from '../theme'
import { usePreferencesStore } from '../preferences'
import { selectedConversationModel } from '@ion/shared/conversation-model'
import type { DiscoveredCommand } from '@ion/shared/types'
import { getRendererExtensionCommands } from '@ion/server/store/slices/engine-event-slice'
import { useVoiceRecording, VoiceButtons } from './InputBarVoiceButton'
import { SendButton } from './InputBarSendButton'
import { UpdateButton } from './UpdateButton'
import { rDebug, rInfo, rWarn } from '../rendererLogger'
import { dispatchSend } from './InputBarSend'
import { queueForSpareQuota, sendThenNew } from './composer-send-modes'
import { submitWithTrace } from '../lib/prompt-trace'
import { dispatchBashCommand, createHostExecuteBash } from './InputBarBash'
import { useModelStore } from '@ion/server/store/model-store'
import { useActiveTabEnvironmentId } from '../studio/connection/tab-environment'
import { LOCAL_ENVIRONMENT_ID } from '@ion/shared/types-environments'
import { useEnvironmentAvailabilityMap } from '../studio/connection/environment-availability'
import { EnvironmentReconnectingNotice } from '../studio/connection/EnvironmentUnavailable'
import { useActiveContextCapacity } from '../hooks/useActiveContextCapacity'
import { ComposerControls } from './ComposerControls'
import { ComposerStopButton } from './composer/ComposerStopButton'
import { InputLockNotice } from './InputLockNotice'
import { ContextCapacityNotice } from './ContextCapacityNotice'
import { ImageModelNotice } from './ImageModelNotice'
import { ManagedModeNotice } from './ManagedModeNotice'
import { usePresenceStore, drivingSubjectFor } from '../stores/presence-store'
import { INPUT_MAX_HEIGHT, INPUT_MIN_HEIGHT } from './input-bar-layout'
import { ComposerEditor, type ComposerEditorHandle } from './composer/ComposerEditor'
import { useComposerIntake } from './composer/useComposerIntake'
import { useComposerMentions } from './composer/useComposerMentions'
import { useComposerHistory } from './composer/useComposerHistory'
import { useComposerStash } from './composer/useComposerStash'
import { useComposerDraft } from './composer/useComposerDraft'
import { ComposerStashButton } from './composer/ComposerStashButton'
import { useComposerContextSync } from './composer/useComposerContextSync'
import { ComposerMentionMenu } from './composer/ComposerMentionMenu'
import { mentionedPaths, resolveMentionAttachments } from './composer/composer-mentions'
import { host } from '../host/host-instance'
/** Shared transient state for bash command mode (consumed by App.tsx for pill styling) */
export const useBashModeStore = create<{ active: boolean; set: (v: boolean) => void }>((set) => ({
  active: false,
  set: (v) => set({ active: v }),
}))

/**
 * InputBar renders inside the rounded composer shell StudioCenter provides.
 * Top to bottom: notices, attachment previews, the prompt text, then one
 * control row (ComposerControls) that also carries the mic/stop/send buttons.
 */
export function InputBar() {
  const [input, setInput] = useState('')
  const [slashFilter, setSlashFilter] = useState<string | null>(null)
  const [slashIndex, setSlashIndex] = useState(0)
  const bashMode = useBashModeStore((s) => s.active)
  const setBashMode = useBashModeStore((s) => s.set)
  const editorRef = useRef<ComposerEditorHandle>(null)
  // Drops, pasted files, and oversized pastes all become attachments.
  const { handlePaste, noteKeyDown } = useComposerIntake()
  const wrapperRef = useRef<HTMLDivElement>(null)

  const submit = useSessionStore((s) => s.submit)
  // (clearTab/addSystemMessage/addEngineSystemMessage were used by the
  // pre-pipeline renderer slash dispatch; they remain available on the
  // store and are now driven by engine_command_result subscribers in
  // engine-event-slice.ts.)
  const startBashCommand = useSessionStore((s) => s.startBashCommand)
  const completeBashCommand = useSessionStore((s) => s.completeBashCommand)
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
  // The conversation's server decides the model; this client's own default
  // model says nothing about a conversation on another server.
  const effectiveModelId = useSessionStore((s) => selectedConversationModel(activeInstance(s.conversationPanes, s.activeTabId ?? '')))
  // The model is looked up in the active conversation's Environment (ADR-033).
  const inputEnvironmentId = useActiveTabEnvironmentId()
  const environmentEntry = useEnvironmentAvailabilityMap().get(inputEnvironmentId)
  const environmentAvailability = environmentEntry?.availability ?? 'connected'
  const environmentLabel = environmentEntry?.label ?? inputEnvironmentId
  const findModelIn = useModelStore((s) => s.findModelIn)
  const isModelCliServedIn = useModelStore((s) => s.isModelCliServedIn)
  const findModel = useCallback((id: string) => findModelIn(inputEnvironmentId, id), [findModelIn, inputEnvironmentId])
  const isModelCliServed = useCallback((id: string) => isModelCliServedIn(inputEnvironmentId, id), [isModelCliServedIn, inputEnvironmentId])
  const { state: contextCapacityStatus } = useActiveContextCapacity(effectiveModelId)
  const isImageModel = effectiveModelId !== '' && findModel(effectiveModelId)?.modelKind === 'image'
  const isBusy = tab?.status === 'running' || tab?.status === 'connecting'
  // FR-02 shared-tenancy presence: another connection started this tab's
  // in-flight run. Feeds the placeholder ladder below, same mechanism as
  // every other busy-state notice this bar already shows.
  const presenceDriving = usePresenceStore((s) => s.driving)
  const presenceEntries = usePresenceStore((s) => s.entries)
  const ownSubject = usePresenceStore((s) => s.ownSubject)
  const drivenBySubject = activeTabId ? drivingSubjectFor(presenceDriving, ownSubject, activeTabId) : null
  const drivenByName = drivenBySubject
    ? (presenceEntries.find((e) => e.subject === drivenBySubject)?.displayName ?? drivenBySubject)
    : null
  const isConnecting = tab?.status === 'connecting' || !tabsReady
  // There is no way to steer a compaction in progress — a queued prompt
  // cannot interrupt or redirect it — so sending is refused outright rather
  // than queued (see shared/prompt-acceptance.ts, the same predicate submit()
  // enforces authoritatively).
  const isCompacting = tab?.isCompacting ?? false
  const hasContent = input.trim().length > 0 || (tab?.attachments?.length ?? 0) > 0
  const canSend = !!tab && !isConnecting && !isCompacting && hasContent
  // Memoised because a bare `tab?.attachments || []` mints a new array on
  // every render, which changes the identity of every hook that depends on
  // it — including the keydown handler below, which would then be rebuilt
  // and re-bound on each keystroke.
  const attachments = useMemo(() => tab?.attachments || [], [tab?.attachments])
  const showSlashMenu = slashFilter !== null && !isConnecting
  const [discoveredCommands, setDiscoveredCommands] = useState<DiscoveredCommand[]>([])
  // A clearing command the operator submitted but has not confirmed yet. Held
  // here so the send is not performed until they accept losing the history.
  const [pendingClear, setPendingClear] = useState<ClearingCommandPrompt | null>(null)
  const workingDir = tab?.workingDirectory || '~'
  // `@file` mentions are prompt text; a bash command line has none.
  const mentions = useComposerMentions(editorRef, workingDir, !bashMode)
  const stagingMentionsRef = useRef(false)
  const historyKeyDown = useComposerHistory(editorRef, activeTabId, input, setInput)
  const stash = useComposerStash(tab, input, attachments, setInput)
  // Terminal and diff context: each chip stays paired with its attachment.
  useComposerContextSync(editorRef, activeTabId, input, attachments, setInput)
  const addAttachments = useSessionStore((s) => s.addAttachments)

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
    host.shell.discoverCommands(workingDir).then((cmds) => {
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
  // The draft is durable conversation state, not window state: useComposerDraft
  // commits it to the owning server as it is typed (debounced, flushed on
  // switch and teardown) and adopts the stored one when a conversation opens.
  // That is what lets a half-written prompt survive a quit.
  const onAdoptDraft = useCallback(() => setSlashFilter(null), [])
  useComposerDraft(activeTabId, tabsReady, input, setInput, onAdoptDraft)

  // Focus and bash-mode reset belong to the switch itself, not to the draft.
  useEffect(() => {
    editorRef.current?.focus()
    setBashMode(false)
  }, [activeTabId, setBashMode])

  // ─── Rewind: restore user message to input bar ───
  const pendingInput = tab?.pendingInput
  useEffect(() => {
    if (pendingInput && activeTabId) {
      setInput(pendingInput)
      clearPendingInput(activeTabId)
      editorRef.current?.focus()
    }
  }, [pendingInput, activeTabId, clearPendingInput])

  // Focus textarea when window is shown (shortcut toggle, screenshot return)
  // Skip if focus is inside the terminal panel (xterm manages its own focus)
  useEffect(() => {
    // No concept of "window shown" for a browser tab (see StudioHost.ts's
    // 'windowShown' doc).
    if (!host.capabilities().includes('windowShown')) return
    const unsub = host.shell.onWindowShown(() => {
      const active = document.activeElement
      if (active && active.closest('.xterm')) return
      editorRef.current?.focus()
    })
    return unsub
  }, [])

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
  // "/") to the server via host.shell.prompt (the single unified prompt call).
  // The server's unified prompt pipeline owns
  // all slash routing: extension-command dispatch, .md template expansion,
  // and the /clear short-circuit for sessions that haven't started yet.
  // Slash commands are never sent to the LLM as a literal prompt.

  const handleSlashSelect = useCallback((cmd: SlashCommand) => {
    setInput(`${cmd.command} `)
    setSlashFilter(null)
    requestAnimationFrame(() => editorRef.current?.focus())
  }, [])

  // ─── Send ───
  /**
   * `skipClearConfirm` is set only by the confirmation dialog's accept path, so
   * the second pass performs the send the operator already approved instead of
   * re-asking. Every other caller leaves it false. `thenNew` is a background
   * send: once accepted, the window moves to a fresh conversation like this one.
   */
  const handleSend = useCallback((skipClearConfirm = false, thenNew = false) => {
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
        clearInput: () => setInput(''),
        clearDraft: (tabId) => setDraftInput(tabId, ''),
        exitBashMode: () => setBashMode(false),
        startBashCommand,
        completeBashCommand,
        executeBash: createHostExecuteBash(host),
        onSettled: () => requestAnimationFrame(() => editorRef.current?.focus()),
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
    const dispatch = (attachmentCount: number): void => {
      const outcome = dispatchSend(prompt, attachmentCount, {
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
        },
        clearDraft: (tabId) => setDraftInput(tabId, ''),
        // The prompt's trace starts here: submitWithTrace opens its client span.
        submit: (tabId, text) => submitWithTrace(submit, tabId, text, useSessionStore.getState().tabs.find((t) => t.id === tabId)?.conversationId),
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
      if (thenNew) sendThenNew(outcome.tabId)
      // Refocus after React re-renders from the state update
      requestAnimationFrame(() => editorRef.current?.focus())
    }

    // A mentioned file rides along as an attachment so the model receives its
    // content, not only its name. Staging finishes before the send so the
    // owner's submit() reads a tray that already holds the files.
    if (mentionedPaths(prompt).length === 0) { dispatch(attachments.length); return }
    // Staging is async; a second Enter during it must not send twice.
    if (stagingMentionsRef.current) return
    stagingMentionsRef.current = true
    void resolveMentionAttachments(prompt, workingDir, attachments, (path) => host.shell.attachFileByPath(activeTabId, path))
      .then(({ attachments: mentioned, unresolved }) => {
        if (unresolved.length > 0) rDebug('input-bar', 'mentions left as text: no such file', { count: unresolved.length })
        if (mentioned.length > 0) addAttachments(mentioned)
        dispatch(attachments.length + mentioned.length)
      })
      .finally(() => { stagingMentionsRef.current = false })
  }, [input, submit, attachments, workingDir, addAttachments, showSlashMenu, slashFilter, slashIndex, handleSlashSelect, bashMode, bashExecuting, tab?.workingDirectory, startBashCommand, completeBashCommand, extraCommands, isConnecting, activeTabId, setDraftInput, setBashMode, discoveredCommands])

  // ─── Keyboard ───
  // Returns true when the key was handled here, which stops the editor's own
  // keymap from also acting on it.
  const handleKeyDown = (e: KeyboardEvent): boolean => {
    // An IME composition owns Enter until it commits.
    if (e.isComposing) return false
    noteKeyDown(e)
    if (mentions.handleKeyDown(e)) return true
    if (stash.handleKeyDown(e)) return true
    // Exit bash mode on backspace when input is empty
    if (bashMode && e.key === 'Backspace' && input === '') {
      e.preventDefault()
      setBashMode(false)
      return true
    }
    if (showSlashMenu) {
      const filtered = getFilteredCommandsWithExtras(slashFilter!, extraCommands)
      if (e.key === 'ArrowDown') { e.preventDefault(); setSlashIndex((i) => (i + 1) % filtered.length); return true }
      if (e.key === 'ArrowUp') { e.preventDefault(); setSlashIndex((i) => (i - 1 + filtered.length) % filtered.length); return true }
      // Tab always completes from the menu (no-op when there are no matches).
      if (e.key === 'Tab') { e.preventDefault(); if (filtered.length > 0) handleSlashSelect(filtered[slashIndex]); return true }
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
        return true
      }
      if (e.key === 'Escape') { e.preventDefault(); setSlashFilter(null); return true }
    }
    if (!bashMode && historyKeyDown(e)) return true
    // Cmd/Ctrl+Enter sends in the background; with Shift it queues the prompt for spare quota.
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !bashMode) {
      e.preventDefault()
      if (!e.shiftKey) handleSend(false, true)
      else void queueForSpareQuota(activeTabId, input).then((held) => { if (held) { setInput(''); if (activeTabId) setDraftInput(activeTabId, '') } })
      return true
    }
    // Enter sends; Shift+Enter falls through to the editor and inserts a line.
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend(); return true }
    return false
  }

  const handleInputChange = (value: string) => {
    // Enter bash mode when ! is typed as first character on empty input
    if (!bashMode && bashCommandEntry && value === '!') {
      setBashMode(true)
      setInput('')
      return
    }
    setInput(value)
    if (!bashMode) updateSlashFilter(value)
  }

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
              : isCompacting
                ? 'Compacting… try again in a moment'
                : isBusy
                  ? (drivenByName ? `${drivenByName} is running a turn — type to queue a message...` : 'Type to queue a message...')
                  : 'Ask Ion anything...'

  const sendVisible = canSend && voiceState !== 'recording'

  // A locked conversation (auto-generated conflict fix) accepts no further
  // prompts: its entire instruction is the one machine-sent message. Replace
  // the whole input surface with a static notice — rendering a disabled
  // textarea would look like a transient state the operator can wait out.
  // The store's submit() guard is the enforcement; this is the honest UI.
  // A conversation on a machine this desktop cannot reach takes no input.
  // The composer is replaced rather than disabled for the same reason the
  // lock below replaces it: a greyed-out textarea reads as a moment to wait
  // out, and anything typed into it would be a prompt aimed at state that
  // may already have moved.
  if (inputEnvironmentId !== LOCAL_ENVIRONMENT_ID && environmentAvailability !== 'connected') {
    return (
      <div ref={wrapperRef} data-ion-ui className="flex items-center w-full" style={{ minHeight: 50 }}>
        <EnvironmentReconnectingNotice label={environmentLabel} availability={environmentAvailability} />
      </div>
    )
  }

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

      {mentions.active && (
        <ComposerMentionMenu
          results={mentions.results}
          selectedIndex={mentions.index}
          anchorRect={wrapperRef.current?.getBoundingClientRect() ?? null}
          onPick={mentions.pick}
        />
      )}

      <ManagedModeNotice colors={colors} />

      <ImageModelNotice visible={isImageModel} border={colors.containerBorder} text={colors.textTertiary} hasAttachments={hasAttachments} />

      <ContextCapacityNotice
        state={contextCapacityStatus}
        servedByCli={isModelCliServed(effectiveModelId)}
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

      {/* Prompt text on top; the one control row sits underneath it. */}
      <ComposerEditor
        ref={editorRef}
        value={input}
        onChange={handleInputChange}
        onKeyDown={handleKeyDown}
        onPaste={handlePaste}
        onCursorActivity={(offset) => mentions.track(editorRef.current?.getValue() ?? '', offset)}
        placeholder={placeholder}
        minHeight={INPUT_MIN_HEIGHT}
        maxHeight={INPUT_MAX_HEIGHT}
      />

      <ComposerControls
        actions={(
          <>
            <ComposerStashButton entries={stash.entries} onRestore={stash.restore} onRemove={stash.remove} />
            <UpdateButton />
            <VoiceButtons
              voiceState={voiceState}
              isConnecting={isConnecting}
              colors={colors}
              onToggle={toggleRecording}
              onCancel={cancelRecording}
              onStop={stopRecording}
            />
            <ComposerStopButton />
            <SendButton visible={sendVisible} isBusy={isBusy} colors={colors} onClick={handleSend} />
          </>
        )}
      />

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
