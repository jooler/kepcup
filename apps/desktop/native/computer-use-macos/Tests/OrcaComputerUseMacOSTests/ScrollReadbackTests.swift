import XCTest
@testable import OrcaComputerUseMacOSCore

final class ScrollReadbackTests: XCTestCase {
    // MARK: fingerprint

    func testRoundsLayoutOffsetsAndSkipsElementsWithoutAFrame() {
        let fingerprint = ScrollReadback.fingerprint([
            (index: 1, identity: "row", y: 120.4),
            (index: 2, identity: "row", y: -3.6),
            (index: 3, identity: "no-frame", y: nil),
            (index: 4, identity: "not-a-number", y: CGFloat.nan),
        ])

        XCTAssertEqual(
            fingerprint.samples,
            [
                ScrollLayoutSample(index: 1, identity: "row", y: 120),
                ScrollLayoutSample(index: 2, identity: "row", y: -4),
            ]
        )
        XCTAssertFalse(fingerprint.truncated)
    }

    func testCapsTheSampleCountSoAScrollNeverWalksTheWholeTreeTwice() {
        let elements = (0..<(ScrollReadback.maxSamples + 40)).map {
            (index: $0, identity: "row", y: CGFloat($0))
        }

        let fingerprint = ScrollReadback.fingerprint(elements)

        XCTAssertEqual(fingerprint.count, ScrollReadback.maxSamples)
        XCTAssertTrue(fingerprint.truncated)
    }

    // MARK: movement

    func testReportsMedianShiftOfTheElementsThatMoved() {
        let before = fingerprint(offsets: [0, 10, 20, 30, 40, 50, 60, 70])
        // Rows 0-2 scroll by 300pt, the rest (a fixed sidebar) stay put.
        let after = fingerprint(offsets: [-300, -290, -280, 30, 40, 50, 60, 70])

        XCTAssertEqual(
            ScrollReadback.movement(before: before, after: after),
            .moved(points: -300, changed: 3)
        )
    }

    func testTreatsIdenticalLayoutsAsUnchanged() {
        let before = fingerprint(offsets: [0, 10, 20, 30, 40, 50, 60, 70])

        XCTAssertEqual(
            ScrollReadback.movement(before: before, after: fingerprint(offsets: [0, 10, 20, 30, 40, 50, 60, 70])),
            .unchanged
        )
    }

    func testIgnoresSubPointJitter() {
        let before = fingerprint(offsets: [0, 10, 20, 30, 40, 50, 60, 70])
        // 0.4pt round-trip changes are dropped by the 1pt quantisation.
        let after = ScrollReadback.fingerprint([
            (index: 0, identity: "row:0", y: 0.4),
            (index: 1, identity: "row:1", y: 10.4),
            (index: 2, identity: "row:2", y: 20.4),
            (index: 3, identity: "row:3", y: 30.4),
            (index: 4, identity: "row:4", y: 40.4),
            (index: 5, identity: "row:5", y: 50.4),
            (index: 6, identity: "row:6", y: 60.4),
            (index: 7, identity: "row:7", y: 70.4),
        ])

        XCTAssertEqual(ScrollReadback.movement(before: before, after: after), .unchanged)
    }

    func testDoesNotCompareDifferentElementsThatReusedAnIndex() {
        let before = ScrollReadback.fingerprint([(index: 1, identity: "AXButton 上一页", y: 10)])
        let after = ScrollReadback.fingerprint([(index: 1, identity: "AXButton 下一页", y: 900)])

        XCTAssertEqual(
            ScrollReadback.movement(before: before, after: after),
            .notComparable(matched: 0, total: 1)
        )
    }

    func testRefusesToJudgeWhenTooFewSamplesSurvivedARerender() {
        let before = fingerprint(offsets: [0, 10, 20, 30, 40, 50, 60, 70])
        let after = ScrollReadback.fingerprint([
            (index: 100, identity: "row", y: -900),
            (index: 101, identity: "row", y: -860),
        ])

        XCTAssertEqual(
            ScrollReadback.movement(before: before, after: after),
            .notComparable(matched: 0, total: 2)
        )
    }

    func testMovedIsTheOnlyOutcomeThatCountsAsMovement() {
        XCTAssertTrue(ScrollReadback.isMoved(.moved(points: -300, changed: 3)))
        XCTAssertFalse(ScrollReadback.isMoved(.unchanged))
        XCTAssertFalse(ScrollReadback.isMoved(.notComparable(matched: 0, total: 2)))
    }

    func testPreviewsSayWhatTheReadbackSaw() {
        XCTAssertEqual(
            ScrollReadback.preview(.moved(points: -312, changed: 41)),
            "滚动后内容上移 312pt（41 个元素位置变化）"
        )
        XCTAssertEqual(
            ScrollReadback.preview(.unchanged),
            "滚动前后 AX 布局指纹完全一致，内容没有移动"
        )
        XCTAssertEqual(
            ScrollReadback.preview(.notComparable(matched: 2, total: 9)),
            "滚动后 AX 树重排，可比样本只有 2/9 个，无法判定是否移动"
        )
    }

    // MARK: wheel delta

    func testLineUnitKeepsTheTwelveLinesPerPageContract() {
        XCTAssertEqual(ScrollWheelPlanner.lines(pages: 1, direction: "down"), ScrollWheelDelta(wheel1: -12, wheel2: 0))
        XCTAssertEqual(ScrollWheelPlanner.lines(pages: 3, direction: "up"), ScrollWheelDelta(wheel1: 36, wheel2: 0))
        XCTAssertEqual(ScrollWheelPlanner.lines(pages: 1, direction: "left"), ScrollWheelDelta(wheel1: 0, wheel2: 12))
        XCTAssertEqual(ScrollWheelPlanner.lines(pages: 2.5, direction: "right"), ScrollWheelDelta(wheel1: 0, wheel2: -30))
    }

    func testLineUnitNeverDropsBelowOneLine() {
        XCTAssertEqual(ScrollWheelPlanner.lines(pages: 0.01, direction: "down"), ScrollWheelDelta(wheel1: -1, wheel2: 0))
    }

    func testPixelUnitScalesPagesByLinesPerPage() {
        XCTAssertEqual(ScrollWheelPlanner.pixels(pages: 1, direction: "down"), ScrollWheelDelta(wheel1: -480, wheel2: 0))
        XCTAssertEqual(ScrollWheelPlanner.pixels(pages: 0.5, direction: "up"), ScrollWheelDelta(wheel1: 240, wheel2: 0))
    }

    func testRejectsOutOfRangeAndUnknownInputs() {
        XCTAssertNil(ScrollWheelPlanner.lines(pages: 0, direction: "down"))
        XCTAssertNil(ScrollWheelPlanner.lines(pages: .infinity, direction: "down"))
        XCTAssertNil(ScrollWheelPlanner.lines(pages: 1_000_000_000, direction: "down"))
        XCTAssertNil(ScrollWheelPlanner.lines(pages: 1, direction: "sideways"))
        XCTAssertNil(ScrollWheelPlanner.pixels(pages: .nan, direction: "down"))
    }

    private func fingerprint(offsets: [CGFloat]) -> ScrollLayoutFingerprint {
        ScrollReadback.fingerprint(
            offsets.enumerated().map { (index: $0.offset, identity: "row:\($0.offset)", y: $0.element) }
        )
    }
}
