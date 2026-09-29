import Foundation

/// The connected Environment's load, as the server summarises it for a phone.
/// Fractions are 0...1; nil means the server does not know the figure yet.
struct EnvironmentLoadSummary: Codable, Equatable {
    let cpuUtilization: Double?
    let memoryUsedFraction: Double?
    let diskFreeFraction: Double?
    /// Unix ms the server's sample was taken.
    let sampledAt: Double
}
