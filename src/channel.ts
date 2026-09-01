import { randomUUID } from "node:crypto"
import { spawn, type ChildProcess } from "node:child_process"
import { validateHost } from "./ssh.js"
import { promises as fs } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

const MAX_OUTPUT = 64 * 1024
export const MAX_INPUT = 64 * 1024
const MAX_PENDING_INPUT = MAX_INPUT * 128
const MAX_CHANNELS = 8
export const MAX_CLOSED_OWNERS = 256
const SSH_CONFIG = (home: string) => join(home, ".ssh", "config")

function ptyEnvironment(home: string): Record<string, string> {
  const source = globalThis.process.env
  const env: Record<string, string> = { HOME: home, PATH: source.PATH ?? "/usr/local/bin:/usr/bin:/bin", TERM: "xterm-256color" }
  for (const key of ["SSH_AUTH_SOCK", "LANG", "LC_ALL", "LC_CTYPE", "LC_MESSAGES"]) {
    if (source[key]) env[key] = source[key]
  }
  return env
}

export function interactiveSshArgs(home: string, host: string, configExists: boolean): string[] {
  return [...(configExists ? ["-F", SSH_CONFIG(home)] : []), "-o", "BatchMode=yes", "-tt", host]
}

export type ChannelSocket = {
  send(data: string): void
  close(): void
  onData(handler: (data: string) => void): void
  onClose(handler: () => void): void
}

export type PtyTransport = {
  create(input: { command: string; args: string[]; cols: number; rows: number }): Promise<{ id: string }>
  token(id: string): Promise<string>
  connect(id: string, ticket: string): Promise<ChannelSocket>
  resize(id: string, cols: number, rows: number): Promise<void>
  remove(id: string): Promise<void>
}

export type ChannelRecord = {
  id: string
  ownerSessionID: string
  host: string
  ptyID: string
  state: "open" | "closed" | "exited"
  cursor: number
  dropped: number
  output: Uint8Array
  endedAt?: number
}

export type ChannelStatus = Pick<ChannelRecord, "id" | "host" | "state" | "cursor" | "dropped" | "endedAt">

export class SshChannelManager {
  private readonly channels = new Map<string, ChannelRecord>()
  private readonly sockets = new Map<string, ChannelSocket>()
  private readonly closingChannels = new Set<string>()
  private readonly closePromises = new Map<string, Promise<void>>()
  private readonly operations = new Map<string, Promise<unknown>>()
  private closing = false
  private readonly closedOwners = new Set<string>()
  private readonly ownerClosePromises = new Map<string, Promise<void>>()
  private readonly transportRemovals = new Map<string, Promise<void>>()
  private readonly transport: PtyTransport

  constructor(options: { transport: PtyTransport }) { this.transport = options.transport }

  async open(ownerSessionID: string, host: string): Promise<ChannelRecord> {
    validateHost(host)
    return this.serial("__manager__", async () => {
      if (this.closing) throw new Error("channel manager is shutting down")
      if (this.closedOwners.has(ownerSessionID)) throw new Error("session is closed")
      if ([...this.channels.values()].filter((channel) => channel.state === "open").length >= MAX_CHANNELS) throw new Error("maximum open SSH channels reached")
      const pty = await this.transport.create({ command: "ssh", args: ["-o", "BatchMode=yes", "-tt", host], cols: 80, rows: 24 })
      try {
        const socket = await this.transport.connect(pty.id, await this.transport.token(pty.id))
        const record: ChannelRecord = { id: randomUUID(), ownerSessionID, host, ptyID: pty.id, state: "open", cursor: 0, dropped: 0, output: new Uint8Array() }
        this.channels.set(record.id, record)
        this.sockets.set(record.id, socket)
        socket.onData((data) => this.append(record, new TextEncoder().encode(data)))
        socket.onClose(() => { void this.handleExit(record) })
        return record
      } catch (error) {
        await this.transport.remove(pty.id).catch(() => {})
        throw error
      }
    })
  }

  status(ownerSessionID: string, id: string): ChannelStatus {
    const channel = this.owned(ownerSessionID, id)
    return { id: channel.id, host: channel.host, state: channel.state, cursor: channel.cursor, dropped: channel.dropped, ...(channel.endedAt === undefined ? {} : { endedAt: channel.endedAt }) }
  }

  read(ownerSessionID: string, id: string, cursor = 0): { data: Uint8Array; cursor: number; dropped: number; state: ChannelRecord["state"] } {
    const channel = this.owned(ownerSessionID, id)
    const offset = Math.max(cursor, channel.cursor - channel.output.length)
    return { data: channel.output.slice(offset - (channel.cursor - channel.output.length)), cursor: channel.cursor, dropped: channel.dropped, state: channel.state }
  }

