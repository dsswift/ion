import Foundation
import CryptoKit
import Observation

// MARK: - SessionViewModel

@Observable
final class SessionViewModel {

    // MARK: - State

    /// Workspace-level resource accumulator (D-007). Populated by
    /// engineResourceSnapshot and engineResourceDelta events.
    let resourceStore = ResourceStore()

    /// Paged plan content assembler (plan gentle-perching-lemon). Populated
    /// by plan_content events in response to requestPlanContent commands.
    let planContentStore = PlanContentStore()

    /// Guided-questions replica (desktop_questions_state + snapshot merge).
    /// Stored property here — Swift extensions cannot add stored properties;
    /// command/reconciliation behavior is in SessionViewModel+Questions.swift.
    let questionsStore = QuestionsStore()

    var tabs: [RemoteTabState] = []
    var tabIds: Set<String> = []
    /// True once a desktop tab snapshot has been applied in this app run.
    ///
    /// Gates stale-destination detection. Before the first snapshot, an empty
    /// `tabIds` means "we have not been told yet", NOT "the tab is gone" — and
    /// the navigation stack can restore before that snapshot lands. Without
    /// this flag a validity check would eject the user from a live conversation
    /// during the pre-snapshot window, which is a worse failure than the stale
    /// shell it replaces and looks identical from the outside.
    ///
    /// Deliberately not derived from `connectionState`: that flips `.connected`
    /// on reconnect paths too, and on a reconnect it can be `.connected` while
    /// `tabs` still holds the previous session's list. Only an applied snapshot
    /// makes tab absence authoritative.
    var hasAppliedTabSnapshot = false
    /// The server transcript stream each conversation's rows come from, by
    /// tab. See SessionViewModel+Transcript.swift, the only writer of rows.
    var transcriptStreams: [String: TranscriptStream] = [:]
    /// Conversations whose newest page has been asked for and not answered.
    /// Patches for them are superseded by that page and are not applied.
    var transcriptResyncing: Set<String> = []
    /// Conversations with an older page asked for and not answered.
    var transcriptOlderInFlight: Set<String> = []
    /// Conversations whose finished run is spoken once their transcript,
    /// asked for because the phone did not hold it, arrives.
    var speechAwaitingTranscript: Set<String> = []
    /// Prompts this phone sent that the server has not made a row for yet,
    /// by tab. See SessionViewModel+PendingPrompts.swift.
    var pendingPrompts: [String: [Message]] = [:]
    /// Conversations whose newest page is being fetched (the view's spinner),
    /// and those whose fetch gave up (the view's retry banner).
    var loadingConversation: Set<String> = []
    var conversationLoadFailed: Set<String> = []
    var conversationLoadRetryCount: [String: Int] = [:]
    var conversationLoadTimers: [String: Task<Void, Never>] = [:]
    /// Tracks dismissed restored special cards (ExitPlanMode/AskUserQuestion from history)
    var dismissedRestoredCards: Set<String> = []
    /// Tracks tabs where a live special card was dismissed (prevents restoredSpecialCard re-trigger)
    var dismissedLiveSpecialTabs: Set<String> = []
    /// questionIds of promoted plan/question cards (`denied-*`) that at least one
    /// snapshot has carried. A `denied-*` entry is a projection of the desktop's
    /// permissionDenied; once a snapshot has vouched for it, the desktop's queue
    /// becomes authoritative, so a later snapshot that omits it means the desktop
    /// resolved the card (plan implemented / question answered / dismissed — on
    /// this device or another). The snapshot merge drops such a confirmed-then-
    /// omitted local entry instead of re-injecting it forever. An entry still in
    /// the live-forward → snapshot race is NOT yet in this set, so it survives.
    var snapshotConfirmedSpecialIds: Set<String> = []
    // Terminal state (per terminal tab)
    var terminalInstances: [String: [TerminalInstanceInfo]] = [:]  // tabId -> instances
    var activeTerminalInstance: [String: String] = [:]              // tabId -> active instanceId
    /// Local display name overrides for terminal instances (keyed by "tabId:instanceId").
    var terminalInstanceLabels: [String: String] = [:]
    // Engine state (per engine tab)
    var engineDialogs: [String: EngineDialogInfo?] = [:]
    var enginePinnedPrompt: [String: String] = [:]
    /// Dispatched agents' transcript rows, keyed by `dispatchKey` (and, for
    /// an agent with no registered dispatch, by agent name). Written only by
    /// SessionViewModel+DispatchTranscripts.swift, from the server's streams.
    var agentConversationMessages: [String: [Message]] = [:]
    /// Dispatch keys (and agent names) whose newest page is being fetched.
    var agentConversationLoading: Set<String> = []
    /// The server transcript stream each dispatch's rows come from.
    var dispatchStreams: [String: TranscriptStream] = [:]
    /// Dispatch keys whose newest page has been asked for and not answered.
    var dispatchResyncing: Set<String> = []
    /// The tab each dispatch stream was opened through (a resync asks again
    /// through the same tab).
    var dispatchTabs: [String: String] = [:]
    /// Agent name -> the dispatch keys whose rows, concatenated, are its
    /// transcript (an agent with no registered dispatch).
    var agentConversationGroups: [String: [String]] = [:]
    // Engine instance state (per engine tab)
    var conversationInstances: [String: [ConversationInstanceInfo]] = [:]   // tabId -> instances
    var activeEngineInstance: [String: String] = [:]              // tabId -> active instanceId
    /// Engine profiles synced from the server's settings.
    var engineProfiles: [EngineProfile] = []
    /// Available models from the server (dynamic list from engine).
    /// Falls back to default Claude models until the first snapshot with model data arrives.
    var availableModels: [RemoteModelEntry] = SessionViewModel.defaultModels

