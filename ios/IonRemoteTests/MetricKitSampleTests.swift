import XCTest
@testable import IonRemote

/// A day's MetricKit payload, as Apple's JSON representation writes it,
/// becomes one `metrickit sample` line whose numbers are numbers.
final class MetricKitSampleTests: XCTestCase {

    /// The shape of `MXMetricPayload.jsonRepresentation()`: unit-bearing
    /// measurement strings with thousands separators, and histograms keyed by
    /// bucket index. `histogrammedTimeToFirstDrawKey` is the key Apple writes.
    static let fixture = """
    {
      "applicationLaunchMetrics": {
        "histogrammedTimeToFirstDrawKey": {
          "histogramNumBuckets": 3,
          "histogramValue": {
            "0": {"bucketCount": 2, "bucketStart": "1000 ms", "bucketEnd": "1010 ms"},
            "1": {"bucketCount": 5, "bucketStart": "2000 ms", "bucketEnd": "2010 ms"},
            "2": {"bucketCount": 3, "bucketStart": "3000 ms", "bucketEnd": "3010 ms"}
          }
        }
      },
      "applicationResponsivenessMetrics": {
        "histogrammedAppHangTime": {
          "histogramNumBuckets": 2,
          "histogramValue": {
            "0": {"bucketCount": 4, "bucketStart": "0 ms", "bucketEnd": "100 ms"},
            "1": {"bucketCount": 1, "bucketStart": "1 sec", "bucketEnd": "2 sec"}
          }
        }
      },
      "applicationTimeMetrics": {
        "cumulativeForegroundTime": "700 sec",
        "cumulativeBackgroundTime": "40 sec"
      },
      "networkTransferMetrics": {
        "cumulativeCellularDownload": "80,000 kB",
        "cumulativeCellularUpload": "70 MB",
        "cumulativeWifiDownload": "60,000 kB",
        "cumulativeWifiUpload": "512 bytes"
      },
      "metaData": {"appBuildVersion": "412", "osVersion": "iPhone OS 17.0", "deviceType": "iPhone15,3"},
      "timeStampBegin": "2026-10-05 00:00:00 +0000",
      "timeStampEnd": "2026-10-06 00:00:00 +0000"
    }
    """

    func testThePayloadMapsToTheSampleLinesNumbers() throws {
        let sample = try XCTUnwrap(MetricKitSample.parse(Data(Self.fixture.utf8)))
        let numbers = sample.numbers
        XCTAssertEqual(numbers["launches"], 10)
        XCTAssertEqual(numbers["launch_p50_ms"], 2005, "the median launch falls in the 2000 ms bucket, taken at its midpoint")
        XCTAssertEqual(numbers["hang_count"], 5)
        XCTAssertEqual(numbers["hang_p50_ms"], 50)
        XCTAssertEqual(numbers["hang_total_ms"], 4 * 50 + 1500)
        XCTAssertEqual(numbers["foreground_ms"], 700_000)
        XCTAssertEqual(try XCTUnwrap(numbers["hang_rate"]), 1700.0 / 700_000, accuracy: 1e-9)
        XCTAssertEqual(numbers["cellular_rx_bytes"], 80_000_000)
        XCTAssertEqual(numbers["cellular_tx_bytes"], 70_000_000)
        XCTAssertEqual(numbers["wifi_rx_bytes"], 60_000_000)
        XCTAssertEqual(numbers["wifi_tx_bytes"], 512)
        XCTAssertEqual(sample.fields, [
            "period_start": "2026-10-05 00:00:00 +0000",
            "period_end": "2026-10-06 00:00:00 +0000",
            "app_build": "412"
        ])
    }

    func testAPayloadMissingAMetricLeavesItsNumberOut() throws {
        let sample = try XCTUnwrap(MetricKitSample.parse(Data(#"{"applicationTimeMetrics":{"cumulativeForegroundTime":"5 min"}}"#.utf8)))
        XCTAssertEqual(sample.numbers, ["foreground_ms": 300_000])
        XCTAssertEqual(sample.fields, [:])
        XCTAssertNil(MetricKitSample.parse(Data("[]".utf8)), "an array is not a payload")
        XCTAssertNil(MetricKitSample.parse(Data("not json".utf8)))
    }

    func testTheSampleLineIsWrittenWithNumericFields() throws {
        let sample = try XCTUnwrap(MetricKitCrashObserver.logSample(json: Data(Self.fixture.utf8)))
        XCTAssertEqual(sample.launches, 10)
        DiagnosticLog.flush()
        let line = try XCTUnwrap(DiagnosticLog.exportCurrentSession().components(separatedBy: "\n").last { $0.contains("\"metrickit sample\"") })
        let obj = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(line.utf8)) as? [String: Any])
        XCTAssertEqual(obj["tag"] as? String, "metrics.metrickit")
        let fields = try XCTUnwrap(obj["fields"] as? [String: Any])
        XCTAssertEqual(fields["launch_p50_ms"] as? Double, 2005)
        XCTAssertEqual(fields["hang_count"] as? Double, 5)
        XCTAssertEqual(fields["app_build"] as? String, "412")
        XCTAssertNil(MetricKitCrashObserver.logSample(json: Data("[]".utf8)))
    }
}
