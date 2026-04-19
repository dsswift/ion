import Foundation
import SwiftUI

/// Parses ANSI escape sequences into AttributedString for SwiftUI rendering.
struct AnsiParser {

    struct StyledSegment {
        let text: String
        var bold: Bool = false
        var foreground: Color?
        var background: Color?
    }

    /// Standard 16-color ANSI palette
    private static let ansi16: [Int: Color] = [
        30: .black, 31: Color(red: 0.76, green: 0.21, blue: 0.13),
        32: Color(red: 0.15, green: 0.74, blue: 0.14),
        33: Color(red: 0.68, green: 0.68, blue: 0.15),
        34: Color(red: 0.29, green: 0.18, blue: 0.88),
        35: Color(red: 0.83, green: 0.22, blue: 0.83),
        36: Color(red: 0.20, green: 0.73, blue: 0.78),
        37: Color(red: 0.80, green: 0.80, blue: 0.80),
        90: .gray, 91: Color(red: 0.99, green: 0.22, blue: 0.12),
        92: Color(red: 0.19, green: 0.91, blue: 0.13),
        93: Color(red: 0.92, green: 0.93, blue: 0.14),
        94: Color(red: 0.35, green: 0.20, blue: 1.0),
        95: Color(red: 0.98, green: 0.21, blue: 0.97),
        96: Color(red: 0.08, green: 0.94, blue: 0.94),
        97: Color(red: 0.91, green: 0.92, blue: 0.92),
    ]

    static func parse(_ line: String) -> AttributedString {
        var result = AttributedString()
        var bold = false
        var fg: Color?
        var bg: Color?

        var i = line.startIndex
        while i < line.endIndex {
            if line[i] == "\u{1B}" {
                let next = line.index(after: i)
                if next < line.endIndex && line[next] == "[" {
                    // Find 'm' terminator
                    var j = line.index(after: next)
                    while j < line.endIndex && line[j] != "m" { j = line.index(after: j) }
                    if j >= line.endIndex { break }

                    let paramStr = String(line[line.index(after: next)..<j])
                    let params = paramStr.split(separator: ";").compactMap { Int($0) }

                    var k = 0
                    while k < params.count {
                        let p = params[k]
                        switch p {
                        case 0: bold = false; fg = nil; bg = nil
                        case 1: bold = true
                        case 22: bold = false
                        case 39: fg = nil
                        case 49: bg = nil
                        case 30...37: fg = ansi16[p]
                        case 90...97: fg = ansi16[p]
                        case 40...47: bg = ansi16[p - 10]
                        case 38 where k + 4 < params.count && params[k+1] == 2:
                            fg = Color(red: Double(params[k+2])/255, green: Double(params[k+3])/255, blue: Double(params[k+4])/255)
                            k += 4
                        case 48 where k + 4 < params.count && params[k+1] == 2:
                            bg = Color(red: Double(params[k+2])/255, green: Double(params[k+3])/255, blue: Double(params[k+4])/255)
                            k += 4
                        case 38 where k + 1 < params.count && params[k+1] == 5:
                            k += 2
                        case 48 where k + 1 < params.count && params[k+1] == 5:
                            k += 2
                        default: break
                        }
                        k += 1
                    }

                    i = line.index(after: j)
                    continue
                }
            }

            // Collect text until next escape
            var j = line.index(after: i)
            while j < line.endIndex && line[j] != "\u{1B}" { j = line.index(after: j) }

            let text = String(line[i..<j])
            var attr = AttributedString(text)
            attr.font = bold ? .system(.caption, design: .monospaced).bold() : .system(.caption, design: .monospaced)
            if let fg { attr.foregroundColor = fg }
            if let bg { attr.backgroundColor = bg }
            result.append(attr)

            i = j
        }

        return result
    }
}