    /// The connected server's projected settings, shown on its settings
    /// pages and, for the phone's own keys, under This iPhone and You. Replaced
    /// wholesale on every `desktopSettingsSnapshot` event (snapshot
    /// semantics — never merge). `nil` while no server is paired or
    /// during the brief window before the first snapshot arrives on a
    /// new pairing.
    ///
    /// Per-server scoping: the field tracks only the currently-active
    /// pairing's settings. Switching to a different paired server
    /// clears the field via `switchToDevice`, and the new server's
    /// initial snapshot repopulates it.
    var serverSettings: ServerSettingsState? = nil

    /// Enterprise new-conversation policy projected from the server via
    /// `desktop_settings_snapshot.newConversationPolicy`. Non-nil + locked=true
    /// means `resolveNewConversationAction` must return `.locked` and iOS
    /// must skip all pickers. Nil means no enterprise config (or pre-#256
    /// desktop build — treat as unlocked).
    var enterpriseNewConversationPolicy: RemoteNewConversationPolicy? = nil


    /// The app's ThemeManager, wired by IonRemoteApp at launch (same
    /// pattern as appDelegate.sessionViewModel). Event handlers route
    /// `desktop_theme_manifest` / `desktop_theme_asset_content` into it so
    /// synced custom themes join the registry. Weak: the app owns it.
    weak var themeManager: ThemeManager?

    /// Default model list used before the desktop sends a dynamic list.
    static let defaultModels: [RemoteModelEntry] = [
        RemoteModelEntry(id: "claude-opus-4-7", providerId: "anthropic", label: "Opus 4.7", contextWindow: 1_000_000, hasAuth: true),
        RemoteModelEntry(id: "claude-opus-4-6", providerId: "anthropic", label: "Opus 4.6", contextWindow: 1_000_000, hasAuth: true),
        RemoteModelEntry(id: "claude-sonnet-4-6", providerId: "anthropic", label: "Sonnet 4.6", contextWindow: 200_000, hasAuth: true),
        RemoteModelEntry(id: "claude-haiku-4-5-20251001", providerId: "anthropic", label: "Haiku 4.5", contextWindow: 200_000, hasAuth: true),
    ]
    /// Active tool calls per tab, keyed by toolId.
    var activeTools: [String: [String: ActiveToolInfo]] = [:]
    /// Tab IDs that iOS has requested to close but hasn't received tab_closed confirmation for.
    var pendingCloseTabIds: Set<String> = []
    /// Timestamps when tabs transitioned to an idle/completed/failed/dead state (for "idle since" display).
    var tabIdleSince: [String: Date] = [:]

