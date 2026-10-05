import Foundation

/// One paired server's place in the Fleet: its report, when one has been read.
struct FleetServer: Equatable, Sendable, Identifiable {
    /// The paired device id of the server.
    let id: String
    let label: String
    /// The newest report read; nil when none has been.
    var report: FleetReport?
    /// Why the newest read failed, in plain words.
    var error: String?
}

/// One account across the whole Fleet.
struct FleetAccountRow: Equatable, Sendable, Identifiable {

    /// A server the account has been seen on.
    struct Machine: Equatable, Sendable, Identifiable {
        let serverId: String
        let label: String
        /// Signed in on that server now. Otherwise seen there within the ledger's 30 days.
        let signedIn: Bool
        var id: String { serverId }
    }

    let key: String
    let provider: String
    let email: String
    let orgName: String?
    let planType: String?
    let label: String?
    /// Signed in on at least one server now.
    var signedIn: Bool
    /// Unix ms any server last saw the account signed in.
    let lastSeen: Double
    /// Each limit, taken from whichever server read it most recently.
    var limits: [FleetAccount.Limit]
    var machines: [Machine]

    var id: String { key }

    /// What the Fleet screen shows in place of an email until it is revealed,
    /// so a screenshot or a shared screen does not expose the account. Fixed,
    /// so it says nothing about the email's length or domain either.
    /// Mirrors `HIDDEN_FLEET_EMAIL` in `packages/shared/src/fleet-view.ts`.
    static let hiddenEmail = "••••••@••••••"

    /// What to call the account: its email (hidden unless revealed), else its
    /// label, else how it signs in.
    func title(revealEmail: Bool) -> String {
        if !email.isEmpty { return revealEmail ? email : Self.hiddenEmail }
        if let label, !label.isEmpty { return label }
        return "No email"
    }
}

struct FleetTotals: Equatable, Sendable {
    let servers: Int
    /// Servers that answered the newest read.
    let serversReached: Int
    /// Conversations with an agent running now, across the servers that say.
    let runningConversations: Int
    let accounts: Int
    let accountsSignedIn: Int
    /// Signed-in accounts with weekly quota about to reset unused.
    var accountsExpiring: Int = 0
}

/// One usage limit added up across every account of a provider that reports it.
struct FleetQuotaLimit: Equatable, Sendable {
    let kind: String
    /// The model, for a `weekly_model` limit.
    let label: String?
    /// Accounts that report this limit.
    var accounts = 0
    /// 100 per account: two accounts hold 200%.
    var capacity: Double = 0
    /// Percent used, summed over those accounts. A window that reset since it was read counts as unused.
    var used: Double = 0
    /// The soonest reset still ahead among those accounts.
    var nextReset: Date?
}

/// One provider's quota across the Fleet: every account of it, signed in now or seen in the last 30 days.
struct FleetQuotaPool: Equatable, Sendable, Identifiable {
    let provider: String
    let accounts: Int
    let limits: [FleetQuotaLimit]
    var id: String { provider }
}

/// A weekly limit whose unused part is about to be lost at its reset.
struct FleetExpiringQuota: Equatable, Sendable {
    let limit: FleetAccount.Limit
    /// Percent (0...100) that resets unused.
    let unusedPercent: Double
    let resetsAt: Date
}

/// Adds every server's report up into what the Fleet screen shows. The same
/// arithmetic as `packages/shared/src/fleet-view.ts`.
enum FleetSummary {

