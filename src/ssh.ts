import { createHash } from "node:crypto"
import { homedir } from "node:os"
import { join } from "node:path"

export type ProcessRunner = {
  run(file: string, args: string[], options?: { timeout?: number }): Promise<{ stdout: string; stderr: string; code: number }>
}

export type FileInfo = { isSymbolicLink(): boolean }

export type FileOps = {
  mkdir(path: string, options: { recursive: boolean; mode: number }): Promise<void>
  rm(path: string, options?: { force?: boolean }): Promise<void>
  exists(path: string): Promise<boolean>
  chmod(path: string, mode: number): Promise<void>
  lstat(path: string): Promise<FileInfo>
}

export type ConnectionState = { host: string; socketPath: string; configPath?: string }

/** Local workspace tools disabled while an SSH session owns the shell. */
export const LOCAL_WORKSPACE_TOOLS = ["read", "write", "edit", "patch", "glob", "grep"] as const

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

/**
 * Always POSIX-quotes the complete command as one SSH argument. Never trusts prefixes.
 * When configPath is set it pins the per-user ssh config with -F so an overridden
 * HOME cannot make OpenSSH silently fall back to a different config file.
 */
export function wrapRemoteCommand(socket: string, host: string, command: string, configPath?: string): string {
  const config = configPath ? `-F ${quotePosix(configPath)} ` : ""
  return `ssh ${config}-S ${quotePosix(socket)} ${quotePosix(host)} ${quotePosix(command)}`
}

function remotePolicyError(tool: string, host: string): Error {
  return new Error(`Tool "${tool}" is unavailable while remote SSH mode is active for ${host}. Use ssh_disconnect to restore local tools.`)
}

type WrapRecord = { original: string; wrapped: string; socket: string; host: string; configPath?: string }
const wrapRecords = new WeakMap<object, WrapRecord>()

/**
 * Rewrites tool executions for sessions in remote mode:
 * - shell: idempotently wraps the command through the session's ControlMaster and
 *   strips local workdir/cwd so nothing local leaks into remote execution.
 * - local workspace tools (read/write/edit/patch/glob/grep): rejected so a stale
 *   tool list captured before ssh_connect cannot touch the workspace mid-turn.
 * Returns true when a remote shell execution was observed.
 */
export function transformShellExecuteBefore(
  event: ShellExecuteBeforeEvent,
  getState: (sessionID: string) => ConnectionState | undefined,
): boolean {
  if (!isRecord(event.input)) return false
  const state = getState(event.sessionID)
  if (!state) return false

  if (event.tool !== "shell") {
    if ((LOCAL_WORKSPACE_TOOLS as readonly string[]).includes(event.tool)) {
      throw remotePolicyError(event.tool, state.host)
    }
    return false
  }

  const input = event.input as { command?: unknown; workdir?: unknown; cwd?: unknown }
  delete input.workdir
  delete input.cwd
  if (typeof input.command !== "string") return false

  const record = wrapRecords.get(event.input)
  if (!record) {
    const wrapped = wrapRemoteCommand(state.socketPath, state.host, input.command, state.configPath)
    wrapRecords.set(event.input, { original: input.command, wrapped, socket: state.socketPath, host: state.host, configPath: state.configPath })
    input.command = wrapped
    return true
  }

  if (
    input.command === record.wrapped &&
    record.socket === state.socketPath &&
    record.host === state.host &&
    record.configPath === state.configPath
  ) {
    return true // unchanged repeat: already wrapped for this exact connection
  }

  // Either another hook changed the command (take the current text as the new
  // payload) or the connection changed (rewind to the original user command);
  // either way rewrap fresh instead of nesting stale state.
  const source = input.command === record.wrapped ? record.original : input.command
  const wrapped = wrapRemoteCommand(state.socketPath, state.host, source, state.configPath)
  wrapRecords.set(event.input, { original: source, wrapped, socket: state.socketPath, host: state.host, configPath: state.configPath })
  input.command = wrapped
  return true
}

export function remoteSystemMessage(host: string): string {
  return `Remote SSH mode is active for ${host}. Shell commands run remotely and ignore OpenCode's local workdir. Local workspace tools are unavailable until you use ssh_disconnect. Do not add SSH yourself.`
}

