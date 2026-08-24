import SwiftUI

/// One question's answer control inside the Questions Wizard: radio rows or
/// pill groups (single), checkbox rows or pill groups (multiple), or a
/// free-form text field (text mode). The control is picked by the shared
/// display rule (QuestionSpec.resolvedDisplay — pinned to match the desktop's
/// resolver). Option questions always render an "Other" free-text input.
struct QuestionsWizardQuestionRow: View {
    @Environment(\.appTheme) private var theme
    let viewModel: SessionViewModel
    let spec: QuestionSpec
    @Binding var draft: QuestionDraftAnswer

    private var skipped: Bool { draft.skipped == true }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .top) {
                Text(spec.prompt)
                    .font(.subheadline.weight(.medium))
                Spacer()
                Button(skipped ? "Agent decides ✓" : "Agent decides") {
                    if skipped {
                        draft = QuestionDraftAnswer(questionId: spec.id, selectedOptionIds: draft.selectedOptionIds, customText: draft.customText, skipped: nil, attachments: draft.attachments)
                    } else {
                        draft = QuestionDraftAnswer(questionId: spec.id, selectedOptionIds: [], customText: nil, skipped: true, attachments: nil)
                    }
                }
                .font(.caption2)
                .buttonStyle(.bordered)
                .tint(skipped ? theme.accent : .secondary)
            }
            if let guidance = spec.guidance, !guidance.isEmpty {
                Text(guidance)
                    .font(.caption)
                    .foregroundStyle(theme.textSecondary)
            }
            if !skipped {
                if spec.mode == "text" {
                    // 1→4 rows then inner scroll — parity with the desktop
                    // AutoGrowTextarea (never grows unbounded, never scrolls
                    // horizontally: .vertical axis wraps by construction).
                    TextField("Your answer", text: customTextBinding, axis: .vertical)
                        .lineLimit(1...4)
                        .textFieldStyle(.roundedBorder)
                } else {
                    optionControl
                    TextField("Other…", text: customTextBinding, axis: .vertical)
                        .lineLimit(1...4)
                        .textFieldStyle(.roundedBorder)
                        .font(.caption)
                }
                // Attaching from the phone goes through the composer's own
                // upload path, so an image picked here reaches the model
                // exactly as a desktop-picked one does. Desktop parity.
                QuestionAttachmentRow(viewModel: viewModel, draft: $draft)
            }
        }
    }

    @ViewBuilder
    private var optionControl: some View {
        let options = spec.options ?? []
        if spec.resolvedDisplay == "pills" {
            // Compact quick-pick: wrapping pill grid.
            FlowLayout(spacing: 6) {
                ForEach(options) { option in
                    let selected = draft.selectedOptionIds.contains(option.id)
                    Button(option.label) { toggle(option.id) }
                        .font(.caption)
                        .buttonStyle(.bordered)
                        .tint(selected ? theme.accent : .secondary)
                }
            }
        } else {
            VStack(spacing: 4) {
                ForEach(options) { option in
                    let selected = draft.selectedOptionIds.contains(option.id)
                    Button {
                        toggle(option.id)
                    } label: {
                        HStack(alignment: .top, spacing: 8) {
                            Image(systemName: iconName(selected: selected))
                                .foregroundStyle(selected ? theme.accent : theme.textSecondary)
                                .padding(.top, 1)
                            VStack(alignment: .leading, spacing: 2) {
                                Text(option.label)
                                    .font(.subheadline)
                                    .foregroundStyle(theme.textPrimary)
                                if let description = option.description, !description.isEmpty {
                                    Text(description)
                                        .font(.caption)
                                        .foregroundStyle(theme.textSecondary)
                                }
                            }
                            Spacer(minLength: 0)
                        }
                        .padding(8)
                        .background(
                            selected ? theme.accent.opacity(0.1) : theme.surfaceSecondary,
                            in: RoundedRectangle(cornerRadius: 10)
                        )
                    }
                    .buttonStyle(.plain)
                }
            }
        }
    }

    private func iconName(selected: Bool) -> String {
        if spec.resolvedDisplay == "radio" {
            return selected ? "largecircle.fill.circle" : "circle"
        }
        return selected ? "checkmark.square.fill" : "square"
    }

    private var customTextBinding: Binding<String> {
        Binding(
            get: { draft.customText ?? "" },
            set: { text in
                draft = QuestionDraftAnswer(
                    questionId: spec.id,
                    selectedOptionIds: draft.selectedOptionIds,
                    customText: text.isEmpty ? nil : text,
                    skipped: nil,
                    attachments: draft.attachments
                )
            }
        )
    }

    private func toggle(_ optionId: String) {
        Haptic.light()
        var selected = draft.selectedOptionIds
        if spec.mode == "single" {
            selected = selected.contains(optionId) ? [] : [optionId]
        } else if let index = selected.firstIndex(of: optionId) {
            selected.remove(at: index)
        } else {
            selected.append(optionId)
        }
        draft = QuestionDraftAnswer(questionId: spec.id, selectedOptionIds: selected, customText: draft.customText, skipped: nil, attachments: draft.attachments)
    }
}

// FlowLayout is reused from AskUserQuestionCardView.swift (same target).
