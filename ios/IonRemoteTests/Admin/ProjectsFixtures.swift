import Foundation
@testable import IonRemote

/// Results in the shapes the server's `environment.*` project handlers
/// return (`server/src/environment/projects.ts`, `jobs.ts`, `fs-browse.ts`).
enum ProjectsFixtures {

    static func json(_ text: String) -> JSONValue {
        do {
            return try JSONDecoder().decode(JSONValue.self, from: Data(text.utf8))
        } catch {
            preconditionFailure("fixture is not JSON: \(error)")
        }
    }

    /// A trusted checkout the operator added, with a finished setup.
    static let appProject = """
    {"dir":"/Users/dev/source/app","entry":{"addedManually":true,"lastUsedAt":1726000000000,"repoRemote":"github.com/example/app"},
     "displayName":"app","exists":true,"isGitRepo":true,"usageCount":12,"branch":"main",
     "originUrl":"git@github.com:example/app.git","setup":{"state":"ready","detail":"done","at":1726000000500},
     "setupCommand":"make setup"}
    """

    /// A checkout Ion cloned that nobody trusted yet.
    static let clonedProject = """
    {"dir":"/Users/dev/source/tools","entry":{"addedManually":true,"lastUsedAt":1726000000000,"repoRemote":"github.com/example/tools",
     "clonedByIon":true,"cloneUrl":"https://github.com/example/tools.git","trusted":false},
     "displayName":"tools","exists":true,"isGitRepo":true,"branch":"main","originUrl":"https://github.com/example/tools.git","trusted":false}
    """

    /// A registered folder that is gone from disk.
    static let missingProject = """
    {"dir":"/Users/dev/old","entry":{"addedManually":true,"lastUsedAt":1},"displayName":"Old Work","exists":false,"isGitRepo":false}
    """

    static func projects(_ items: String...) -> JSONValue { json("[\(items.joined(separator: ","))]") }

    static func job(id: String = "job-1", kind: String = "clone", dir: String = "/Users/dev/source/new", phase: String = "running",
                    percent: Int? = 45, url: String? = "git@github.com:example/new.git", error: String? = nil) -> String {
        var fields = ["\"id\":\"\(id)\"", "\"kind\":\"\(kind)\"", "\"dir\":\"\(dir)\"", "\"phase\":\"\(phase)\"",
                      "\"stage\":\"receiving objects\"", "\"startedAt\":1726000000000"]
        if let percent { fields.append("\"percent\":\(percent)") }
        if let url { fields.append("\"url\":\"\(url)\"") }
        if let error { fields.append("\"error\":\"\(error)\"") }
        if phase != "running" { fields.append("\"endedAt\":1726000009000") }
        return "{\(fields.joined(separator: ","))}"
    }

    static let browse = """
    {"path":"/Users/dev/source","parentPath":"/Users/dev","pathIsGitRepo":false,"home":"/Users/dev",
     "entries":[{"name":"app","fullPath":"/Users/dev/source/app","isGitRepo":true},{"name":"notes","fullPath":"/Users/dev/source/notes","isGitRepo":false}]}
    """

    static let rootBrowse = """
    {"path":"/","parentPath":null,"pathIsGitRepo":false,"home":"/Users/dev","entries":[]}
    """

    static let appraisal = """
    {"dir":"/Users/dev/source/tools","registered":true,"clonedByIon":true,"exists":true,"dirty":true,"worktrees":2}
    """

    static func decode<T: Decodable>(_ text: String, as type: T.Type) throws -> T {
        try json(text).decoded(as: type)
    }
}