    // Git state (per working directory)
    var gitChanges: [String: GitChangesResponse] = [:]     // directory -> changes
    var gitBranches: [String: GitBranchesResponse] = [:]
    var pendingBranchRequest: String?
    var pendingBranchPickerRepo: String?
    var gitGraph: [String: GitGraphResponse] = [:]          // directory -> graph
    var gitDiffResult: GitDiffResponse? = nil
    var gitDiffLoading = false
    var gitCommitFiles: [String: GitCommitFilesResponse] = [:]  // keyed by hash
    var gitCommitFileDiff: [String: GitCommitFileDiffResponse] = [:]  // keyed by "hash:path"
    var gitToast: GitToast? = nil

    // Worktree + integration bench state. Accessors and the state shape live
    // in SessionViewModel+WorktreeState.swift (this file is at its size cap).
    var worktreeUI = WorktreeUIState()

    // FR-02 presence state. Accessors and the state shape live in
    // SessionViewModel+Presence.swift.
    var presenceUI = PresenceUIState()

    // The connected Environment's load. Accessors live in
    // SessionViewModel+SystemMetrics.swift.
    var systemMetricsUI = SystemMetricsUIState()

    // File explorer state (per directory/path)
    var fileListings: [String: FsDirListingResponse] = [:]   // directory -> listing
    var fileContent: [String: FsFileContentResponse] = [:]    // filePath -> content
    var fileWriteResult: FsWriteResultResponse? = nil
    /// Latest result of an `fsRename` command. Observed by
    /// `FileExplorerRowView` to surface error alerts (the success path
    /// is handled by the event handler triggering a fresh
    /// `requestFsListDir` on the parent directory; the view doesn't
    /// need to read this for the happy path).
    var fileRenameResult: FsRenameResultResponse? = nil
    var fileListingLoading: Set<String> = []
    var fileContentLoading: Set<String> = []

    // Tab attachment cache (from load_attachments command)
    var tabAttachmentCache: [String: [TabAttachmentEntry]] = [:]  // tabId -> attachments

    /// Each conversation's branches (`listBranches`), the leaf a switch is
    /// waiting on, and the last refusal. See SessionViewModel+Branches.swift.
    var conversationBranches: [String: ConversationBranches] = [:]
    var branchSwitchPending: [String: String] = [:]
    var branchSwitchError: [String: String] = [:]

    // Discovered slash commands (per working directory)
    var discoveredCommands: [String: [DiscoveredSlashCommand]] = [:]

    /// Extension-registered slash commands from engine_command_registry events.
    /// Keyed by engine session key (tabId or "tabId:instanceId") — mirrors the
    /// desktop's `extensionCommandsByKey` in engine-event-slice.ts.
    /// Snapshot semantics: every event REPLACES the prior entry for that key.
    var extensionCommands: [String: [EngineCommandListing]] = [:]

    // Upload attachment results (consumed by InputBar / ConversationView)
    var pendingUploadResults: [UploadAttachmentResult] = []

    /// Pending /export payload waiting to be presented via the iOS share
    /// sheet. Populated by handleEngineExport on engine_export receipt;
    /// cleared by the view layer after the sheet is dismissed.
    ///
    /// Nil when no export is awaiting presentation. The view layer
    /// observes this property and presents the share sheet whenever it
    /// flips non-nil; the dismissal sets it back to nil.
    var pendingExport: PendingExport? = nil

    /// Coordinates the latest transcript clipboard request and its timeout.
    let transcriptCopyCoordinator = TranscriptCopyCoordinator()

    // MARK: - Toast Messages
    var toastMessages: [ToastMessage] = []
    /// Exact task IDs with a stop request awaiting an authoritative result.
    var stoppingBackgroundTaskIds: Set<String> = []


    var pairedDevices: [PairedDevice] = []
    var connectionState: ConnectionState = .disconnected
    var pairingState: PairingState = .idle
    /// One OIDC token manager per paired desktop, keyed by device ID.
    ///
    /// A phone can be paired with desktops that authenticate against different
    /// identity tenants through different relays, so the credential state is
    /// per-pairing: separate issuer, client ID, cached token, and Keychain
    /// refresh token. Assigned in `init()` because the identity callback needs
    /// `self`.
    private(set) var oidcRegistry: OIDCTokenManagerRegistry!

