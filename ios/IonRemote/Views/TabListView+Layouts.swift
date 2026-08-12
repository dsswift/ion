import SwiftUI

// TabListView's two size-class layout roots extracted to keep
// TabListView.swift under the Swift 600-line cap (see ios/AGENTS.md →
// file-architecture rules). Moved verbatim from TabListView, then retinted:
// both roots now paint `theme.background` so the tab list renders on the
// theme's surface instead of the system background. The `@State` properties
// they read (navigationPath, columnVisibility, flickerOpacity, showSettings,
// showNotifications, showPairingSheet, searchText) are declared internal (not
// private) on TabListView so this same-module extension can reach them,
// matching the TabListView+Helpers and +DetailViews extraction pattern.
extension TabListView {
    // MARK: - iPad Layout (NavigationSplitView)

    var iPadLayout: some View {
        NavigationSplitView(columnVisibility: $columnVisibility) {
            sidebarContent
                // Both split-view columns paint the theme surface themselves.
                // The columns resolve their backgrounds separately, so a single
                // modifier on the NavigationSplitView would leave the other
                // column on the system background.
                .background(theme.background.ignoresSafeArea())
                .searchable(text: $searchText, placement: .navigationBarDrawer(displayMode: .always), prompt: "Search tabs…")
                .navigationTitle("")
                .toolbar {
                    // Separate items, not a grouped HStack — same reasoning as
                    // the iPhone layout below.
                    ToolbarItem(placement: .topBarLeading) {
                        Button {
                            showSettings = true
                        } label: {
                            Image(systemName: "gearshape")
                        }
                    }
                    ToolbarItem(placement: .topBarLeading) {
                        NotificationsBellButton(resourceStore: viewModel.resourceStore) {
                            showNotifications = true
                        }
                    }
                    ToolbarItem(placement: .topBarTrailing) {
                        newTabButton
                    }
                }
        } detail: {
            detailView
                .background(theme.background.ignoresSafeArea())
        }
        .navigationSplitViewStyle(.balanced)
        .onChange(of: viewModel.pendingNavigationTabId) { _, tabId in
            if let tabId {
                DiagnosticLog.log("nav ipad pending navigation", tag: "view.nav", fields: [
                    "tab_id": String(tabId.prefix(8))
                ])
                selectedTabId = tabId
                viewModel.pendingNavigationTabId = nil
            }
        }
        .onChange(of: selectedTabId) { old, tabId in
            DiagnosticLog.log("nav ipad selected tab changed", tag: "view.nav", fields: [
                "reason": old?.prefix(8).description ?? "nil",
                "tab_id": tabId?.prefix(8).description ?? "nil"
            ])
            // Notify the desktop which tab is focused so it can route
            // intercept events to this device correctly.
            viewModel.sendReportFocus(tabId: tabId)
        }
    }

    // MARK: - iPhone Layout (NavigationStack)