  write(ownerSessionID: string, id: string, data: string): void {
    const channel = this.owned(ownerSessionID, id)
    if (channel.state !== "open" || this.closingChannels.has(id)) throw new Error("channel is closed or closing")
    if (new TextEncoder().encode(data).byteLength > MAX_INPUT) throw new Error("channel input is too large")
    const socket = this.sockets.get(id)
    if (!socket) throw new Error("channel socket is unavailable")
    socket.send(data)
  }

  resize(ownerSessionID: string, id: string, cols: number, rows: number): Promise<void> {
    const channel = this.owned(ownerSessionID, id)
    if (channel.state !== "open" || this.closingChannels.has(id)) return Promise.reject(new Error("channel is closed or exited"))
    if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 1 || rows < 1 || cols > 500 || rows > 500) throw new Error("invalid terminal size")
    return this.serial(id, () => this.transport.resize(channel.ptyID, cols, rows))
  }

  close(ownerSessionID: string, id: string): Promise<void> {
    const channel = this.owned(ownerSessionID, id)
    const existing = this.closePromises.get(id)
    if (existing) return existing
    this.closingChannels.add(id)
    const promise = this.serial(id, async () => {
      try {
        if (channel.state === "closed") return
        channel.state = "closed"
        try { this.sockets.get(id)?.close() } catch {}
        this.sockets.delete(id)
        await this.removeTransport(channel)
        this.channels.delete(id)
      } finally {
        this.closingChannels.delete(id)
        this.closePromises.delete(id)
      }
    })
    this.closePromises.set(id, promise)
    return promise
  }

  async closeSession(ownerSessionID: string): Promise<void> {
    this.closedOwners.add(ownerSessionID)
    while (this.closedOwners.size > MAX_CLOSED_OWNERS) this.closedOwners.delete(this.closedOwners.values().next().value as string)
    const existing = this.ownerClosePromises.get(ownerSessionID)
    if (existing) return existing
    const promise = this.serial("__manager__", async () => {
      await Promise.all([...this.channels.values()].filter((c) => c.ownerSessionID === ownerSessionID).map((c) => this.close(ownerSessionID, c.id)))
    })
    this.ownerClosePromises.set(ownerSessionID, promise)
    void promise.then(() => this.ownerClosePromises.delete(ownerSessionID), () => this.ownerClosePromises.delete(ownerSessionID))
    await promise
  }

  async cleanup(): Promise<void> {
    this.closing = true
    await this.serial("__manager__", async () => {
      await Promise.all([...this.channels.values()].map((c) => this.close(c.ownerSessionID, c.id)))
    })
  }

  private owned(owner: string, id: string): ChannelRecord {
    const channel = this.channels.get(id)
    if (!channel || channel.ownerSessionID !== owner) throw new Error("channel not found")
    return channel
  }

  private append(channel: ChannelRecord, data: Uint8Array): void {
    const combined = new Uint8Array(channel.output.length + data.length)
    combined.set(channel.output)
    combined.set(data, channel.output.length)
    channel.cursor += data.length
    if (combined.length > MAX_OUTPUT) { channel.dropped += combined.length - MAX_OUTPUT; channel.output = combined.slice(-MAX_OUTPUT) }
    else channel.output = combined
  }

  private async handleExit(channel: ChannelRecord): Promise<void> {
    if (channel.state !== "open") return
    channel.state = "exited"
    channel.endedAt = Date.now()
    this.sockets.delete(channel.id)
    await this.removeTransport(channel)
    const exited = [...this.channels.values()].filter((item) => item.state === "exited").sort((a, b) => (a.endedAt ?? 0) - (b.endedAt ?? 0))
    while (exited.length > MAX_CHANNELS) this.channels.delete(exited.shift()!.id)
  }

  private removeTransport(channel: ChannelRecord): Promise<void> {
    const existing = this.transportRemovals.get(channel.id)
    if (existing) return existing
    const removal = this.transport.remove(channel.ptyID).catch(() => {}).then(() => {})
    this.transportRemovals.set(channel.id, removal)
    void removal.then(() => this.transportRemovals.delete(channel.id))
    return removal
  }

  private serial<T>(id: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.operations.get(id) ?? Promise.resolve()
    const result = previous.then(operation)
    const settled = result.then(() => {}, () => {})
    this.operations.set(id, settled)
    void settled.then(() => { if (this.operations.get(id) === settled) this.operations.delete(id) })
    return result
  }
}

