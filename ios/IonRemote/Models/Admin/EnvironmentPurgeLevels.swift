import Foundation

/// How much an uninstall removes beyond the Studio Server services and
/// bundle, which always go. The `environment.purge.run` argument.
struct EnvironmentPurgeLevels: Equatable, Sendable {
    var gitCredentials = false
    var clones = false
    var data = false
    /// Delete a clone with uncommitted changes anyway.
    var force = false

    /// The action's argument object.
    var fields: [String: JSONValue] {
        ["gitCredentials": .bool(gitCredentials), "clones": .bool(clones), "data": .bool(data), "force": .bool(clones && force)]
    }
}
