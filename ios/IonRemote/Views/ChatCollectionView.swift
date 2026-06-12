import SwiftUI
import UIKit

// MARK: - ChatItem

/// Identity wrapper for diffable data source. Hashes by `id` only so the
/// data source tracks item identity, not content. Content updates are
/// handled via snapshot `reconfigureItems`.
struct ChatItem<Payload>: Hashable {
    let id: String
    let payload: Payload

    static func == (lhs: Self, rhs: Self) -> Bool { lhs.id == rhs.id }
    func hash(into hasher: inout Hasher) { hasher.combine(id) }
}

// MARK: - ChatCollectionView

/// A UICollectionView wrapper optimized for chat-style scrolling.
///
/// Replaces `LazyVStack` + `ScrollView` + `ScrollViewReader` + KVO hacks
/// with a single UIKit component that:
/// - Tracks `isNearBottom` via `UIScrollViewDelegate` (no KVO, no superview walking)
/// - Scrolls to bottom reliably (no estimated-height overshoot)
/// - Auto-tails during streaming when the user is near the bottom
/// - Uses `UIHostingConfiguration` to render SwiftUI row views
struct ChatCollectionView<Payload, RowContent: View>: UIViewControllerRepresentable {
    let items: [ChatItem<Payload>]
    @Binding var isNearBottom: Bool
    /// Monotonically increasing counter. Incrementing forces a scroll-to-bottom
    /// regardless of `isNearBottom` (used by the STB button and submit actions).
    var forceScrollCounter: Int = 0
    let spacing: CGFloat
    let horizontalInset: CGFloat
    let rowContent: (Payload) -> RowContent

    func makeUIViewController(context: Context) -> ChatCollectionVC<Payload, RowContent> {
        let vc = ChatCollectionVC<Payload, RowContent>(
            rowContent: rowContent,
            spacing: spacing,
            horizontalInset: horizontalInset
        )
        vc.onNearBottomChanged = { [self] near in
            if isNearBottom != near {
                DispatchQueue.main.async { isNearBottom = near }
            }
        }
        context.coordinator.lastForceScroll = forceScrollCounter
        return vc
    }

    func updateUIViewController(
        _ vc: ChatCollectionVC<Payload, RowContent>,
        context: Context
    ) {
        vc.rowContent = rowContent

        let forceScroll = forceScrollCounter != context.coordinator.lastForceScroll
        context.coordinator.lastForceScroll = forceScrollCounter

        vc.applySnapshot(
            items: items,
            isNearBottom: isNearBottom,
            forceScroll: forceScroll
        )
    }

    func makeCoordinator() -> Coordinator { Coordinator() }

    final class Coordinator {
        var lastForceScroll = 0
    }
}

// MARK: - Section

private enum ChatSection: Hashable { case main }

// MARK: - ChatCollectionVC