    /// One row per account across every server's ledger. The same account on
    /// two servers is one row with two machines; each of its limits is the
    /// newest read any server holds. Rows are ordered by provider name, then
    /// by account email; an account with no email follows its provider's others.
    static func accounts(_ servers: [FleetServer]) -> [FleetAccountRow] {
        var rows: [String: FleetAccountRow] = [:]
        var limits: [String: [String: FleetAccount.Limit]] = [:]
        for server in servers {
            for account in server.report?.accounts ?? [] {
                let key = account.key
                let machine = FleetAccountRow.Machine(serverId: server.id, label: server.label, signedIn: account.signedIn)
                if let held = rows[key], held.lastSeen >= account.lastSeen {
                    rows[key]?.signedIn = held.signedIn || account.signedIn
                    rows[key]?.machines.append(machine)
                } else {
                    let held = rows[key]
                    rows[key] = FleetAccountRow(
                        key: key, provider: account.provider, email: account.email, orgName: account.orgName,
                        planType: account.planType, label: account.label,
                        signedIn: (held?.signedIn ?? false) || account.signedIn,
                        lastSeen: account.lastSeen, limits: [], machines: (held?.machines ?? []) + [machine]
                    )
                }
                for limit in account.limits {
                    let id = "\(limit.kind)|\(limit.label ?? "")"
                    if let held = limits[key]?[id], held.fetchedAt >= limit.fetchedAt { continue }
                    limits[key, default: [:]][id] = limit
                }
            }
        }
        return rows.values
            .map { row in
                var row = row
                row.limits = (limits[row.key] ?? [:]).values.sorted { order(kind: $0.kind, label: $0.label) < order(kind: $1.kind, label: $1.label) }
                row.machines.sort { ($0.signedIn ? 0 : 1, $0.label) < ($1.signedIn ? 0 : 1, $1.label) }
                return row
            }
            .sorted { a, b in
                let providers = ServerProviderEntry.displayName(for: a.provider, in: [])
                    .caseInsensitiveCompare(ServerProviderEntry.displayName(for: b.provider, in: []))
                if providers != .orderedSame { return providers == .orderedAscending }
                if a.email.isEmpty != b.email.isEmpty { return b.email.isEmpty }
                let emails = a.email.caseInsensitiveCompare(b.email)
                if emails != .orderedSame { return emails == .orderedAscending }
                if a.signedIn != b.signedIn { return a.signedIn }
                return a.lastSeen > b.lastSeen
            }
    }

    /// The quota pools: per provider, each limit summed over its accounts, so
    /// two accounts with a 7-day limit hold 200%. A spend limit is money, not a
    /// share of a window, so it is left out. Providers in name order. The same
    /// rule as `fleetQuotaPools` in `packages/shared/src/fleet-view.ts`.
    static func quotaPools(_ rows: [FleetAccountRow], now: Date = .now) -> [FleetQuotaPool] {
        var accounts: [String: Int] = [:]
        var sums: [String: [String: FleetQuotaLimit]] = [:]
        for row in rows {
            accounts[row.provider, default: 0] += 1
            for limit in row.limits where limit.kind != "spend" {
                let id = "\(limit.kind)|\(limit.label ?? "")"
                var sum = sums[row.provider]?[id] ?? FleetQuotaLimit(kind: limit.kind, label: limit.label)
                sum.accounts += 1
                sum.capacity += 100
                if !expired(limit, now: now) {
                    sum.used += min(max(limit.percent, 0), 100)
                    if let resets = resetDate(limit), resets > now, sum.nextReset.map({ resets < $0 }) ?? true { sum.nextReset = resets }
                }
                sums[row.provider, default: [:]][id] = sum
            }
        }
        return accounts
            .map { provider, count in
                FleetQuotaPool(provider: provider, accounts: count,
                               limits: (sums[provider] ?? [:]).values.sorted { order(kind: $0.kind, label: $0.label) < order(kind: $1.kind, label: $1.label) })
            }
            .sorted {
                ServerProviderEntry.displayName(for: $0.provider, in: [])
                    .caseInsensitiveCompare(ServerProviderEntry.displayName(for: $1.provider, in: [])) == .orderedAscending
            }
    }

    static func totals(_ servers: [FleetServer], accounts: [FleetAccountRow]) -> FleetTotals {
        FleetTotals(
            servers: servers.count,
            serversReached: servers.filter { $0.report != nil && $0.error == nil }.count,
            runningConversations: servers.reduce(0) { $0 + ($1.error == nil ? ($1.report?.server.runningConversations ?? 0) : 0) },
            accounts: accounts.count,
            accountsSignedIn: accounts.filter(\.signedIn).count,
            accountsExpiring: accounts.filter { !expiring($0).isEmpty }.count
        )
    }