    /// Pairings the relay refused because the channel is bound to a different
    /// OIDC subject (HTTP 403).
    ///
    /// Distinct from an expired credential: refreshing returns the same subject,
    /// so retrying can never succeed. The transport stops for these pairings and
    /// the UI offers "Switch Account" instead of spinning a backoff ladder.
    var relayIdentityMismatch: Set<String> = []

    /// Blocks deferred until the transport reaches `.connected` (i.e. the
    /// first snapshot has arrived and confirmed the round-trip works).
    /// Populated by `runWhenConnected(_:)` and drained inside
    /// `handleSnapshot` when `connectionState` flips to `.connected`. Also
    /// cleared by `disconnect()` so a hard reset wipes pending work.
    ///
    /// Exists to fix the iOS resume race: scene `.active` fires
    /// auto-resume commands (`requestAllGitChanges`, `sendReportFocus`)
    /// before the LAN/relay handshake completes, which otherwise produces
    /// spurious "Not connected" / "Send failed" toasts. See
    /// `SessionViewModel+OnConnected.swift` for the helper and
    /// `IonRemoteApp.swift`'s `.active` handler for the call sites.
    var pendingOnConnected: [() -> Void] = []

    /// Keyed deferred queue for `.automaticEssential` sends that arrive
    /// while the transport is not yet `.connected`.
    ///
    /// Keys are stable command-identity strings (e.g. `"loadConversation:<tabId>"`,
    /// `"requestTerminalSnapshot:<tabId>"`, `"sync"`, `"gitChanges:<dir>"`).
    /// Last-write-wins: enqueueing the same key again supersedes the prior
    /// entry so a stale load intent from a tab the user navigated away from
    /// does not replay against the next transport.
    ///
    /// Drained once per `.connected` transition by `drainPendingEssential()`
    /// (called from `handleSnapshot`, next to `drainPendingOnConnected()`).
    /// Cleared by `clearPendingEssential()` on hard disconnect so stale
    /// intent from one desktop does not fire against a different pairing.
    ///
    /// Separate from `pendingOnConnected` (the closure-run-all queue) so
    /// the dedup semantics are explicit and the two queues can evolve
    /// independently. See `SessionViewModel+OnConnected.swift`.
    var pendingEssentialQueue: [(key: String, command: RemoteCommand)] = []

    /// Which desktop is currently selected (persisted in UserDefaults).
    /// Selecting a pairing is what attributes log lines to it, so the log's
    /// pairing stamp moves with this value rather than with any one connect
    /// path.
    var activeDeviceId: String? {
        get { UserDefaults.standard.string(forKey: DiagnosticLog.selectedPairingDefaultsKey) }
        set {
            UserDefaults.standard.set(newValue, forKey: DiagnosticLog.selectedPairingDefaultsKey)
            DiagnosticLog.setPairingId(newValue)
        }
    }

    /// The currently active paired device, falling back to the first device.
    var activeDevice: PairedDevice? {
        if let id = activeDeviceId {
            return pairedDevices.first { $0.id == id } ?? pairedDevices.first
        }
        return pairedDevices.first
    }

    /// True once we've received at least one snapshot (enables cached layout restoration).
    var hasConnectedBefore: Bool = false

    /// Online status of non-active paired devices (from relay polling).
    /// Key: device ID. Value: true=online, false=offline, nil=unknown/error.
    var deviceOnlineStatus: [String: Bool?] = [:]
    /// Background task for periodic device status polling.
    var deviceStatusTask: Task<Void, Never>?