type RemoteContextLike = {
  tools: Record<string, unknown>
  system: Array<{ type: unknown; text?: unknown }>
}

/** Applies the remote policy to a session context; safe to call repeatedly. */
export function applyRemoteContext(context: RemoteContextLike, host: string): void {
  for (const name of LOCAL_WORKSPACE_TOOLS) delete context.tools[name]
  const text = remoteSystemMessage(host)
  const present = context.system.some((part) => part.type === "text" && part.text === text)
  if (!present) context.system.push({ type: "text", text })
}

export type SessionEventLike = { type?: unknown; data?: unknown }

/**
 * Consumes a v2 event stream and disconnects sessions when they are deleted.
 * stop() aborts iteration, awaits settlement (bounded), and never throws.
 */
export function consumeSessionDeletions(
  events: AsyncIterable<SessionEventLike>,
  onDeleted: (sessionID: string) => Promise<void>,
): { stop(): Promise<void> } {
  let stopped = false
  const consumer = (async () => {
    try {
      for await (const event of events) {
        if (stopped) break
        if (!isRecord(event) || event.type !== "session.deleted") continue
        const data = isRecord(event.data) ? event.data : undefined
        const sessionID = typeof data?.sessionID === "string" ? data.sessionID : undefined
        if (!sessionID) continue
        try { await onDeleted(sessionID) } catch {}
      }
    } catch (error) {
      if (!stopped && !isAbortError(error)) {
        console.warn(`[opencode-ssh] session event stream failed: ${describeError(error)}`)
      }
    }
  })()
  return {
    async stop() {
      if (stopped) return
      stopped = true
      try { await (events as AsyncIterable<unknown> & { return?: () => Promise<unknown> }).return?.() } catch {}
      await Promise.race([consumer, delay(2000)])
    },
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === "AbortError" || /abort/i.test(error.message))
}

function describeError(error: unknown): string {
  if (!(error instanceof Error)) return String(error)
  const stderr = (error as { stderr?: unknown }).stderr
  const detail = typeof stderr === "string" ? stderr.trim() : ""
  return detail ? `${error.message}: ${detail}` : error.message
}

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

export class SshConnections {
  private readonly states = new Map<string, ConnectionState>()
  private readonly disconnecting = new Set<string>()
  private readonly operations = new Map<string, Promise<void>>()
  private readonly shells = new Map<string, number>()
  private closing: Promise<void> | null = null
  private readonly options: { home: string; runner: ProcessRunner; fs: FileOps; shellDrainMs: number }

  constructor(options: { home?: string; runner: ProcessRunner; fs: FileOps; shellDrainMs?: number }) {
    this.options = { ...options, home: options.home ?? homedir(), shellDrainMs: options.shellDrainMs ?? 1000 }
  }

  get(sessionID: string): ConnectionState | undefined { return this.states.get(sessionID) }

  /**
   * Hook-time view used by execute.before: like get(), but throws once a
   * disconnect has begun until its teardown finishes, so a racing shell attempt
   * is rejected instead of finding no state and falling through to local execution.
   */
  getForShell(sessionID: string): ConnectionState | undefined {
    if (this.disconnecting.has(sessionID)) {
      throw new Error(`ssh_disconnect is in progress for this session; new shell commands are rejected until it finishes`)
    }
    return this.states.get(sessionID)
  }

  /** Tracks a remote shell execution starting; no-op without an active connection. */
  noteShellStart(sessionID: string): void {
    if (!this.states.has(sessionID)) return
    this.shells.set(sessionID, (this.shells.get(sessionID) ?? 0) + 1)
  }