export function createLocalPtyTransport(options: { home?: string; configExists?: boolean; command?: string; exitWaitMs?: number; spawnProcess?: typeof spawn; stdinWrite?: (child: ChildProcess, data: Uint8Array) => boolean } = {}): PtyTransport {
  type PendingWrite = { data: Uint8Array; resolve?: () => void; reject?: (error: Error) => void }
  type Entry = {
    process: ChildProcess
    exited: Promise<void>
    resolveExit: () => void
    isExited: boolean
    socket?: ChannelSocket
    outputQueue: Uint8Array[]
    outputBytes: number
    dataHandler?: (data: string) => void
    closeHandler?: () => void
    inputQueue: PendingWrite[]
    inputBytes: number
    inputBlocked: boolean
    inputError?: Error
    closeNotified?: boolean
    notifyClose?: () => void
  }
  const processes = new Map<string, Entry>()
  const home = options.home ?? homedir()
  const exitWaitMs = options.exitWaitMs ?? 100
  const waitForExit = async (entry: Entry, timeoutMs: number): Promise<boolean> => {
    let timer!: ReturnType<typeof setTimeout>
    const timeout = new Promise<false>((resolve) => { timer = setTimeout(() => resolve(false), timeoutMs) })
    const exited = entry.exited.then(() => true as const)
    try { return await Promise.race([exited, timeout]) } finally { clearTimeout(timer) }
  }
  return {
    async create(input) {
      const id = randomUUID()
      const command = options.command ?? input.command
      const config = options.configExists ?? await fs.stat(join(home, ".ssh", "config")).then(() => true, () => false)
      const args = command === "ssh" ? interactiveSshArgs(home, input.args.at(-1) ?? "", config) : input.args
        const child = (options.spawnProcess ?? spawn)(process.env.NODE ?? "node", [fileURLToPath(new URL("./pty-helper.js", import.meta.url))], { stdio: ["pipe", "pipe", "pipe"] })
       let resolveExit!: () => void
       const exited = new Promise<void>((resolve) => { resolveExit = resolve })
       const entry = {
         process: child, exited, resolveExit, isExited: false, outputQueue: [], outputBytes: 0,
         inputQueue: [], inputBytes: 0, inputBlocked: false,
       } as Entry
       const failInput = (error: unknown) => {
         entry.inputError = error instanceof Error ? error : new Error(String(error))
         for (const pending of entry.inputQueue) pending.reject?.(entry.inputError)
         entry.inputQueue.length = 0
         entry.inputBytes = 0
       }
       const rejectPendingInput = () => { if (!entry.inputError) failInput(new Error("PTY has exited")) }
       child.stdin!.once("error", failInput)
        const notifyClose = () => { if (!entry.closeNotified) { entry.closeNotified = true; entry.closeHandler?.() } }
        entry.notifyClose = notifyClose
        child.once("exit", () => { entry.isExited = true; rejectPendingInput(); resolveExit(); notifyClose() })
        const ready = helperProtocol(child, (type, data) => {
          if (type === 1) {
            if (entry.dataHandler) entry.dataHandler(new TextDecoder().decode(data))
            else if (entry.outputBytes + data.length <= MAX_OUTPUT) { entry.outputQueue.push(data); entry.outputBytes += data.length }
           } else if (type === 2) {
             entry.isExited = true
             rejectPendingInput()
             notifyClose()
           }
         })
        try { writeInput(entry, frame(0, JSON.stringify({ command, args, home, cols: input.cols, rows: input.rows, env: ptyEnvironment(home) })), false, options.stdinWrite) } catch (error) {
          void ready.catch(() => {})
          try { child.kill("SIGKILL") } catch {}
          throw error
        }
       try { await ready } catch (error) {
          try { child.kill("SIGKILL") } catch {}
          throw error
       }
       processes.set(id, entry)
       return { id }
    },
    async token(id) { if (!processes.has(id)) throw new Error("PTY not found"); return id },
    async connect(id) {
      const entry = processes.get(id)
      if (!entry) throw new Error("PTY not found")
      if (entry.isExited) throw new Error("PTY exited before connection")
        const socket: ChannelSocket = {
         send: (data) => { writeInput(entry, frame(1, new TextEncoder().encode(data))) },
         close: () => { try { writeInput(entry, frame(3, new Uint8Array())) } catch {} },
         onData: (handler) => {
           entry.dataHandler = handler
           for (const data of entry.outputQueue.splice(0)) { entry.outputBytes -= data.length; handler(new TextDecoder().decode(data)) }
         },
          onClose: (handler) => { entry.closeHandler = handler; if (entry.isExited) entry.notifyClose?.() },
        }
        entry.socket = socket
        return socket
     },
       async resize(id, cols, rows) { const entry = processes.get(id); if (!entry) throw new Error("PTY not found"); if (entry.isExited) throw new Error("PTY exited"); await writeInput(entry, frame(2, JSON.stringify({ cols, rows })), true, options.stdinWrite) },
    async remove(id) {
      const entry = processes.get(id)
      if (!entry) return
       if (!entry.isExited) try { entry.process.stdin!.write(frame(3, new Uint8Array())) } catch {}
       if (!await waitForExit(entry, exitWaitMs)) {
         try { entry.process.kill("SIGKILL") } catch {}
        await waitForExit(entry, exitWaitMs)
      }
      if (processes.get(id) === entry) processes.delete(id)
    },
  }
}