    /// Recent base directories from the desktop, updated via snapshot events.
    var recentDirectories: [String] = []
    /// Desktop-owned projects for New Conversation. Replaced by each snapshot.
    var projects: [RemoteProject] = []
    /// Exact timestamp of the layout snapshot restored or received per pairing.
    /// Used for stale-data disclosure; never used to infer authority.
    var lastSynchronizedAt: [String: Date] = [:]
    /// Pairing-aware external destination (APNs / future deep links). It is held
    /// while desktop data is locked and released only by that pairing's
    /// authenticated snapshot.
    var pendingExternalNavigation: (deviceId: String, tabId: String)?
    /// Tab ID to auto-navigate to after remote creation.
    var pendingNavigationTabId: String? = nil
    /// The screen an `ion://` link opened, presented at the app root. Set and
    /// cleared by SessionViewModel+DeepLink.swift.
    var deepLinkPresentation: DeepLinkPresentation? = nil
    /// Tab ID to auto-open the Git pane for (set by tapping the branch badge in tab list).
    /// Observed by ConversationView; cleared after the pane is presented.
    var pendingGitPaneTabId: String? = nil
    /// Dispatch ID to auto-open in AgentDetailFullScreenView after the conversation view
    /// appears. Mirrors the pendingNavigationTabId deep-link pattern. Set by
    /// StatusDrawerView when the user taps a running dispatch row; cleared after the
    /// fullScreenCover is presented. ConversationView observes via .onChange and opens
    /// AgentDetailFullScreenView for the specific dispatchId, reconstructing the ancestor
    /// breadcrumb chain before presenting (plan modest-leaping-waffle §9a).
    var pendingDispatchId: String? = nil
    /// The currently focused tab ID — the tab the user is viewing right now.
    /// Updated by TabListView whenever the selected/navigated tab changes and
    /// cleared when the app backgrounds. The desktop reads this via `report_focus`
    /// commands to route engine_intercept events to the correct device+tab.
    var focusedTabId: String? = nil
    /// In-flight tab-create commands awaiting a `desktop_tab_created` echo,
    /// keyed by the `clientCmdId` attached to each create command.
    ///
    /// A create can be silently lost: after a background/resume cycle the LAN
    /// socket can report connected while actually being dead, so `lan.send`
    /// succeeds locally and the frame never reaches the desktop — nothing
    /// throws, so the essential-queue/requeue paths never fire. This tracker
    /// closes that hole: each create is recorded here, resent on a timeout and
    /// on the next `.connected` transition, and cleared when the desktop echoes
    /// the id back (`confirmCreate`). The matching echo also drives navigation
    /// to the new tab (it replaces the former `awaitingLocalTabCreation` flag).
    /// Cleared on hard disconnect so a stale create never spawns a tab against a
    /// different pairing. See `SessionViewModel+PendingCreate.swift`.
    var pendingCreates: [String: PendingCreate] = [:]
    /// Per-tab unsent input text. Persisted to UserDefaults across launches.
    /// Keyed by bare `tabId` for both plain and engine tabs (the single unified
    /// draft store, post-#256). Updated on every keystroke via the InputBar
    /// binding. See SessionViewModel+Drafts.swift.
    var draftInputByTab: [String: String] = [:]
    /// Pending debounced `desktop_set_draft` sends, one per conversation.
    /// Replacing an entry cancels the previous keystroke's send, so a burst of
    /// typing produces one frame per pause. See SessionViewModel+Drafts.swift.
    var draftSendWork: [String: DispatchWorkItem] = [:]
    /// Whether to show the branch/ahead/behind row in the tab list (off by default).
    var showGitInfoInTabList: Bool {
        get { UserDefaults.standard.bool(forKey: "showGitInfoInTabList") }
        set { UserDefaults.standard.set(newValue, forKey: "showGitInfoInTabList") }
    }

    /// Whether to tint tab rows with their configured pill color (on by default).
    /// iOS-only preference — does not affect desktop. When disabled the tab list
    /// renders without any color tinting regardless of what the desktop has set.
    var showTabColorInTabList: Bool {
        get { UserDefaults.standard.object(forKey: "showTabColorInTabList") == nil
              ? true
              : UserDefaults.standard.bool(forKey: "showTabColorInTabList") }
        set { UserDefaults.standard.set(newValue, forKey: "showTabColorInTabList") }
    }

    /// APNs device token (set by AppDelegate on registration success).
    var apnsToken: String?

    // MARK: - Settings (persisted via paired device)

    var relayURL: String = ""
    var relayAPIKey: String = ""

    // MARK: - Connection Quality

    let connectionQuality = ConnectionQuality()
    let connectionHealth = ConnectionHealth()

    // MARK: - Transport