    var iPhoneLayout: some View {
        ZStack {
            // The themed surface, unconditionally. This used to be a
            // `jarvis-hud` navy literal gated on `backgroundView != nil`,
            // which left every other theme rendering on the system
            // background (black in dark mode). `theme.background` resolves
            // to that same navy for jarvis-hud, so the arc-reactor backdrop
            // still layers over the colour it always did.
            theme.background.ignoresSafeArea()
            if let bg = theme.backgroundView {
                bg.ignoresSafeArea().opacity(0.9)
                let _ = DiagnosticLog.trace("theme background rendering", tag: "view.themebg", fields: [
                    "status": theme.id
                ])
            }
            NavigationStack(path: $navigationPath) {
                List {
                    tabGroupSections(selectionStyle: .navigation)
                }
                .scrollContentBackground(.hidden)
                .searchable(text: $searchText, placement: .navigationBarDrawer(displayMode: .always), prompt: "Search tabs…")
                .navigationTitle("")
                .toolbar {
                    ToolbarItem(placement: .principal) {
                        if theme.backgroundView != nil {
                            Text("J A R V I S")
                                .font(.headline.weight(.black))
                                .kerning(4)
                                .foregroundStyle(theme.accent)
                                .shadow(color: theme.accent.opacity(0.9), radius: 4)
                                .shadow(color: theme.accent.opacity(0.6), radius: 10)
                                .shadow(color: theme.accent.opacity(0.3), radius: 20)
                                .opacity(flickerOpacity)
                        } else {
                            DesktopPickerMenu(showPairingSheet: $showPairingSheet)
                        }
                    }
                }
                .toolbar {
                    // Each control is its own ToolbarItem rather than a single
                    // item wrapping an HStack. The HStack made the three glyphs
                    // read as one grouped pill competing with the principal
                    // DesktopPickerMenu capsule; as separate items they render
                    // as plain toolbar glyphs and the capsule is the only
                    // container in the bar.
                    //
                    // ConnectionQualityView stays: its signal bars report LINK
                    // QUALITY and are the only entry point to the connection
                    // diagnostics popover. That is a different fact from the
                    // picker's own dot, which reports connection STATE
                    // (connected / reconnecting / offline).
                    ToolbarItem(placement: .topBarLeading) {
                        Button {
                            showSettings = true
                        } label: {
                            Image(systemName: "gearshape")
                        }
                    }
                    ToolbarItem(placement: .topBarLeading) {
                        ConnectionQualityView(compact: true)
                    }
                    ToolbarItem(placement: .topBarLeading) {
                        NotificationsBellButton(resourceStore: viewModel.resourceStore) {
                            showNotifications = true
                        }
                    }
                    ToolbarItem(placement: .topBarTrailing) {
                        newTabButton
                    }
                }
                .navigationDestination(for: String.self) { tabId in
                    let tab = viewModel.tab(for: tabId)
                    let _ = DiagnosticLog.log("nav iphone push", tag: "view.nav", fields: [
                        "tab_id": String(tabId.prefix(8)),
                        "agent": String(tab?.hasEngineExtension ?? false),
                        "status": String(tab?.isTerminalOnly ?? false)
                    ])
                    destinationView(for: tabId)
                        .onAppear {
                            DiagnosticLog.log("nav iphone on appear", tag: "view.nav", fields: [
                                "tab_id": String(tabId.prefix(8))
                            ])
                            viewModel.sendReportFocus(tabId: tabId)
                        }
                        .onDisappear {
                            // Only clear focus if we're popping back to the list,
                            // not when a child sheet appears over the conversation.
                            if navigationPath.isEmpty {
                                DiagnosticLog.log("nav iphone on disappear popped to list", tag: "view.nav", fields: [
                                    "tab_id": String(tabId.prefix(8))
                                ])
                                viewModel.sendReportFocus(tabId: nil)
                            }
                        }
                }
                .refreshable {
                    Haptic.light()
                    viewModel.sync(intent: .userInitiated)
                }
                .onChange(of: viewModel.pendingNavigationTabId) { _, tabId in
                    if let tabId {
                        DiagnosticLog.log("nav iphone pending navigation push", tag: "view.nav", fields: [
                            "tab_id": String(tabId.prefix(8))
                        ])
                        navigationPath.append(tabId)
                        viewModel.pendingNavigationTabId = nil
                    }
                }
                .overlay {
                    emptyStateOverlay
                }
                .overlay {
                    searchEmptyStateOverlay
                }
                .overlay(alignment: .top) {
                    if viewModel.voiceService.isSpeaking {
                        VoicePlaybackBar(
                            onSkip: { viewModel.voiceService.skip() },
                            onStopAll: { viewModel.voiceService.stop() },
                            hasPending: viewModel.voiceService.hasPending
                        )
                        .transition(.move(edge: .top).combined(with: .opacity))
                        .animation(IonTheme.snappySpring, value: viewModel.voiceService.isSpeaking)
                    }
                }
                // A scrim over the animated backdrop, so the toolbar stays
                // legible against moving content. Only themes that draw a
                // `backgroundView` need it; the rest stay clear and show the
                // root's `theme.background` through the bar. The colour was a
                // `jarvis-hud` navy literal, which is what `theme.background`
                // resolves to for that theme.
                .toolbarBackground(
                    theme.backgroundView != nil
                        ? theme.background.opacity(0.95)
                        : Color.clear,
                    for: .navigationBar
                )
                .toolbarColorScheme(
                    theme.backgroundView != nil ? .dark : nil,
                    for: .navigationBar
                )
                .task {
                    while !Task.isCancelled {
                        try? await Task.sleep(for: .seconds(Double.random(in: 3.0...9.0)))
                        guard !Task.isCancelled else { break }
                        withAnimation(.easeInOut(duration: 0.05)) { flickerOpacity = 0.55 }
                        try? await Task.sleep(for: .milliseconds(60))
                        withAnimation(.easeInOut(duration: 0.05)) { flickerOpacity = 1.0 }
                        try? await Task.sleep(for: .milliseconds(90))
                        withAnimation(.easeInOut(duration: 0.04)) { flickerOpacity = 0.75 }
                        try? await Task.sleep(for: .milliseconds(50))
                        withAnimation(.easeInOut(duration: 0.1)) { flickerOpacity = 1.0 }
                    }
                }
            }
        }
    }
}
