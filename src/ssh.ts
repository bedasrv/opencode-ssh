import { createHash } from "node:crypto"
import { homedir } from "node:os"
import { join } from "node:path"

export type ProcessRunner = {
  run(file: string, args: string[], options?: { timeout?: number }): Promise<{ stdout: string; stderr: string; code: number }>
}

export type FileOps = {
  mkdir(path: string, options: { recursive: boolean; mode: number }): Promise<void>
  rm(path: string, options?: { force?: boolean }): Promise<void>
  exists(path: string): Promise<boolean>
}

export type ConnectionState = { host: string; socketPath: string }

export type ShellExecuteBeforeEvent = {
  tool: string
  sessionID: string
  input: unknown
}

export function quotePosix(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`
}

export function socketPath(home: string, sessionID: string, host: string): string {
  const id = createHash("sha256").update(`${sessionID}\0${host}`).digest("hex").slice(0, 32)
  return join(home, ".ssh", "opencode-ssh", `${id}.sock`)
}

export function validateHost(host: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(host) || host.startsWith("-")) {
    throw new Error(`Invalid SSH host: ${host}`)
  }
}

export function wrapRemoteCommand(socket: string, host: string, command: string): string {
  const prefix = `ssh -S ${quotePosix(socket)} ${quotePosix(host)} `
  return command.startsWith(prefix) ? command : `${prefix}${quotePosix(command)}`
}

export function transformShellExecuteBefore(
  event: ShellExecuteBeforeEvent,
  getState: (sessionID: string) => ConnectionState | undefined,
): void {
  if (event.tool !== "shell") return
  if (!isRecord(event.input) || typeof event.input.command !== "string") return
  const state = getState(event.sessionID)
  if (!state) return
  event.input.command = wrapRemoteCommand(state.socketPath, state.host, event.input.command)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function describeError(error: unknown): string {
  if (!(error instanceof Error)) return String(error)
  const stderr = (error as { stderr?: unknown }).stderr
  const detail = typeof stderr === "string" ? stderr.trim() : ""
  return detail ? `${error.message}: ${detail}` : error.message
}

export class SshConnections {
  private readonly states = new Map<string, ConnectionState>()
  private readonly operations = new Map<string, Promise<void>>()
  private readonly options: { home: string; runner: ProcessRunner; fs: FileOps }

  constructor(options: { home?: string; runner: ProcessRunner; fs: FileOps }) {
    this.options = { ...options, home: options.home ?? homedir() }
  }

  get(sessionID: string): ConnectionState | undefined { return this.states.get(sessionID) }

  /** Serializes per-session async operations so connect/disconnect cannot interleave. */
  private runExclusive<T>(sessionID: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.operations.get(sessionID) ?? Promise.resolve()
    const result = previous.then(operation)
    const settled = result.then(() => {}, () => {})
    this.operations.set(sessionID, settled)
    void settled.then(() => {
      if (this.operations.get(sessionID) === settled) this.operations.delete(sessionID)
    })
    return result
  }

  connect(sessionID: string, host: string): Promise<ConnectionState> {
    return this.runExclusive(sessionID, () => this.connectUnlocked(sessionID, host))
  }

  private async connectUnlocked(sessionID: string, host: string): Promise<ConnectionState> {
    validateHost(host)
    const existing = this.states.get(sessionID)
    if (existing?.host === host) {
      try {
        await this.options.runner.run("ssh", ["-O", "check", "-S", existing.socketPath, host], { timeout: 5000 })
        return existing
      } catch {
        await this.disconnectUnlocked(sessionID)
      }
    } else {
      await this.disconnectUnlocked(sessionID)
    }
    const socket = socketPath(this.options.home, sessionID, host)
    await this.options.fs.mkdir(join(this.options.home, ".ssh", "opencode-ssh"), { recursive: true, mode: 0o700 })
    try {
      if (await this.options.fs.exists(socket)) {
        try {
          await this.options.runner.run("ssh", ["-O", "check", "-S", socket, host], { timeout: 5000 })
          const state = { host, socketPath: socket }
          this.states.set(sessionID, state)
          return state
        } catch {
          await this.options.fs.rm(socket, { force: true })
        }
      }
      await this.options.runner.run("ssh", ["-MNf", "-S", socket, host], { timeout: 15000 })
      const state = { host, socketPath: socket }
      this.states.set(sessionID, state)
      return state
    } catch (error) {
      await this.options.fs.rm(socket, { force: true }).catch(() => {})
      throw new Error(`Failed to connect to ${host}: ${describeError(error)}`)
    }
  }

  disconnect(sessionID: string): Promise<void> {
    return this.runExclusive(sessionID, () => this.disconnectUnlocked(sessionID))
  }

  private async disconnectUnlocked(sessionID: string): Promise<void> {
    const state = this.states.get(sessionID)
    if (!state) return
    this.states.delete(sessionID)
    try { await this.options.runner.run("ssh", ["-O", "stop", "-S", state.socketPath, state.host], { timeout: 5000 }) } catch {}
    await this.options.fs.rm(state.socketPath, { force: true }).catch(() => {})
  }

  async cleanup(): Promise<void> {
    for (;;) {
      const inFlight = [...this.operations.values()]
      if (inFlight.length === 0) break
      await Promise.all(inFlight)
    }
    await Promise.all([...this.states.keys()].map((sessionID) => this.disconnect(sessionID)))
  }
}
