import Foundation

/// 主应用写进 App Group 的目标快照（`targets.v1.json`）。
///
/// 扩展读不到 / 读坏了就显示「打开 KepCup 同步列表」并禁止确认；快照超过
/// 24 小时只提示可能过期，仍允许选（core 确认时按实时数据校验）。
enum ShareTargetsStore {
    /// 快照过期时长（24 小时）。
    static let staleAfterSeconds: Double = 24 * 60 * 60

    enum LoadResult {
        case ok(ShareTargets, isStale: Bool)
        case missing
        case invalid
    }

    static func load() -> LoadResult {
        guard let url = SharedConfig.targetsURL else { return .missing }
        guard let data = try? Data(contentsOf: url) else { return .missing }
        guard let targets = try? JSONDecoder().decode(ShareTargets.self, from: data) else {
            return .invalid
        }
        let age = Date().timeIntervalSince1970 - targets.generatedAt / 1000
        return .ok(targets, isStale: age > staleAfterSeconds)
    }
}