    var transportState: TransportState { transport?.state ?? .disconnected }

    /// The developer surfaces the connected server offers. Views show no
    /// control for one that is off.
    var developerSurfaces: DeveloperSurfaces { transport?.developerSurfaces ?? .allEnabled }

    /// The live transport. Every path that builds one assigns it here, so
    /// this is the single place that guarantees log lines written while a
    /// transport exists carry the pairing that transport serves — the same id
    /// the diagnostic export filters on. Clearing the transport keeps the
    /// stamp: lines written while suspended still belong to that pairing.
    var transport: (any RemoteTransport)? {
        didSet {
            guard let deviceId = transport?.deviceId else { return }
            DiagnosticLog.setPairingId(deviceId)
        }
    }
    /// One admin session per paired server a settings page has opened, keyed
    /// by the server's `clientId`. See `SessionViewModel+ServerAdmin.swift`.
    @ObservationIgnored var adminSessionsByServer: [String: ServerAdminSession] = [:]
    /// A diagnostic log upload is sending; another request waits for the next pull.
    @ObservationIgnored var diagnosticUploadInFlight = false
    var eventTask: Task<Void, Never>?
    var flushTask: Task<Void, Never>?
    /// Safety timer: if `.reconnecting` lingers too long, force a full reconnect.
    var reconnectSafetyTask: Task<Void, Never>?
    let eventBatcher = EventBatcher()
    /// Standalone browser for pairing discovery (before a transport exists).
    private(set) var pairingBrowser = BonjourBrowser()

    // MARK: - Computed

    func tab(for id: String) -> RemoteTabState? {
        tabs.first { $0.id == id }
    }

    /// The desktop's `defaultEngineProfileId` preference, projected via
    /// `desktopSettingsSnapshot`. Non-empty means the user has chosen a
    /// default engine profile; empty means "unset" (show the picker).
    /// Matches how `resolveNewConversationAction` reads `defaultId`.
    var defaultEngineProfileId: String {
        (serverSettings?.currentValue(for: "defaultEngineProfileId")?.value as? String) ?? ""
    }

    // MARK: - Voice

    let voiceService = VoiceService()
    /// The last voice configuration delivered on the current connection; nil
    /// until one is sent. `tearDownTransport` clears it so the next
    /// connection hears the configuration once.
    var lastSentVoiceConfig: VoiceService.WireConfig?
    /// Dictation. A `var` so a test can drive the composer's dictation flow
    /// against a fake speech engine; the app never reassigns it.
    var speechService = SpeechRecognitionService()

    // MARK: - Toast

    @MainActor
    func showToast(_ message: ToastMessage) {
        toastMessages.append(message)
        // Cap at 2 visible; drop oldest if exceeded.
        if toastMessages.count > 2 {
            toastMessages.removeFirst(toastMessages.count - 2)
        }
        let id = message.id
        Task { @MainActor [weak self] in
            // Only CancellationError can surface and this untracked task is never cancelled; the toast is dismissed either way.
            // swiftlint:disable:next silent_try_optional
            try? await Task.sleep(for: .seconds(message.duration))
            self?.dismissToast(id: id)
        }
    }

    @MainActor
    func dismissToast(id: UUID) {
        toastMessages.removeAll { $0.id == id }
    }

    // MARK: - Init
    // Draft persistence methods live in SessionViewModel+Drafts.swift.

    init() {
        // Built before any pairing is loaded so no connect path can observe a
        // nil registry. The identity callback hops to the MainActor because it
        // fires from the token actor's parsing path.
        self.oidcRegistry = OIDCTokenManagerRegistry(onIdentity: { [weak self] deviceId, identity in
            Task { @MainActor [weak self] in
                self?.applyOIDCIdentity(deviceId: deviceId, identity: identity)
            }
        })
        loadPairedDevices()
        // The logger seeds its stamp from the persisted selection. When no
        // selection is persisted the active device falls back to the first
        // paired one, which only this model can resolve.
        DiagnosticLog.setPairingId(activeDevice?.id)
        // Restore hasConnectedBefore from UserDefaults
        hasConnectedBefore = UserDefaults.standard.bool(forKey: "hasConnectedBefore")
        hydrateDrafts()
    }
}
