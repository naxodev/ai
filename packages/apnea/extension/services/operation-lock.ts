import * as crypto from "node:crypto"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { Effect } from "effect"
import { ConfigError, OperationLocked } from "../errors.ts"

type Owner = {
  readonly pid: number
  readonly token: string
}

const OWNER_FILE = "owner.json"
const OWNER_LIMIT = 4 * 1024

function lockDirectory(): string {
  const identity =
    typeof process.getuid === "function" ? process.getuid() : "user"
  return path.join(os.tmpdir(), `apnea-${identity}`, "operation-locks")
}

function canonicalRepository(root: string): string {
  return fs.realpathSync(root)
}

export function repositoryLockPath(root: string): string {
  const canonical = canonicalRepository(root)
  const key = crypto
    .createHash("sha256")
    .update(`repository\0${canonical}`)
    .digest("hex")
  return path.join(lockDirectory(), `repository-${key}.lock`)
}

export function globalSetupLockPath(accountHome: string): string {
  const canonical = fs.realpathSync(accountHome)
  const key = crypto
    .createHash("sha256")
    .update(`global-setup\0${canonical}`)
    .digest("hex")
  return path.join(lockDirectory(), `global-setup-${key}.lock`)
}

function ensureLockDirectory(directory: string): void {
  for (const component of [path.dirname(directory), directory]) {
    try {
      fs.mkdirSync(component, { mode: 0o700 })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
    }
    const stat = fs.lstatSync(component)
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new ConfigError({
        message: `unsafe Apnea lock directory: ${component}`,
        path: component,
      })
    }
    if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
      throw new ConfigError({
        message: `Apnea lock directory is not owned by the current user: ${component}`,
        path: component,
      })
    }
    fs.chmodSync(component, 0o700)
  }
}

function isCurrentUser(stat: fs.Stats): boolean {
  return typeof process.getuid !== "function" || stat.uid === process.getuid()
}

function hasPrivateMode(stat: fs.Stats): boolean {
  return process.platform === "win32" || (stat.mode & 0o077) === 0
}

function readOwner(lock: string): Owner | null {
  let descriptor: number | undefined
  try {
    const lockStat = fs.lstatSync(lock)
    if (
      lockStat.isSymbolicLink() ||
      !lockStat.isDirectory() ||
      !isCurrentUser(lockStat) ||
      !hasPrivateMode(lockStat)
    ) {
      return null
    }
    const ownerPath = path.join(lock, OWNER_FILE)
    if (fs.lstatSync(ownerPath).isSymbolicLink()) return null
    descriptor = fs.openSync(
      ownerPath,
      process.platform === "win32"
        ? "r"
        : fs.constants.O_RDONLY |
            fs.constants.O_NOFOLLOW |
            fs.constants.O_NONBLOCK,
    )
    const ownerStat = fs.fstatSync(descriptor)
    if (
      !ownerStat.isFile() ||
      !isCurrentUser(ownerStat) ||
      !hasPrivateMode(ownerStat) ||
      ownerStat.size <= 0 ||
      ownerStat.size > OWNER_LIMIT
    ) {
      return null
    }
    const bytes = Buffer.alloc(ownerStat.size)
    let offset = 0
    while (offset < bytes.length) {
      const read = fs.readSync(
        descriptor,
        bytes,
        offset,
        bytes.length - offset,
        offset,
      )
      if (read === 0) return null
      offset += read
    }
    const value = JSON.parse(bytes.toString("utf8")) as unknown
    if (
      typeof value === "object" &&
      value !== null &&
      "pid" in value &&
      typeof value.pid === "number" &&
      Number.isInteger(value.pid) &&
      value.pid > 0 &&
      "token" in value &&
      typeof value.token === "string" &&
      value.token.length > 0
    ) {
      return { pid: value.pid, token: value.token }
    }
  } catch {
    // Malformed ownership is never safe to remove automatically.
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor)
  }
  return null
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH"
  }
}

function pathExistsNoFollow(target: string): boolean {
  try {
    fs.lstatSync(target)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false
    throw error
  }
}

function fsyncDirectory(directory: string): void {
  const descriptor = fs.openSync(directory, fs.constants.O_RDONLY)
  try {
    try {
      fs.fsyncSync(descriptor)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      const unsupported =
        ["EINVAL", "ENOTSUP", "EOPNOTSUPP"].includes(code ?? "") ||
        (process.platform === "win32" &&
          ["EISDIR", "EPERM"].includes(code ?? ""))
      if (!unsupported) throw error
    }
  } finally {
    fs.closeSync(descriptor)
  }
}

function writeCandidate(directory: string, owner: Owner): void {
  fs.mkdirSync(directory, { mode: 0o700 })
  const ownerPath = path.join(directory, OWNER_FILE)
  const descriptor = fs.openSync(ownerPath, "wx", 0o600)
  try {
    fs.writeFileSync(descriptor, JSON.stringify(owner), "utf8")
    fs.fsyncSync(descriptor)
  } finally {
    fs.closeSync(descriptor)
  }
  fsyncDirectory(directory)
}

