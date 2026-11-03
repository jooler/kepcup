import CoreGraphics
import Foundation

/// 滚动投递后的一次布局读回样本。
///
/// Why: 滚轮没有可断言属性（没有 focusedText / selection / value 这类能读回的目标值），
/// 只能比较「窗口内元素的布局有没有移动」。`identity` 用快照里已有的元素签名
/// （role / title / label / actions，**不含 frame**）确认两次观察里是同一个元素；
/// `y` 取整到 1pt，避免子像素抖动被当成位移。
public struct ScrollLayoutSample: Equatable, Sendable {
    public let index: Int
    public let identity: String
    public let y: Int

    public init(index: Int, identity: String, y: Int) {
        self.index = index
        self.identity = identity
        self.y = y
    }
}

public struct ScrollLayoutFingerprint: Equatable, Sendable {
    public let samples: [ScrollLayoutSample]
    public let truncated: Bool

    public init(samples: [ScrollLayoutSample], truncated: Bool) {
        self.samples = samples
        self.truncated = truncated
    }

    public var count: Int { samples.count }
}

/// 滚动前后布局比较的结论。
public enum ScrollMovement: Equatable, Sendable {
    /// 内容移动了：`points` 是多数元素的位移中位数（正数 = 内容下移，负数 = 内容上移）。
    case moved(points: Int, changed: Int)
    /// 两次观察里同一批元素的位置完全一致。
    case unchanged
    /// 可比样本太少（元素被重排 / 虚拟列表整体替换），无从判断。
    case notComparable(matched: Int, total: Int)
}

public enum ScrollReadback {
    /// 单次读回最多比较的元素数：够判定「动没动」，又不至于为一次滚动多走一遍整棵树。
    public static let maxSamples = 512
    /// 少于这个可比样本数就不下结论（窗口刚切换 / 树被裁剪）。
    public static let minimumComparableSamples = 8
    /// 至少这么多个元素换了位置才算「移动」，单点抖动不算。
    public static let minimumMovedSamples = 3

    public static func fingerprint(
        _ elements: [(index: Int, identity: String, y: CGFloat?)]
    ) -> ScrollLayoutFingerprint {
        var samples: [ScrollLayoutSample] = []
        samples.reserveCapacity(min(elements.count, maxSamples))
        for element in elements {
            guard let y = element.y, y.isFinite else { continue }
            if samples.count == maxSamples {
                return ScrollLayoutFingerprint(samples: samples, truncated: true)
            }
            samples.append(
                ScrollLayoutSample(
                    index: element.index,
                    identity: element.identity,
                    y: Int(y.rounded())
                )
            )
        }
        return ScrollLayoutFingerprint(samples: samples, truncated: false)
    }

    public static func movement(
        before: ScrollLayoutFingerprint,
        after: ScrollLayoutFingerprint
    ) -> ScrollMovement {
        var previous: [Int: ScrollLayoutSample] = [:]
        previous.reserveCapacity(before.samples.count)
        for sample in before.samples where previous[sample.index] == nil {
            previous[sample.index] = sample
        }
        var matched = 0
        var deltas: [Int] = []
        for sample in after.samples {
            guard let old = previous[sample.index], old.identity == sample.identity else { continue }
            matched += 1
            let delta = sample.y - old.y
            if abs(delta) >= 1 {
                deltas.append(delta)
            }
        }
        guard matched >= minimumComparableSamples else {
            return .notComparable(matched: matched, total: after.samples.count)
        }
        guard deltas.count >= minimumMovedSamples else { return .unchanged }
        return .moved(points: median(deltas), changed: deltas.count)
    }

    /// 读回结论的人话（写进 verification.actualPreview，模型据此判断要不要重做）。
    public static func preview(_ movement: ScrollMovement) -> String {
        switch movement {
        case let .moved(points, changed):
            let direction = points < 0 ? "上移" : "下移"
            return "滚动后内容\(direction) \(abs(points))pt（\(changed) 个元素位置变化）"
        case .unchanged:
            return "滚动前后 AX 布局指纹完全一致，内容没有移动"
        case let .notComparable(matched, total):
            return "滚动后 AX 树重排，可比样本只有 \(matched)/\(total) 个，无法判定是否移动"
        }
    }

    /// 布局移动了但滚动本身不可逐项断言时，仍按 unverified 报，但要说清「动了」。
    public static func isMoved(_ movement: ScrollMovement) -> Bool {
        if case .moved = movement { return true }
        return false
    }

    private static func median(_ values: [Int]) -> Int {
        let sorted = values.sorted()
        if sorted.count % 2 == 1 {
            return sorted[sorted.count / 2]
        }
        let upper = sorted[sorted.count / 2]
        let lower = sorted[sorted.count / 2 - 1]
        return Int((Double(lower) + Double(upper)) / 2)
    }
}

/// 滚轮事件的数量：`pages` 语义不变，只决定换算成什么单位投递。
public struct ScrollWheelDelta: Equatable, Sendable {
    public let wheel1: Int32
    public let wheel2: Int32

    public init(wheel1: Int32, wheel2: Int32) {
        self.wheel1 = wheel1
        self.wheel2 = wheel2
    }
}

public enum ScrollWheelPlanner {
    /// 一「页」的行数（沿既有 12 行/页，`pages` 语义保持不变）。
    public static let linesPerPage: Double = 12
    /// 行 → 像素的换算（Chromium 系自己按 ~40pt/行 折算线单位，这里显式给像素时用同一比例）。
    public static let pixelsPerLine: Double = 40

    public static func lines(pages: Double, direction: String) -> ScrollWheelDelta? {
        guard pages.isFinite, pages > 0 else { return nil }
        // 沿既有取整：不足一行也至少投一行（旧实现是 max(1, (12 * pages).rounded())）。
        let magnitude = max(1, (linesPerPage * pages).rounded())
        return delta(magnitude: magnitude, direction: direction)
    }

    public static func pixels(pages: Double, direction: String) -> ScrollWheelDelta? {
        guard pages.isFinite, pages > 0 else { return nil }
        let magnitude = max(1, (linesPerPage * pixelsPerLine * pages).rounded())
        return delta(magnitude: magnitude, direction: direction)
    }

    private static func delta(magnitude: Double, direction: String) -> ScrollWheelDelta? {
        guard magnitude.isFinite, magnitude >= 1, magnitude < Double(Int32.max) else { return nil }
        let value = Int32(magnitude)
        switch direction {
        case "up":
            return ScrollWheelDelta(wheel1: value, wheel2: 0)
        case "down":
            return ScrollWheelDelta(wheel1: -value, wheel2: 0)
        case "left":
            return ScrollWheelDelta(wheel1: 0, wheel2: value)
        case "right":
            return ScrollWheelDelta(wheel1: 0, wheel2: -value)
        default:
            return nil
        }
    }
}
