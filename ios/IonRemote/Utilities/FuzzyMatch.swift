/// Fuzzy matching utility for slash command autocomplete.
/// Algorithm mirrors `desktop/src/shared/fuzzy-match.ts` for cross-platform parity.
enum FuzzyMatch {

    // MARK: - Separators

    private static let separators: Set<Character> = ["-", "_", ":"]

    // MARK: - Public API

    /// Returns `nil` if the query is not a subsequence of the candidate.
    /// Otherwise returns the fuzzy score (higher = better match).
    ///
    /// Scoring:
    /// - Exact prefix match: **+20** bonus (once, if entire query matches start of candidate)
    /// - Match at start of string: **+10** bonus per character
    /// - Match after separator (`-`, `_`, `:`): **+8** bonus per character
    /// - Consecutive matches: **+5** bonus per consecutive character after the first
    /// - Base: **1** point per matched character
    static func score(query: String, candidate: String) -> Int? {
        // 1. Strip leading "/" and lowercase both strings.
        let q = stripped(query)
        let c = stripped(candidate)

        // 2. Empty query matches everything with score 0.
        if q.isEmpty { return 0 }

        // 3. Subsequence gate – every character in q must appear in order in c.
        //    While checking, record the matching indices for scoring.
        let cChars = Array(c)
        let qChars = Array(q)

        var matchIndices = [Int]()
        matchIndices.reserveCapacity(qChars.count)

        var ci = 0
        for qChar in qChars {
            var found = false
            while ci < cChars.count {
                if cChars[ci] == qChar {
                    matchIndices.append(ci)
                    ci += 1
                    found = true
                    break
                }
                ci += 1
            }
            if !found {
                return nil  // not a subsequence
            }
        }

        // 4. Compute score from the matched indices.
        var total = 0

        for (i, matchIndex) in matchIndices.enumerated() {
            // Base: +1 per matched character
            total += 1

            // Start-of-string bonus: +10 per character matched at index 0
            if matchIndex == 0 {
                total += 10
            }

            // After-separator bonus: +8 per character immediately following a separator
            if matchIndex > 0 && separators.contains(cChars[matchIndex - 1]) {
                total += 8
            }

            // Consecutive bonus: +5 for each character that is consecutive with the
            // previous match (only the 2nd, 3rd, … in a streak get the bonus).
            if i > 0 && matchIndex == matchIndices[i - 1] + 1 {
                total += 5
            }
        }

        // Exact prefix bonus: +20 if the entire query matches the start of the candidate.
        if matchIndices.count == qChars.count
            && matchIndices.first == 0
            && matchIndices.last == qChars.count - 1 {
            total += 20
        }

        return total
    }

    // MARK: - Helpers

    /// Strip a leading `/` and lowercase the string.
    private static func stripped(_ s: String) -> String {
        var result = s
        if result.hasPrefix("/") {
            result = String(result.dropFirst())
        }
        return result.lowercased()
    }
}