  /** Tracks a remote shell execution ending; clamped at zero. */
  noteShellEnd(sessionID: string): void {
    const count = this.shells.get(sessionID) ?? 0
    if (count <= 1) this.shells.delete(sessionID)
    else this.shells.set(sessionID, count - 1)
  }

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
    if (this.closing) {
      // Reject immediately; awaiting cleanup here would leave callers hanging
      // for the whole drain window before learning shutdown has begun.
      return Promise.reject(new Error("opencode-ssh is shutting down; start a new session to reconnect"))
    }
    return this.runExclusive(sessionID, () => this.connectUnlocked(sessionID, host))
  }

  private async connectUnlocked(sessionID: string, host: string): Promise<ConnectionState> {
    validateHost(host)
    const existing = this.states.get(sessionID)
    if (existing?.host === host) {
      try {
        await this.options.runner.run("ssh", this.sshArgs(["-O", "check", "-S", existing.socketPath, host], existing.configPath), { timeout: 5000 })
        return existing
      } catch {
        await this.disconnectUnlocked(sessionID)
      }
    } else {
      await this.disconnectUnlocked(sessionID)
    }
    const socket = socketPath(this.options.home, sessionID, host)
    const dir = join(this.options.home, ".ssh", "opencode-ssh")
    const userConfig = join(this.options.home, ".ssh", "config")
    const configPath = (await this.options.fs.exists(userConfig)) ? userConfig : undefined
    await this.options.fs.mkdir(dir, { recursive: true, mode: 0o700 })
    const info = await this.options.fs.lstat(dir)
    if (info.isSymbolicLink()) {
      throw new Error(`Refusing to follow symlinked SSH socket directory: ${dir}`)
    }
    await this.options.fs.chmod(dir, 0o700)
    try {
      if (await this.options.fs.exists(socket)) {
        try {
          await this.options.runner.run("ssh", this.sshArgs(["-O", "check", "-S", socket, host], configPath), { timeout: 5000 })
          const state = { host, socketPath: socket, configPath }
          this.states.set(sessionID, state)
          return state
        } catch {
          await this.options.fs.rm(socket, { force: true })
        }
      }
      await this.options.runner.run("ssh", this.sshArgs(["-MNf", "-o", "BatchMode=yes", "-S", socket, host], configPath), { timeout: 15000 })
      const state = { host, socketPath: socket, configPath }
      this.states.set(sessionID, state)
      return state
    } catch (error) {
      await this.options.fs.rm(socket, { force: true }).catch(() => {})
      throw new Error(`Failed to connect to ${host}: ${describeError(error)}`)
    }
  }

  /** Prepends -F so OpenSSH uses the pinned per-user config instead of resolving one from the process HOME. */
  private sshArgs(args: string[], configPath?: string): string[] {
    return configPath ? ["-F", configPath, ...args] : args
  }

  disconnect(sessionID: string): Promise<void> {
    return this.runExclusive(sessionID, () => this.disconnectUnlocked(sessionID))
  }

  private async disconnectUnlocked(sessionID: string): Promise<void> {
    const state = this.states.get(sessionID)
    if (!state) return
    // Mark disconnecting BEFORE any waiting so shell hooks during the drain
    // throw instead of falling through to local execution; the state stays
    // visible to ordinary get() until teardown completes.
    this.disconnecting.add(sessionID)
    try {
      await this.awaitQuietShells()
      try { await this.options.runner.run("ssh", this.sshArgs(["-O", "stop", "-S", state.socketPath, state.host], state.configPath), { timeout: 5000 }) } catch {}
      await this.options.fs.rm(state.socketPath, { force: true }).catch(() => {})
    } finally {
      this.disconnecting.delete(sessionID)
      this.states.delete(sessionID)
    }
  }

  /** Best-effort bounded wait for in-flight remote shells so masters are not stopped underneath them. */
  private async awaitQuietShells(): Promise<void> {
    const deadline = Date.now() + this.options.shellDrainMs
    while ([...this.shells.values()].some((count) => count > 0) && Date.now() < deadline) {
      await delay(2)
    }
  }

  /** Shutdown barrier: drains accepted connects and active shells, stops every master, idempotent. */
  async cleanup(): Promise<void> {
    if (this.closing) {
      await this.closing
      return
    }
    let finish!: () => void
    this.closing = new Promise<void>((resolve) => { finish = resolve })
    try {
      for (;;) {
        const inFlight = [...this.operations.values()]
        if (inFlight.length === 0) break
        await Promise.all(inFlight)
      }
      await this.awaitQuietShells()
      await Promise.all([...this.states.keys()].map((sessionID) => this.disconnect(sessionID)))
    } finally {
      finish()
      await this.closing
    }
  }
}