const frame = (type: number, payload: string | Uint8Array): Uint8Array => {
  const body = typeof payload === "string" ? new TextEncoder().encode(payload) : payload
  const result = new Uint8Array(5 + body.length)
  new DataView(result.buffer).setUint32(0, body.length + 1)
  result[4] = type
  result.set(body, 5)
  return result
}

function writeInput(entry: {
  process: ChildProcess
  isExited: boolean
  inputQueue: Array<{ data: Uint8Array; resolve?: () => void; reject?: (error: Error) => void }>
  inputBytes: number
  inputBlocked: boolean
  inputError?: Error
}, data: Uint8Array, wait = false, write?: (child: ChildProcess, data: Uint8Array) => boolean): void | Promise<void> {
  if (entry.isExited) throw new Error("PTY has exited")
  if (entry.inputError) throw entry.inputError
  let resolve: (() => void) | undefined
  let reject: ((error: Error) => void) | undefined
  const result = wait ? new Promise<void>((res, rej) => { resolve = res; reject = rej }) : undefined
  const pending = () => {
    if (entry.inputBytes + data.length > MAX_PENDING_INPUT) throw new Error("PTY input queue is full")
    entry.inputQueue.push({ data, resolve, reject })
    entry.inputBytes += data.length
  }
  const flush = () => {
    entry.inputBlocked = false
    while (entry.inputQueue.length && !entry.inputError && !entry.isExited) {
      const next = entry.inputQueue.shift()!
      entry.inputBytes -= next.data.length
      try {
         if (!(write?.(entry.process, next.data) ?? entry.process.stdin!.write(next.data))) {
          entry.inputBlocked = true
          entry.process.stdin!.once("drain", flush)
        }
        next.resolve?.()
      } catch (error) {
        const failure = error instanceof Error ? error : new Error(String(error))
        next.reject?.(failure)
        entry.inputError = failure
        break
      }
      if (entry.inputBlocked) break
    }
    if (entry.inputError) {
      const failure = entry.inputError
      for (const next of entry.inputQueue) next.reject?.(failure)
      entry.inputQueue.length = 0
      entry.inputBytes = 0
    }
  }
  if (entry.inputBlocked || entry.inputQueue.length) pending()
  else {
    try {
       if (!(write?.(entry.process, data) ?? entry.process.stdin!.write(data))) {
        entry.inputBlocked = true
        entry.process.stdin!.once("drain", flush)
      }
      resolve?.()
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error))
      reject?.(failure)
      throw failure
    }
  }
  return result
}

function helperProtocol(child: ChildProcess, handler: (type: number, payload: Uint8Array) => void): Promise<void> {
  let buffer = new Uint8Array()
  let settled = false
  let ready!: () => void
  let rejectReady!: (error: Error) => void
  const result = new Promise<void>((resolve, reject) => { ready = resolve; rejectReady = reject })
  child.stdout!.on("data", (chunk: Uint8Array) => {
    const next = new Uint8Array(buffer.length + chunk.length); next.set(buffer); next.set(chunk, buffer.length); buffer = next
    while (buffer.length >= 4) {
      const length = new DataView(buffer.buffer, buffer.byteOffset).getUint32(0)
      if (length > 1024 * 1024) {
        settled = true
        try { child.kill("SIGKILL") } catch {}
        handler(2, new Uint8Array())
        rejectReady(new Error("PTY frame is too large"))
        return
      }
      if (buffer.length < length + 4) break
      const type = buffer[4]; const payload = buffer.slice(5, length + 4); buffer = buffer.slice(length + 4)
      if (type === 0) { settled = true; ready() } else if (type === 4) { settled = true; rejectReady(new Error(new TextDecoder().decode(payload))) } else handler(type, payload)
    }
  })
  child.once("error", (error) => { if (!settled) { settled = true; rejectReady(error instanceof Error ? error : new Error(String(error))) } })
  child.once("exit", (code, signal) => {
    if (!settled) setTimeout(() => { if (!settled) { settled = true; rejectReady(new Error(`PTY helper exited before ready (${code ?? signal ?? "unknown"})`)) } }, 25)
  })
  return result
}
