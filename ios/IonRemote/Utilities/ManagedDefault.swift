import Foundation

// MARK: - Managed defaults
//
// A managed default is an unlocked enterprise value that seeds a preference
// the person may then change. The phone remembers the last policy value it
// applied to each preference (the watermark). A policy value that differs
// from the watermark overwrites the preference; an equal one leaves the
// preference alone, so a deliberate change survives until an administrator
// publishes a different value.
//
// The repo-root fixture `assets/managed-default-parity.json` pins this rule
// for every client. `ManagedDefaultParityTests` is the iOS half.

enum ManagedDefault {
    enum Decision: String, Equatable {
        /// The policy carries no value for this preference. Nothing to do.
        case absent
        /// The policy is locked. The lock path enforces it; the watermark is not involved.
        case locked
        /// The policy value is the one already applied. The preference is the person's.
        case keep
        /// The policy value is new to this phone. Overwrite and record it.
        case apply
    }

    /// - Parameters:
    ///   - policyValue: The policy's value for the preference. Nil or empty means the policy does not set it.
    ///   - applied: The watermark: the last policy value applied to this preference, if any.
    static func decide(policyValue: String?, locked: Bool, applied: String?) -> Decision {
        guard let policyValue, !policyValue.isEmpty else { return .absent }
        if locked { return .locked }
        return policyValue == applied ? .keep : .apply
    }

    /// The watermarks, persisted in UserDefaults so they survive a relaunch.
    ///
    /// A phone can be paired with several servers, each publishing its own
    /// policy, so a watermark belongs to one preference from one source.
    /// Without the source, switching between two servers with different
    /// defaults would overwrite the preference on every switch.
    struct Watermarks {
        static let defaultsKey = "managedDefaultsApplied"

        var defaults: UserDefaults = .standard

        private static func entryKey(preference: String, source: String?) -> String {
            guard let source, !source.isEmpty else { return preference }
            return "\(preference)@\(source)"
        }

        func applied(preference: String, source: String?) -> String? {
            let all = defaults.dictionary(forKey: Self.defaultsKey) as? [String: String]
            return all?[Self.entryKey(preference: preference, source: source)]
        }

        func record(_ value: String, preference: String, source: String?) {
            var all = defaults.dictionary(forKey: Self.defaultsKey) as? [String: String] ?? [:]
            all[Self.entryKey(preference: preference, source: source)] = value
            defaults.set(all, forKey: Self.defaultsKey)
        }
    }
}