final class ChatCollectionVC<Payload, RowContent: View>:
    UIViewController, UICollectionViewDelegate, UIScrollViewDelegate
{
    var rowContent: (Payload) -> RowContent

    private var collectionView: UICollectionView!
    private var dataSource: UICollectionViewDiffableDataSource<ChatSection, ChatItem<Payload>>!
    private var nearBottom = true
    var onNearBottomChanged: ((Bool) -> Void)?

    private var pendingSnapshot: (items: [ChatItem<Payload>], isNearBottom: Bool, forceScroll: Bool)?
    private var hasAppliedInitialSnapshot = false
    private let spacing: CGFloat
    private let horizontalInset: CGFloat

    /// Live user-interaction state read directly from the scroll view.
    ///
    /// Replaces a hand-tracked `userIsInteracting` flag that was set in
    /// `scrollViewWillBeginDragging` and cleared in `scrollViewDidEndDragging`
    /// / `scrollViewDidEndDecelerating`. That flag could stick `true` forever:
    /// if the user flicked to the bottom (ending the drag with
    /// `willDecelerate=true`) and a non-animated programmatic scroll from a
    /// snapshot apply interrupted the deceleration,
    /// `scrollViewDidEndDecelerating` never fired — permanently disabling
    /// auto-tail. UIKit's own properties cannot drift: during programmatic
    /// non-animated scrolls all three are `false`, so the "don't flip
    /// near→far on content growth" guard still holds.
    private var isUserInteracting: Bool {
        guard let cv = collectionView else { return false }
        return cv.isTracking || cv.isDragging || cv.isDecelerating
    }

    init(
        rowContent: @escaping (Payload) -> RowContent,
        spacing: CGFloat,
        horizontalInset: CGFloat
    ) {
        self.rowContent = rowContent
        self.spacing = spacing
        self.horizontalInset = horizontalInset
        super.init(nibName: nil, bundle: nil)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError() }

    override func viewDidLoad() {
        super.viewDidLoad()

        let layout = makeLayout()
        collectionView = UICollectionView(frame: view.bounds, collectionViewLayout: layout)
        collectionView.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        collectionView.backgroundColor = .clear
        collectionView.delegate = self
        collectionView.keyboardDismissMode = .interactive
        collectionView.contentInsetAdjustmentBehavior = .always
        collectionView.clipsToBounds = true
        // Hosted SwiftUI cells whose content grows internally (streaming
        // text, markdown re-render) proactively invalidate their size
        // instead of waiting for the next reconfigure pass. Without this,
        // a reconfigured cell keeps its stale height until something else
        // forces a layout pass (e.g. the user scrolling).
        collectionView.selfSizingInvalidation = .enabledIncludingConstraints
        view.addSubview(collectionView)

        let reg = UICollectionView.CellRegistration<UICollectionViewCell, ChatItem<Payload>> {
            [weak self] cell, _, wrapper in
            guard let self else { return }
            cell.contentConfiguration = UIHostingConfiguration {
                self.rowContent(wrapper.payload)
            }
            .margins(.all, 0)
        }

        dataSource = UICollectionViewDiffableDataSource(
            collectionView: collectionView
        ) { cv, indexPath, item in
            cv.dequeueConfiguredReusableCell(using: reg, for: indexPath, item: item)
        }

        if let pending = pendingSnapshot {
            pendingSnapshot = nil
            applySnapshot(items: pending.items, isNearBottom: pending.isNearBottom, forceScroll: pending.forceScroll)
        }
    }

    private func makeLayout() -> UICollectionViewCompositionalLayout {
        let itemSize = NSCollectionLayoutSize(
            widthDimension: .fractionalWidth(1),
            heightDimension: .estimated(44)
        )
        let item = NSCollectionLayoutItem(layoutSize: itemSize)
        let group = NSCollectionLayoutGroup.vertical(layoutSize: itemSize, subitems: [item])
        let section = NSCollectionLayoutSection(group: group)
        section.interGroupSpacing = spacing
        section.contentInsets = NSDirectionalEdgeInsets(
            top: 8, leading: horizontalInset,
            bottom: 8, trailing: horizontalInset
        )
        return UICollectionViewCompositionalLayout(section: section)
    }

    // MARK: - Snapshot

    func applySnapshot(
        items: [ChatItem<Payload>],
        isNearBottom: Bool,
        forceScroll: Bool
    ) {
        guard dataSource != nil else {
            pendingSnapshot = (items, isNearBottom, forceScroll)
            return
        }

        let isInitial = !hasAppliedInitialSnapshot && !items.isEmpty
        if isInitial { hasAppliedInitialSnapshot = true }

        // UIKit requires unique identifiers — deduplicate, keeping last occurrence.
        var seen = Set<String>()
        var uniqueItems: [ChatItem<Payload>] = []
        for item in items.reversed() {
            if seen.insert(item.id).inserted {
                uniqueItems.append(item)
            }
        }
        uniqueItems.reverse()

        var snapshot = NSDiffableDataSourceSnapshot<ChatSection, ChatItem<Payload>>()
        snapshot.appendSections([.main])
        snapshot.appendItems(uniqueItems, toSection: .main)

        // Always reconfigure all existing items so hosting configs rebuild
        // with fresh data (streaming content, status changes).
        let existing = dataSource.snapshot().itemIdentifiers
        let toReconfigure = uniqueItems.filter { existing.contains($0) }
        if !toReconfigure.isEmpty {
            snapshot.reconfigureItems(toReconfigure)
        }

        dataSource.apply(snapshot, animatingDifferences: false) { [weak self] in
            guard let self else { return }
            if isInitial || forceScroll {
                self.scrollToBottom(animated: false)
            } else if isNearBottom {
                if self.isUserInteracting {
                    // Auto-tail only when the user is near the bottom AND
                    // not actively scrolling. If they're dragging/decelerating
                    // through history we must not yank them back down.
                    // Logged so a wedged-interaction state is visible in
                    // diagnostics instead of silently suppressing the tail.
                    DiagnosticLog.log("CHAT-SCROLL: tail skipped, interacting (tracking=\(self.collectionView.isTracking) dragging=\(self.collectionView.isDragging) decelerating=\(self.collectionView.isDecelerating))")
                } else {
                    self.scrollToBottom(animated: false)
                }
            }
        }
    }

    // MARK: - Scroll

    func scrollToBottom(animated: Bool) {
        // Resolve any pending self-sizing from reconfigured cells so
        // contentSize reflects the streamed content before we compute the
        // target offset. The previous implementation used
        // `scrollToItem(at:.bottom)`, which consults the layout's stale
        // estimated frame for the last item — during streaming (reconfigure-
        // only snapshots, no structural diff) that frame already appeared
        // fully visible, so the call was a no-op and the view stalled at the
        // old bottom until a user-initiated scroll forced re-measurement.
        let sizeBefore = collectionView.contentSize.height
        collectionView.layoutIfNeeded()
        let bottom = max(
            collectionView.contentSize.height - collectionView.bounds.height
                + collectionView.adjustedContentInset.bottom,
            -collectionView.adjustedContentInset.top
        )
        collectionView.setContentOffset(CGPoint(x: 0, y: bottom), animated: animated)
        guard !animated else { return }
        // Second pass: the offset change may bring unmeasured cells on
        // screen, growing contentSize again. Re-resolve and snap once more
        // so a single scrollToBottom converges on the true bottom.
        collectionView.layoutIfNeeded()
        let newBottom = max(
            collectionView.contentSize.height - collectionView.bounds.height
                + collectionView.adjustedContentInset.bottom,
            -collectionView.adjustedContentInset.top
        )
        if abs(newBottom - bottom) > 1 {
            DiagnosticLog.log("CHAT-SCROLL: second-pass correction delta=\(newBottom - bottom) sizeBefore=\(sizeBefore) sizeAfter=\(collectionView.contentSize.height)")
            collectionView.setContentOffset(CGPoint(x: 0, y: newBottom), animated: false)
        }
    }

    // MARK: - UIScrollViewDelegate

    private func computeNearBottom() -> Bool {
        let cv = collectionView!
        let distance = cv.contentSize.height - cv.contentOffset.y
            - cv.bounds.height + cv.adjustedContentInset.bottom
        return distance < 100
    }

    func scrollViewDidScroll(_ scrollView: UIScrollView) {
        let near = computeNearBottom()

        // Only flip near→far when the user is actively scrolling.
        // Content growth (streaming) pushes the bottom further away,
        // but the user hasn't scrolled — keep them pinned.
        if nearBottom && !near && !isUserInteracting { return }

        if nearBottom != near {
            nearBottom = near
            onNearBottomChanged?(near)
        }
    }
}