function moveOwnedToTombstone(lock: string, token: string): string | null {
  if (readOwner(lock)?.token !== token) return null
  const tombstone = `${lock}.tombstone.${crypto.randomUUID()}`
  try {
    fs.renameSync(lock, tombstone)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null
    throw error
  }
  if (readOwner(tombstone)?.token !== token) return null
  return tombstone
}

function removeIfOwned(lock: string, token: string): void {
  const tombstone = moveOwnedToTombstone(lock, token)
  if (tombstone !== null) {
    fs.rmSync(tombstone, { recursive: true, force: true })
  }
}

function acquireLock(
  lock: string,
  resource: string,
): { lock: string; owner: Owner } {
  ensureLockDirectory(path.dirname(lock))

  for (let attempt = 0; attempt < 3; attempt++) {
    const owner = { pid: process.pid, token: crypto.randomUUID() }
    const candidate = `${lock}.candidate.${owner.token}`
    let contended = false
    try {
      writeCandidate(candidate, owner)
      if (pathExistsNoFollow(lock)) {
        contended = true
      } else {
        try {
          fs.renameSync(candidate, lock)
        } catch (error) {
          if (
            !["EEXIST", "ENOTEMPTY", "EPERM"].includes(
              (error as NodeJS.ErrnoException).code ?? "",
            )
          ) {
            throw error
          }
          contended = true
        }
      }
    } finally {
      fs.rmSync(candidate, { recursive: true, force: true })
    }

    if (!contended) return { lock, owner }

    if (!pathExistsNoFollow(lock)) continue
    const existing = readOwner(lock)
    if (existing === null) {
      throw new OperationLocked({
        message:
          `Apnea lock metadata is malformed at ${lock}. ` +
          `Automatic cleanup is disabled. Verify no Apnea process owns it, then Remove this lock directory manually: ${lock}`,
        repository: resource,
        lock_path: lock,
        reason: "malformed",
        pid: 0,
      })
    }
    if (processIsAlive(existing.pid)) {
      throw new OperationLocked({
        message: `another Apnea operation holds ${lock} for ${resource} (pid ${existing.pid})`,
        repository: resource,
        lock_path: lock,
        reason: "live",
        pid: existing.pid,
      })
    }
    throw new OperationLocked({
      message:
        `Apnea lock owner pid ${existing.pid} is not live at ${lock}. ` +
        `Automatic stale cleanup is disabled. Verify no Apnea process owns it, then Remove this lock directory manually: ${lock}`,
      repository: resource,
      lock_path: lock,
      reason: "stale",
      pid: existing.pid,
    })
  }

  throw new OperationLocked({
    message: `Apnea lock changed repeatedly at ${lock}; retry the operation`,
    repository: resource,
    lock_path: lock,
    reason: "raced",
    pid: 0,
  })
}

function withLock<A, E, R>(
  lock: string,
  resource: string,
  operation: Effect.Effect<A, E, R>,
  waitForRetry?: Effect.Effect<void>,
): Effect.Effect<A, E | OperationLocked | ConfigError, R> {
  const acquireOnce = () =>
    Effect.try({
      try: () => acquireLock(lock, resource),
      catch: (error) =>
        error instanceof OperationLocked || error instanceof ConfigError
          ? error
          : new ConfigError({
              message: `could not acquire Apnea operation lock: ${error instanceof Error ? error.message : String(error)}`,
              path: resource,
            }),
    })
  const acquireEffect = (): Effect.Effect<
    { lock: string; owner: Owner },
    OperationLocked | ConfigError
  > =>
    acquireOnce().pipe(
      Effect.catch((error) =>
        error instanceof OperationLocked &&
        error.reason === "live" &&
        waitForRetry
          ? waitForRetry.pipe(Effect.andThen(acquireEffect()))
          : Effect.fail(error),
      ),
    )
  return Effect.acquireUseRelease(
    acquireEffect(),
    () => operation,
    ({ lock: ownedLock, owner }) =>
      Effect.sync(() => removeIfOwned(ownedLock, owner.token)),
  )
}

export function withRepositoryLock<A, E, R>(
  root: string,
  operation: Effect.Effect<A, E, R>,
): Effect.Effect<A, E | OperationLocked | ConfigError, R> {
  const repository = canonicalRepository(root)
  return withLock(repositoryLockPath(repository), repository, operation)
}

export function withGlobalSetupLock<A, E, R>(
  accountHome: string,
  operation: Effect.Effect<A, E, R>,
  waitForRetry: Effect.Effect<void> = Effect.sleep(25),
): Effect.Effect<A, E | OperationLocked | ConfigError, R> {
  const home = fs.realpathSync(accountHome)
  return withLock(
    globalSetupLockPath(home),
    `global setup at ${home}`,
    operation,
    waitForRetry,
  )
}

/** Global setup lock is always outermost; repository lock is optional and inner. */
export function withSetupLocks<A, E, R>(
  accountHome: string,
  root: string,
  lockRepository: boolean,
  operation: Effect.Effect<A, E, R>,
  waitForRetry?: Effect.Effect<void>,
): Effect.Effect<A, E | OperationLocked | ConfigError, R> {
  return withGlobalSetupLock(
    accountHome,
    lockRepository ? withRepositoryLock(root, operation) : operation,
    waitForRetry,
  )
}
