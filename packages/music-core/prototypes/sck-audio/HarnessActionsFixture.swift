// Fake consent and child values only. This fixture imports no screen-permission API.
private enum HarnessFixtureError: Error { case unexpectedAction }
for grant in [false, true] {
    var permissionCalls = 0
    var launches = [Int]()
    let actions = HarnessActions<Int>(requestScreen: { permissionCalls += 1; return grant }, launch: { launches.append($0) })
    guard actions.requestAccess(oneShot: true, used: false, childRunning: false) == grant,
          permissionCalls == 1, launches.isEmpty else { throw HarnessFixtureError.unexpectedAction }
    for (oneShot, used, running) in [(false, false, false), (true, true, false), (true, false, true)] {
        guard actions.requestAccess(oneShot: oneShot, used: used, childRunning: running) == nil,
              permissionCalls == 1, launches.isEmpty else { throw HarnessFixtureError.unexpectedAction }
    }
    guard try !actions.start(7, oneShot: true, used: true, childRunning: false),
          try !actions.start(7, oneShot: true, used: false, childRunning: true),
          launches.isEmpty else { throw HarnessFixtureError.unexpectedAction }
    guard try actions.start(7, oneShot: true, used: false, childRunning: false),
          launches == [7], permissionCalls == 1 else { throw HarnessFixtureError.unexpectedAction }
}
