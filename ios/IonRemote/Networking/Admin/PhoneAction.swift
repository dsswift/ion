import Foundation

/// Every `studio_action` the phone calls directly through `ServerAdminClient`,
/// with the scope the server requires for it.
///
/// Mirrors `packages/shared/src/studio-wire/phone-actions.json`;
/// `PhoneActionTableTests` fails when the two differ. The legacy
/// `desktop_*` commands are mapped in `StudioTransportCommandMapping`, not here.
enum PhoneAction: String, CaseIterable, Sendable {
    case aiAssistWorkflows = "aiAssist.workflows"
    case authCompleteSignIn = "auth.completeSignIn"
    case authCreatePairingLink = "auth.createPairingLink"
    case authForgetSelf = "auth.forgetSelf"
    case authListClients = "auth.listClients"
    case authRevokeClient = "auth.revokeClient"
    case automationDelete = "automation.delete"
    case automationDuplicate = "automation.duplicate"
    case automationHistory = "automation.history"
    case automationListing = "automation.listing"
    case automationSetProjectEnabled = "automation.setProjectEnabled"
    case automationUpsert = "automation.upsert"
    case entraIdentity = "entra.identity"
    case entraSignIn = "entra.signIn"
    case entraSignOut = "entra.signOut"
    case environmentDiscoveryClose = "environment.discovery.close"
    case environmentDiscoveryMintCode = "environment.discovery.mintCode"
    case environmentDiscoveryOpen = "environment.discovery.open"
    case environmentDiscoveryStatus = "environment.discovery.status"
    case environmentFsBrowse = "environment.fs.browse"
    case environmentGitAuthorGet = "environment.git.author.get"
    case environmentGitAuthorSet = "environment.git.author.set"
    case environmentGitHostKeys = "environment.git.hostKeys"
    case environmentGitTest = "environment.git.test"
    case environmentHostToolchains = "environment.host.toolchains"
    case environmentJobsCancel = "environment.jobs.cancel"
    case environmentJobsList = "environment.jobs.list"
    case environmentProjectsAdd = "environment.projects.add"
    case environmentProjectsAppraiseRemoval = "environment.projects.appraiseRemoval"
    case environmentProjectsClone = "environment.projects.clone"
    case environmentProjectsList = "environment.projects.list"
    case environmentProjectsRelocate = "environment.projects.relocate"
    case environmentProjectsRemove = "environment.projects.remove"
    case environmentProjectsSetup = "environment.projects.setup"
    case environmentProjectsTrust = "environment.projects.trust"
    case environmentPurgeAppraise = "environment.purge.appraise"
    case environmentPurgeRun = "environment.purge.run"
    case environmentServerInfo = "environment.server.info"
    case environmentServerLogTail = "environment.server.logTail"
    case environmentServerRestart = "environment.server.restart"
    case environmentServerUpdate = "environment.server.update"
    case environmentSystemMetricsHistory = "environment.systemMetrics.history"
    case environmentSystemMetricsLatest = "environment.systemMetrics.latest"
    case environmentSystemMetricsWatch = "environment.systemMetrics.watch"
    case fleetHubsAdd = "fleet.hubs.add"
    case fleetHubsList = "fleet.hubs.list"
    case fleetHubsRemove = "fleet.hubs.remove"
    case fleetRefreshAccounts = "fleet.refreshAccounts"
    case fleetReport = "fleet.report"
    case fsReadFileData = "fs.readFileData"
    case fsResolveLink = "fs.resolveLink"
    case gitIdentityAuthorize = "gitIdentity.authorize"
    case gitIdentityList = "gitIdentity.list"
    case gitIdentityMintSshKey = "gitIdentity.mintSshKey"
    case gitIdentityRemove = "gitIdentity.remove"
    case gitIdentitySetSshKey = "gitIdentity.setSshKey"
    case gitIdentitySetToken = "gitIdentity.setToken"
    case mcpAdd = "mcp.add"
    case mcpList = "mcp.list"
    case mcpLogin = "mcp.login"
    case mcpLogout = "mcp.logout"
    case mcpRemove = "mcp.remove"
    case mcpUpdate = "mcp.update"
    case modelList = "model.list"
    case modelListTiers = "model.listTiers"
    case modelRefresh = "model.refresh"
    case modelRemoveTier = "model.removeTier"
    case modelSetTier = "model.setTier"
    case oauthDeviceCode = "oauth.deviceCode"
    case oauthDevicePoll = "oauth.devicePoll"
    case oauthLogout = "oauth.logout"
    case oauthStart = "oauth.start"
    case planBashAllowlistGet = "planBashAllowlist.get"
    case planBashAllowlistSet = "planBashAllowlist.set"
    case policyGetFull = "policy.getFull"
    case providerGetDefault = "provider.getDefault"
    case providerLogin = "provider.login"
    case providerLoginCancel = "provider.loginCancel"
    case providerLoginCode = "provider.loginCode"
    case providerLogout = "provider.logout"
    case providerRefreshSubscription = "provider.refreshSubscription"
    case providerRemove = "provider.remove"
    case providerSelectSubscription = "provider.selectSubscription"
    case providerSetDefault = "provider.setDefault"
    case providerStoreCredential = "provider.storeCredential"
    case providerSubscription = "provider.subscription"
    case remoteDiscoverRelays = "remote.discoverRelays"
    case remoteGetDisplay = "remote.getDisplay"
    case remoteRelayAuthConfig = "remote.relayAuthConfig"
    case remoteSetDisplay = "remote.setDisplay"
    case remoteStopDiscovery = "remote.stopDiscovery"
    case remoteTestRelay = "remote.testRelay"
    case settingsLoad = "settings.load"
    case settingsSave = "settings.save"
    case settingsSetProjectable = "settings.setProjectable"

