import SwiftUI
import AVFoundation

// MARK: - QRScannerView

/// Camera-based QR scanner. Used by `RelayPairingSheet` to scan the
/// `RelayPairingPayload` JSON Ion Studio presents as a QR code (see spec
/// child 19: "enter or scan {relayUrls, channelId, issuer, audience, scope,
/// expiresAt}"). Self-contained AVFoundation capture session — no third-party
/// dependency, since this is the only QR consumer in the app.
struct QRScannerView: UIViewControllerRepresentable {
    /// Called on the main thread with the decoded string the first time a
    /// QR code is recognized. The caller is responsible for dismissing —
    /// this view keeps scanning until its coordinator is torn down.
    let onCode: (String) -> Void

    func makeUIViewController(context: Context) -> QRScannerViewController {
        let controller = QRScannerViewController()
        controller.onCode = onCode
        return controller
    }

    func updateUIViewController(_ uiViewController: QRScannerViewController, context: Context) {}
}

// MARK: - QRScannerViewController

final class QRScannerViewController: UIViewController, AVCaptureMetadataOutputObjectsDelegate {
    var onCode: ((String) -> Void)?

    private let session = AVCaptureSession()
    private var previewLayer: AVCaptureVideoPreviewLayer?
    private var hasEmitted = false

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .black
        configureSession()
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        previewLayer?.frame = view.bounds
    }

    override func viewWillAppear(_ animated: Bool) {
        super.viewWillAppear(animated)
        hasEmitted = false
        if !session.isRunning {
            DiagnosticLog.log("qr scanner: starting capture session", tag: "pairing.relay.scan")
            DispatchQueue.global(qos: .userInitiated).async { [session] in
                session.startRunning()
            }
        }
    }

    override func viewWillDisappear(_ animated: Bool) {
        super.viewWillDisappear(animated)
        if session.isRunning {
            DiagnosticLog.log("qr scanner: stopping capture session", tag: "pairing.relay.scan")
            session.stopRunning()
        }
    }

    private func configureSession() {
        guard let device = AVCaptureDevice.default(for: .video) else {
            DiagnosticLog.log("qr scanner: no camera device available", tag: "pairing.relay.scan", level: .error)
            return
        }
        do {
            let input = try AVCaptureDeviceInput(device: device)
            guard session.canAddInput(input) else {
                DiagnosticLog.log("qr scanner: capture session refused input", tag: "pairing.relay.scan", level: .error)
                return
            }
            session.addInput(input)

            let output = AVCaptureMetadataOutput()
            guard session.canAddOutput(output) else {
                DiagnosticLog.log("qr scanner: capture session refused metadata output", tag: "pairing.relay.scan", level: .error)
                return
            }
            session.addOutput(output)
            output.setMetadataObjectsDelegate(self, queue: .main)
            output.metadataObjectTypes = [.qr]

            let layer = AVCaptureVideoPreviewLayer(session: session)
            layer.videoGravity = .resizeAspectFill
            layer.frame = view.bounds
            view.layer.addSublayer(layer)
            previewLayer = layer

            DiagnosticLog.log("qr scanner: capture session configured", tag: "pairing.relay.scan")
        } catch {
            DiagnosticLog.log("qr scanner: capture session setup failed", tag: "pairing.relay.scan", level: .error, fields: [
                "error": error.localizedDescription
            ])
        }
    }

    func metadataOutput(
        _ output: AVCaptureMetadataOutput,
        didOutput metadataObjects: [AVMetadataObject],
        from connection: AVCaptureConnection
    ) {
        guard !hasEmitted,
              let object = metadataObjects.first as? AVMetadataMachineReadableCodeObject,
              object.type == .qr,
              let value = object.stringValue else { return }
        hasEmitted = true
        DiagnosticLog.log("qr scanner: code recognized", tag: "pairing.relay.scan", fields: [
            "length": String(value.count)
        ])
        onCode?(value)
    }
}
