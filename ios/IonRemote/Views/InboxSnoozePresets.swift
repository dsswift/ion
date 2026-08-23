import Foundation

enum InboxSnoozePresets {
    struct Preset { let label: String; let untilMs: Double }

    /// The desktop's preset list (inbox-snooze-presets.ts), including the
    /// 20-minute minimum lead: a preset waking sooner than that is noise.
    static func available(now: Date = Date()) -> [Preset] {
        var out: [Preset] = []
        let calendar = Calendar.current
        func add(_ label: String, _ date: Date) {
            if date.timeIntervalSince(now) >= 20 * 60 {
                out.append(Preset(label: label, untilMs: date.timeIntervalSince1970 * 1000))
            }
        }
        add("In 1 hour", now.addingTimeInterval(3_600))
        add("In 3 hours", now.addingTimeInterval(10_800))
        if let evening = calendar.date(bySettingHour: 18, minute: 0, second: 0, of: now) { add("This evening (18:00)", evening) }
        if let tomorrow = calendar.date(byAdding: .day, value: 1, to: now),
           let morning = calendar.date(bySettingHour: 9, minute: 0, second: 0, of: tomorrow) {
            add("Tomorrow (09:00)", morning)
        }
        if let nextMonday = calendar.nextDate(
            after: now,
            matching: DateComponents(hour: 9, minute: 0, weekday: 2),
            matchingPolicy: .nextTime
        ) {
            add("Next Monday (09:00)", nextMonday)
        }
        return out
    }
}