    var requiredScope: StudioScope {
        switch self {
        case .aiAssistWorkflows, .authForgetSelf, .automationHistory, .automationListing, .entraIdentity, .environmentDiscoveryStatus,
             .environmentFsBrowse, .fleetHubsList, .fleetRefreshAccounts, .fleetReport, .fsReadFileData, .fsResolveLink, .environmentGitAuthorGet, .environmentGitHostKeys, .environmentHostToolchains,
             .environmentJobsList, .environmentProjectsAppraiseRemoval, .environmentProjectsList, .environmentServerInfo,
             .environmentSystemMetricsHistory, .environmentSystemMetricsLatest, .environmentSystemMetricsWatch, .mcpList, .modelList,
             .modelListTiers, .planBashAllowlistGet, .policyGetFull, .providerGetDefault, .providerSubscription,
             .remoteGetDisplay, .settingsLoad, .settingsSave:
            return .conversationsRead
        case .automationDelete, .automationDuplicate, .automationSetProjectEnabled, .automationUpsert,
             .remoteSetDisplay, .settingsSetProjectable:
            return .conversationsOperate
        case .environmentGitAuthorSet, .environmentGitTest, .environmentJobsCancel, .environmentProjectsAdd,
             .environmentProjectsClone, .environmentProjectsRelocate, .environmentProjectsRemove, .environmentProjectsSetup,
             .environmentProjectsTrust, .gitIdentityAuthorize, .gitIdentityList, .gitIdentityMintSshKey,
             .gitIdentityRemove, .gitIdentitySetSshKey, .gitIdentitySetToken:
            return .gitWrite
        case .authCompleteSignIn, .authCreatePairingLink, .authListClients, .authRevokeClient,
             .entraSignIn, .entraSignOut, .environmentDiscoveryClose, .environmentDiscoveryMintCode,
             .environmentDiscoveryOpen, .environmentPurgeAppraise, .environmentPurgeRun, .environmentServerLogTail,
             .environmentServerRestart, .environmentServerUpdate, .fleetHubsAdd, .fleetHubsRemove, .mcpAdd, .mcpLogin,
             .mcpLogout, .mcpRemove, .mcpUpdate, .modelRefresh, .modelRemoveTier,
             .modelSetTier, .oauthDeviceCode, .oauthDevicePoll, .oauthLogout, .oauthStart,
             .planBashAllowlistSet, .providerLogin, .providerLoginCancel, .providerLoginCode,
             .providerLogout, .providerRefreshSubscription, .providerRemove, .providerSelectSubscription, .providerSetDefault,
             .providerStoreCredential, .remoteDiscoverRelays,
             .remoteRelayAuthConfig, .remoteStopDiscovery, .remoteTestRelay:
            return .admin
        }
    }
}
