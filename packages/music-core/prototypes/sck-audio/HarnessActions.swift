// The permission and child-launch boundaries stay separate and can be tested without AppKit.
private struct HarnessActions<Child> {
    let requestScreen: () -> Bool
    let launch: (Child) throws -> Void

    func requestAccess(oneShot: Bool, used: Bool, childRunning: Bool) -> Bool? {
        guard oneShot, !used, !childRunning else { return nil }
        return requestScreen()
    }

    func start(_ child: Child, oneShot: Bool, used: Bool, childRunning: Bool) throws -> Bool {
        guard !childRunning, !oneShot || !used else { return false }
        try launch(child)
        return true
    }
}