    /// Percent of the tightest limit still holding that is unused, for the
    /// account a new conversation on this server would run on: the default
    /// provider's when one is signed in, else the signed-in account with the
    /// most room. Nil when the server reports no signed-in account. The same
    /// rule as `accountRoomPercent` and `placementAccount` in
    /// `packages/shared/src/fleet-placement.ts`.
    static func roomPercent(_ report: FleetReport, now: Date = .now) -> Double? {
        let signedIn = report.accounts.filter(\.signedIn)
        let preferred = signedIn.filter { $0.provider == report.defaultProvider }
        return (preferred.isEmpty ? signedIn : preferred).map { room($0, now: now) }.max()
    }

    private static func room(_ account: FleetAccount, now: Date) -> Double {
        account.limits.reduce(100.0) { tightest, limit in
            if limit.kind == "spend" || expired(limit, now: now) { return tightest }
            return min(tightest, max(0, 100 - limit.percent))
        }
    }

    /// The server a new conversation has the most room on right now, among
    /// those that answered. Nil when fewer than two can be compared.
    static func mostRoomServerId(_ servers: [FleetServer], now: Date = .now) -> String? {
        let scored = servers.compactMap { server -> (id: String, room: Double)? in
            guard server.error == nil, let report = server.report, let room = roomPercent(report, now: now), room > 0 else { return nil }
            return (server.id, room)
        }
        guard scored.count >= 2 else { return nil }
        return scored.max { $0.room < $1.room }?.id
    }

    /// The built-in rule for quota that is about to expire: a weekly limit
    /// within 12 hours of its reset with a quarter or more unused. The same
    /// defaults as `DEFAULT_SPARE_QUOTA_RULE` in `packages/shared/src/usage-limit.ts`.
    static let expiringWithinHours: Double = 12
    static let expiringUnusedPercent: Double = 25

    /// The weekly limits of a signed-in account that will reset with quota
    /// unused, soonest first. A signed-out account cannot spend what it has
    /// left, so it has none.
    static func expiring(_ row: FleetAccountRow, now: Date = .now, withinHours: Double = expiringWithinHours, unusedPercent: Double = expiringUnusedPercent) -> [FleetExpiringQuota] {
        guard row.signedIn else { return [] }
        return row.limits.compactMap { limit -> FleetExpiringQuota? in
            guard limit.kind == "weekly" || limit.kind == "weekly_model", let resets = resetDate(limit) else { return nil }
            let untilReset = resets.timeIntervalSince(now)
            let unused = max(0, 100 - limit.percent)
            guard untilReset > 0, untilReset <= withinHours * 3600, unused >= unusedPercent else { return nil }
            return FleetExpiringQuota(limit: limit, unusedPercent: unused, resetsAt: resets)
        }
        .sorted { $0.resetsAt < $1.resetsAt }
    }

    /// The name a limit is shown under: a model's weekly limit by its model.
    static func title(_ limit: FleetAccount.Limit) -> String {
        title(kind: limit.kind, label: limit.label)
    }

    static func title(kind: String, label: String?) -> String {
        switch kind {
        case "session": return "5-hour"
        case "weekly": return "7-day"
        case "weekly_model": return "7-day \(label ?? "model")"
        case "spend": return label ?? "Spend"
        default: return label ?? kind
        }
    }

    /// Whether a limit's window has reset since it was read. A limit read
    /// before its reset time, looked at after it, no longer says how much is used.
    static func expired(_ limit: FleetAccount.Limit, now: Date = .now) -> Bool {
        guard let resets = resetDate(limit) else { return false }
        return resets <= now && limit.fetchedAt < resets.timeIntervalSince1970 * 1000
    }

    static func resetDate(_ limit: FleetAccount.Limit) -> Date? {
        guard let text = limit.resetsAt, !text.isEmpty else { return nil }
        return (try? Date(text, strategy: .iso8601)) ?? (try? Date(text, strategy: Date.ISO8601FormatStyle(includingFractionalSeconds: true)))
    }

    /// A model's weekly limit first, then the 5-hour, then the 7-day, then the rest.
    private static func order(kind: String, label: String?) -> String {
        switch kind {
        case "weekly_model": return "0|\(label ?? "")"
        case "session": return "1"
        case "weekly": return "2"
        default: return "3|\(kind)|\(label ?? "")"
        }
    }
}
