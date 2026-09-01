import test from "node:test"
import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"
import plugin, { setupV2, applyV2SessionContext, sshToolRegistrations, sshChannelToolRegistrations } from "../src/index.js"
import * as pluginNamespace from "../src/index.js"
import {
  LOCAL_WORKSPACE_TOOLS,
  applyRemoteContext,
  consumeSessionDeletions,
  quotePosix,
  transformShellExecuteBefore,
  validateHost,
  wrapRemoteCommand,
  SshConnections,
  type ProcessRunner,
} from "../src/ssh.js"
import { SshChannelManager, createLocalPtyTransport, interactiveSshArgs, MAX_INPUT } from "../src/channel.js"

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

type StateMap = Map<string, { host: string; socketPath: string; configPath?: string }>
const stateGetter = (states: StateMap) => (sessionID: string) => states.get(sessionID)

test("channel manager opens an owner-scoped channel record", async () => {
  const socket = { send() {}, close() {}, onData() {}, onClose() {} }
  const manager = new SshChannelManager({ transport: {
    async create() { return { id: "pty-1" } },
    async token() { return "ticket" },
    async connect() { return socket },
    async resize() {},
    async remove() {},
  } })
  const channel = await manager.open("session-one", "alpha")
  assert.equal(channel.ownerSessionID, "session-one")
  assert.equal(channel.host, "alpha")
  assert.equal(manager.status("session-one", channel.id).state, "open")
})

test("channel output is bounded and channels are owner isolated", async () => {
  let onData: ((data: string) => void) | undefined
  const socket = { send() {}, close() {}, onData(handler: (data: string) => void) { onData = handler }, onClose() {} }
  const manager = new SshChannelManager({ transport: {
    async create() { return { id: "pty-1" } }, async token() { return "t" }, async connect() { return socket }, async resize() {}, async remove() {},
  } })
  const channel = await manager.open("one", "alpha")
  onData?.("A".repeat(70_000))
  assert.equal(manager.read("one", channel.id, 0).dropped, 70000 - 65536)
  assert.throws(() => manager.status("two", channel.id), /not found/)
})

test("writes are rejected as soon as close starts", async () => {
  let sent = 0
  let release!: () => void
  const socket = { send() { sent++ }, close() {}, onData() {}, onClose() {} }
  const manager = new SshChannelManager({ transport: {
    async create() { return { id: "pty-1" } }, async token() { return "t" }, async connect() { return socket }, async resize() {},
    async remove() { await new Promise<void>((resolve) => { release = resolve }) },
  } })
  const channel = await manager.open("one", "alpha")
  const closing = manager.close("one", channel.id)
  await Promise.resolve()
  assert.throws(() => manager.write("one", channel.id, "A"), /closed|closing/)
  release()
  await closing
  assert.equal(sent, 0)
})

test("local PTY transport starts ssh with pinned config when present", async () => {
  const transport = createLocalPtyTransport({ home: "/home/test", configExists: true, command: "sh" })
  const created = await transport.create({ command: "sh", args: ["-c", "printf ok"], cols: 80, rows: 24 })
  assert.ok(created.id)
  await transport.remove(created.id)
})

test("interactive SSH argv pins config and disables password prompts", () => {
  assert.deepEqual(interactiveSshArgs("/home/test", "alpha", true), ["-F", "/home/test/.ssh/config", "-o", "BatchMode=yes", "-tt", "alpha"])
})

test("channel writes reject input over the byte limit", async () => {
  const socket = { send() {}, close() {}, onData() {}, onClose() {} }
  const manager = new SshChannelManager({ transport: { async create() { return { id: "p" } }, async token() { return "t" }, async connect() { return socket }, async resize() {}, async remove() {} } })
  const channel = await manager.open("one", "alpha")
  assert.throws(() => manager.write("one", channel.id, "A".repeat(65537)), /too large/i)
})

test("UTF-8 input is limited by encoded bytes", async () => {
  let sent = 0
  const socket = { send(data: string) { sent = new TextEncoder().encode(data).byteLength }, close() {}, onData() {}, onClose() {} }
  const manager = new SshChannelManager({ transport: { async create() { return { id: "p" } }, async token() { return "t" }, async connect() { return socket }, async resize() {}, async remove() {} } })
  const channel = await manager.open("one", "alpha")
  const exact = "é".repeat(MAX_INPUT / 2)
  manager.write("one", channel.id, exact)
  assert.equal(sent, MAX_INPUT)
  assert.throws(() => manager.write("one", channel.id, `${exact}é`), /too large/i)
})

test("resize rejects a channel after PTY exit", async () => {
  let exited!: () => void
  const socket = { send() {}, close() {}, onData() {}, onClose(handler: () => void) { exited = handler } }
  const manager = new SshChannelManager({ transport: { async create() { return { id: "p" } }, async token() { return "t" }, async connect() { return socket }, async resize() {}, async remove() {} } })
  const channel = await manager.open("one", "alpha")
  exited()
  await assert.rejects(() => manager.resize("one", channel.id, 100, 40), /closed|exited/i)
})

test("local PTY output beginning with NUL is preserved", async () => {
  const transport = createLocalPtyTransport({ command: "sh" })
  const created = await transport.create({ command: "sh", args: ["-c", "printf '\\000x'"], cols: 80, rows: 24 })
  const socket = await transport.connect(created.id, await transport.token(created.id))
  const chunks: string[] = []
  await new Promise((resolve) => { socket.onData((data) => { chunks.push(data); resolve(undefined) }) })
  assert.equal(chunks.join(""), "\u0000x")
  await transport.remove(created.id)
})

test("local PTY accepts permitted burst writes despite stdin backpressure", async () => {
  const transport = createLocalPtyTransport({ command: "sh" })
  const created = await transport.create({ command: "sh", args: ["-c", "cat >/dev/null; sleep 1"], cols: 80, rows: 24 })
  const socket = await transport.connect(created.id, await transport.token(created.id))
  const input = "x".repeat(MAX_INPUT)
  assert.doesNotThrow(() => {
    for (let index = 0; index < 100; index++) socket.send(input)
  })
  await transport.remove(created.id)
})

test("local PTY retains output produced before connect", async () => {
  const transport = createLocalPtyTransport({ command: "sh" })
  const created = await transport.create({ command: "sh", args: ["-c", "printf startup; sleep 1"], cols: 80, rows: 24 })
  await delay(50)
  const socket = await transport.connect(created.id, await transport.token(created.id))
  const chunks: string[] = []
  socket.onData((data) => { chunks.push(data) })
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("startup output was lost")), 250)
    const check = () => chunks.join("").includes("startup") ? (clearTimeout(timer), resolve()) : setTimeout(check, 5)
    check()
  })
  await transport.remove(created.id)
  assert.match(chunks.join(""), /startup/)
})

test("local PTY helper preserves output, writes, resize, and lifecycle", async () => {
  const transport = createLocalPtyTransport({ command: "sh" })
  const created = await transport.create({ command: "sh", args: ["-c", "printf '\\000READY'; read value; stty size; printf '<%s>' \"$value\""], cols: 80, rows: 24 })
  const socket = await transport.connect(created.id, await transport.token(created.id))
  const chunks: string[] = []
  let resolveOutput!: () => void
  const output = new Promise<void>((resolve) => { resolveOutput = resolve })
  socket.onData((data) => { chunks.push(data); if (chunks.join("").includes("READY")) resolveOutput() })
  await output
  await transport.resize(created.id, 101, 37)
  socket.send("input\n")
  await new Promise<void>((resolve) => {
    const check = () => chunks.join("").includes("<input>") ? resolve() : setTimeout(check, 5)
    check()
  })
  await transport.remove(created.id)
  assert.match(chunks.join(""), /\u0000READY.*37 101.*<input>/s)
})

test("oversized helper input terminates promptly", async () => {
  const helper = spawn(process.env.NODE ?? "node", [fileURLToPath(new URL("../src/pty-helper.js", import.meta.url))], { stdio: ["pipe", "pipe", "pipe"] })
  const started = Date.now()
  const header = new Uint8Array(4)
  new DataView(header.buffer).setUint32(0, 1024 * 1024 + 1)
  helper.stdin.write(header)
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("oversized helper frame hung")), 250)
    helper.once("exit", () => { clearTimeout(timer); resolve() })
  })
  assert.ok(Date.now() - started < 250)
})

test("oversized helper output terminates the parent transport promptly", async () => {
  const transport = createLocalPtyTransport({ command: "sh" })
  const created = await transport.create({ command: "sh", args: ["-c", "head -c 1048577 /dev/zero"], cols: 80, rows: 24 })
  const socket = await transport.connect(created.id, await transport.token(created.id))
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("oversized parent frame hung")), 250)
    socket.onClose(() => { clearTimeout(timer); resolve() })
  })
  await transport.remove(created.id)
})

test("helper close notification is delivered at most once", async () => {
  const transport = createLocalPtyTransport({ command: "sh" })
  const created = await transport.create({ command: "sh", args: ["-c", "exit 0"], cols: 80, rows: 24 })
  const socket = await transport.connect(created.id, await transport.token(created.id))
  let closes = 0
  socket.onClose(() => { closes++ })
  await delay(100)
  assert.equal(closes, 1)
  await transport.remove(created.id)
})

test("initial synchronous stdin failure kills the spawned helper", async () => {
  let child: ReturnType<typeof spawn> | undefined
  const transport = createLocalPtyTransport({
    command: "sh",
    spawnProcess: ((...args: Parameters<typeof spawn>) => { child = spawn(...args); return child }) as unknown as typeof spawn,
    stdinWrite: () => { throw new Error("synthetic stdin failure") },
  } as unknown as Parameters<typeof createLocalPtyTransport>[0])
  await assert.rejects(() => transport.create({ command: "sh", args: ["-c", "sleep 10"], cols: 80, rows: 24 }), /synthetic stdin failure/)
  assert.ok(child)
  await delay(25)
  assert.equal(child!.exitCode !== null || child!.signalCode !== null, true)
})

test("local PTY resize rejects a missing process", async () => {
  const transport = createLocalPtyTransport({ command: "sh" })
  await assert.rejects(() => transport.resize("missing", 80, 24), /PTY not found/)
})

test("local PTY removal waits for the child exit", async () => {
  const transport = createLocalPtyTransport({ command: "sh" })
  const created = await transport.create({ command: "sh", args: ["-c", "sleep 10"], cols: 80, rows: 24 })
  const socket = await transport.connect(created.id, await transport.token(created.id))
  let exited = false
  socket.onClose(() => { exited = true })
  await transport.remove(created.id)
  assert.equal(exited, true)
})

test("local PTY removal escalates without hanging", async () => {
  const transport = createLocalPtyTransport({ command: "sh", exitWaitMs: 10 })
  const created = await transport.create({ command: "sh", args: ["-c", "trap '' TERM; sleep 10"], cols: 80, rows: 24 })
  const started = Date.now()
  await transport.remove(created.id)
  assert.ok(Date.now() - started < 500)
})

test("connect rejects a PTY that exited before connection", async () => {
  const transport = createLocalPtyTransport({ command: "sh" })
  const created = await transport.create({ command: "sh", args: ["-c", "exit 0"], cols: 80, rows: 24 })
  await delay(20)
  await assert.rejects(() => transport.connect(created.id, created.id), /PTY exited/i)
  await transport.remove(created.id)
})

test("write rejects an open record whose socket disappeared", async () => {
  const socket = { send() {}, close() {}, onData() {}, onClose() {} }
  const manager = new SshChannelManager({ transport: { async create() { return { id: "p" } }, async token() { return "t" }, async connect() { return socket }, async resize() {}, async remove() {} } })
  const channel = await manager.open("one", "alpha")
  ;(manager as unknown as { sockets: Map<string, unknown> }).sockets.delete(channel.id)
  assert.throws(() => manager.write("one", channel.id, "x"), /socket/i)
})

test("exit and close racing share safe teardown", async () => {
  let exited!: () => void
  let removed = 0
  const socket = { send() {}, close() {}, onData() {}, onClose(handler: () => void) { exited = handler } }
  const manager = new SshChannelManager({ transport: { async create() { return { id: "p" } }, async token() { return "t" }, async connect() { return socket }, async resize() {}, async remove() { removed++ } } })
  const channel = await manager.open("one", "alpha")
  exited()
  const closing = manager.close("one", channel.id)
  await closing
  assert.equal(removed, 1)
  assert.throws(() => manager.status("one", channel.id), /not found/)
})

test("channel tools are direct tools with explicit schemas", () => {
  const socket = { send() {}, close() {}, onData() {}, onClose() {} }
  const manager = new SshChannelManager({ transport: { async create() { return { id: "p" } }, async token() { return "t" }, async connect() { return socket }, async resize() {}, async remove() {} } })
  const tools = sshChannelToolRegistrations(manager)
  assert.deepEqual(tools.map((tool) => tool.name), ["ssh_channel_open", "ssh_channel_read", "ssh_channel_write", "ssh_channel_status", "ssh_channel_resize", "ssh_channel_close"])
  for (const tool of tools) { assert.ok(tool.input); assert.deepEqual(tool.options, { codemode: false }) }
})

test("direct tool result schemas declare input, output, and metadata", () => {
  const connections = new SshConnections({ runner: new FakeRunner(), fs: memoryFs(new Set()) })
  const tools = [...sshToolRegistrations(connections), ...sshChannelToolRegistrations(new SshChannelManager({ transport: {
    async create() { return { id: "p" } }, async token() { return "t" }, async connect() { return { send() {}, close() {}, onData() {}, onClose() {} } }, async resize() {}, async remove() {},
  } }))]
  for (const tool of tools) { assert.ok(tool.input); assert.ok(tool.output); assert.deepEqual(tool.options, { codemode: false }) }
})

test("channel tools that return results expose promise-like execute results", async () => {
  const socket = { send() {}, close() {}, onData() {}, onClose() {} }
  const manager = new SshChannelManager({ transport: { async create() { return { id: "p" } }, async token() { return "t" }, async connect() { return socket }, async resize() {}, async remove() {} } })
  const channel = await manager.open("owner", "alpha")
  const tools = sshChannelToolRegistrations(manager)
  const context = { sessionID: "owner" }
  for (const [name, args] of [["ssh_channel_read", { id: channel.id }], ["ssh_channel_write", { id: channel.id, data: "input" }], ["ssh_channel_status", { id: channel.id }]] as const) {
    const tool = tools.find((candidate) => candidate.name === name)!
    const result = tool.execute(args as never, context as never)
    assert.equal(typeof (result as PromiseLike<unknown>)?.then, "function", `${name} execute result should be promise-like`)
    await result
  }
  await manager.close("owner", channel.id)
})

test("status exposes only the public channel DTO", async () => {
  const socket = { send() {}, close() {}, onData() {}, onClose() {} }
  const manager = new SshChannelManager({ transport: { async create() { return { id: "private-pty" } }, async token() { return "t" }, async connect() { return socket }, async resize() {}, async remove() {} } })
  const channel = await manager.open("owner", "alpha")
  const status = manager.status("owner", channel.id) as Record<string, unknown>
  assert.deepEqual(Object.keys(status).sort(), ["cursor", "dropped", "host", "id", "state"])
  assert.equal("ownerSessionID" in status, false)
  assert.equal("ptyID" in status, false)
  assert.equal("output" in status, false)
})

test("session close synchronously prevents a queued open", async () => {
  const socket = { send() {}, close() {}, onData() {}, onClose() {} }
  const manager = new SshChannelManager({ transport: { async create() { return { id: "p" } }, async token() { return "t" }, async connect() { return socket }, async resize() {}, async remove() {} } })
  const closing = manager.closeSession("deleted")
  const opening = manager.open("deleted", "alpha")
  await closing
  await assert.rejects(opening, /closed|deleted/i)
})

test("cleanup rejects an open that has not started and leaves no channels", async () => {
  const transport = { async create() { throw new Error("should not create") }, async token() { return "t" }, async connect() { throw new Error("should not connect") }, async resize() {}, async remove() {} }
  const manager = new SshChannelManager({ transport })
  const opening = manager.open("one", "alpha")
  const cleanup = manager.cleanup()
  await assert.rejects(opening, /shutting down/)
  await cleanup
})

test("concurrent closes share teardown and clear markers after transport failure", async () => {
  let calls = 0
  let close!: () => void
  const socket = { send() {}, close() { throw new Error("socket failed") }, onData() {}, onClose() {} }
  const manager = new SshChannelManager({ transport: { async create() { return { id: "p" } }, async token() { return "t" }, async connect() { return socket }, async resize() {}, async remove() { calls++; await new Promise<void>((resolve) => { close = resolve }); throw new Error("remove failed") } } })
  const channel = await manager.open("one", "alpha")
  const first = manager.close("one", channel.id)
  const second = manager.close("one", channel.id)
  assert.equal(first, second)
  await Promise.resolve()
  close()
  await Promise.all([first, second])
  assert.equal(calls, 1)
  assert.throws(() => manager.status("one", channel.id), /not found/)
})

const shellEvent = (sessionID: string, command: string, extra: Record<string, unknown> = {}): {
  tool: string
  sessionID: string
  input: Record<string, unknown>
} => ({ tool: "shell", sessionID, input: { command, ...extra } })

test("quotes POSIX shell values", () => {
  assert.equal(quotePosix("a'b$`c;\n"), "'a'\\''b$`c;\n'")
  assert.equal(quotePosix(""), "''")
})

test("validateHost rejects unsafe hosts", () => {
  assert.throws(() => validateHost("bad;host"), /Invalid SSH host/)
  assert.throws(() => validateHost("-dash"), /Invalid SSH host/)
  assert.doesNotThrow(() => validateHost("my-host"))
})

test("wrapRemoteCommand always wraps the full command as one quoted argument", () => {
  assert.equal(wrapRemoteCommand("/tmp/cm.sock", "my-host", "echo 'hi'"), "ssh -S '/tmp/cm.sock' 'my-host' 'echo '\\''hi'\\'''")
  assert.equal(wrapRemoteCommand("/tmp/cm.sock", "my-host", ""), "ssh -S '/tmp/cm.sock' 'my-host' ''")
  assert.equal(wrapRemoteCommand("/tmp/cm.sock", "my-host", "line1\nline2"), "ssh -S '/tmp/cm.sock' 'my-host' 'line1\nline2'")
  assert.equal(
    wrapRemoteCommand("/tmp/cm.sock", "my-host", "$(rm -rf /); `x`"),
    "ssh -S '/tmp/cm.sock' 'my-host' '$(rm -rf /); `x`'",
  )
})

test("a forged wrapper prefix cannot bypass quoting", () => {
  const forged = "ssh -S '/tmp/cm.sock' 'my-host' ; echo pwned"
  const wrapped = wrapRemoteCommand("/tmp/cm.sock", "my-host", forged)
  const prefix = "ssh -S '/tmp/cm.sock' 'my-host' "
  assert.ok(wrapped.startsWith(prefix))
  assert.equal(wrapped.slice(prefix.length), `'${forged.replaceAll("'", "'\\''")}'`)
})

test("transformShellExecuteBefore wraps once and is idempotent per input object", () => {
  const states: StateMap = new Map([["one", { socketPath: "/tmp/one.sock", host: "alpha" }]])
  const event = shellEvent("one", "pwd")
  assert.equal(transformShellExecuteBefore(event, stateGetter(states)), true)
  const wrapped = "ssh -S '/tmp/one.sock' 'alpha' 'pwd'"
  assert.equal(event.input.command, wrapped)
  assert.equal(transformShellExecuteBefore(event, stateGetter(states)), true)
  assert.equal(event.input.command, wrapped)
})

test("supports the legacy bash shell name and rejects apply_patch remotely", () => {
  const states: StateMap = new Map([["one", { socketPath: "/tmp/one.sock", host: "alpha" }]])
  const bash = { tool: "bash", sessionID: "one", input: { command: "pwd" } }
  assert.equal(transformShellExecuteBefore(bash, stateGetter(states)), true)
  assert.equal(bash.input.command, "ssh -S '/tmp/one.sock' 'alpha' 'pwd'")

  const applyPatch = { tool: "apply_patch", sessionID: "one", input: {} }
  assert.throws(() => transformShellExecuteBefore(applyPatch, stateGetter(states)), /remote SSH mode is active/)
})

test("a forged prefix plus shell syntax is rewrapped, not trusted", () => {
  const states: StateMap = new Map([["one", { socketPath: "/tmp/one.sock", host: "alpha" }]])
  const evil = "ssh -S '/tmp/one.sock' 'alpha' ; echo pwned"
  const event = shellEvent("one", evil)
  transformShellExecuteBefore(event, stateGetter(states))
  const expected = `ssh -S '/tmp/one.sock' 'alpha' '${evil.replaceAll("'", "'\\''")}'`
  assert.equal(event.input.command, expected)
})

test("an externally modified command is rewrapped exactly once", () => {
  const states: StateMap = new Map([["one", { socketPath: "/tmp/one.sock", host: "alpha" }]])
  const event = shellEvent("one", "pwd")
  transformShellExecuteBefore(event, stateGetter(states))
  event.input.command = "echo two"
  transformShellExecuteBefore(event, stateGetter(states))
  assert.equal(event.input.command, "ssh -S '/tmp/one.sock' 'alpha' 'echo two'")
  transformShellExecuteBefore(event, stateGetter(states))
  assert.equal(event.input.command, "ssh -S '/tmp/one.sock' 'alpha' 'echo two'")
})

test("a changed connection rewinds to the original command, not nested stale state", () => {
  const state = { socketPath: "/tmp/one.sock", host: "alpha" }
  const states: StateMap = new Map([["one", state]])
  const event = shellEvent("one", "pwd")
  transformShellExecuteBefore(event, stateGetter(states))
  state.socketPath = "/tmp/two.sock"
  state.host = "beta"
  transformShellExecuteBefore(event, stateGetter(states))
  assert.equal(event.input.command, "ssh -S '/tmp/two.sock' 'beta' 'pwd'")
})

test("a cloned event wraps again but stays fully quoted", () => {
  const states: StateMap = new Map([["one", { socketPath: "/tmp/one.sock", host: "alpha" }]])
  const original = shellEvent("one", "pwd")
  transformShellExecuteBefore(original, stateGetter(states))
  const inner = String(original.input.command)
  const clone = { tool: "shell", sessionID: "one", input: { command: inner } }
  transformShellExecuteBefore(clone, stateGetter(states))
  const expected = `ssh -S '/tmp/one.sock' 'alpha' '${inner.replaceAll("'", "'\\''")}'`
  assert.equal(clone.input.command, expected)
})

test("strips local workdir leakage from remote shell input", () => {
  const states: StateMap = new Map([["one", { socketPath: "/tmp/one.sock", host: "alpha" }]])
  const event = shellEvent("one", "pwd", { workdir: "/home/user/project", cwd: "/elsewhere", timeout: 5000 })
  transformShellExecuteBefore(event, stateGetter(states))
  assert.equal("workdir" in event.input, false)
  assert.equal("cwd" in event.input, false)
  assert.equal(event.input.timeout, 5000)
  assert.match(String(event.input.command), /^ssh -S/)
})

test("rejects local workspace tools while remote mode is active", () => {
  const states: StateMap = new Map([["one", { socketPath: "/tmp/one.sock", host: "alpha" }]])
  for (const tool of LOCAL_WORKSPACE_TOOLS) {
    const event = { tool, sessionID: "one", input: {} }
    assert.throws(() => transformShellExecuteBefore(event, stateGetter(states)), /remote SSH mode is active/, tool)
  }
})

test("allows non-workspace tools and restores pass-through after disconnect", () => {
  const states: StateMap = new Map([["one", { socketPath: "/tmp/one.sock", host: "alpha" }]])
  const allowed = { tool: "question", sessionID: "one", input: { query: "hi" } }
  assert.equal(transformShellExecuteBefore(allowed, stateGetter(states)), false)
  states.delete("one")
  for (const tool of ["write", "patch"]) {
    const event = { tool, sessionID: "one", input: {} }
    assert.doesNotThrow(() => transformShellExecuteBefore(event, stateGetter(states)))
  }
  const shell = shellEvent("one", "pwd")
  assert.equal(transformShellExecuteBefore(shell, stateGetter(states)), false)
  assert.equal(shell.input.command, "pwd")
})

test("ignores malformed shell input", () => {
  const states: StateMap = new Map([["one", { socketPath: "/tmp/one.sock", host: "alpha" }]])
  const event = { tool: "shell", sessionID: "one", input: "nope" }
  assert.equal(transformShellExecuteBefore(event, stateGetter(states)), false)
})

test("applyRemoteContext removes workspace tools, keeps others, and posts the notice once", () => {
  const tools: Record<string, unknown> = {
    read: {}, write: {}, edit: {}, patch: {}, glob: {}, grep: {},
    shell: {}, ssh_connect: {}, ssh_disconnect: {}, question: {}, webfetch: {},
  }
  const system: Array<{ type: string; text?: string }> = []
  const context = { tools, system }
  applyRemoteContext(context, "alpha")
  for (const name of LOCAL_WORKSPACE_TOOLS) assert.equal(name in tools, false, name)
  for (const name of ["shell", "ssh_connect", "ssh_disconnect", "question", "webfetch"]) assert.ok(name in tools, name)
  assert.equal(system.length, 1)
  assert.match(system[0].text ?? "", /alpha/)
  applyRemoteContext(context, "alpha")
  assert.equal(system.length, 1)
})

class FakeRunner implements ProcessRunner {
  calls: Array<{ file: string; args: string[] }> = []
  failures = new Set<string>()
  async run(file: string, args: string[]) {
    this.calls.push({ file, args })
    if (this.failures.has(args[0] ?? "")) throw new Error("connection failed")
    return { stdout: "", stderr: "", code: 0 }
  }
}

function memoryFs(files: Set<string>, options: { symlink?: boolean } = {}) {
  const chmods: Array<{ path: string; mode: number }> = []
  return {
    chmods,
    async mkdir() {},
    async rm(file: string) { files.delete(file) },
    async exists(file: string) { return files.has(file) },
    async chmod(path: string, mode: number) { chmods.push({ path, mode }) },
    async lstat(path: string) {
      void path
      return { isSymbolicLink: () => options.symlink ?? false }
    },
  }
}

class DelayedRunner implements ProcessRunner {
  calls: Array<{ file: string; args: string[] }> = []
  delays = new Map<string, number>()
  async run(file: string, args: string[]) {
    this.calls.push({ file, args })
    const wait = this.delays.get(args[0] ?? "")
    if (wait) await delay(wait)
    return { stdout: "", stderr: "", code: 0 }
  }
}

const stopCalls = (runner: { calls: Array<{ args: string[] }> }) =>
  runner.calls.filter((call) => call.args[0] === "-O" && call.args[1] === "stop").length

test("serializes concurrent same-session connects so only one master starts", async () => {
  const runner = new DelayedRunner()
  runner.delays.set("-MNf", 25)
  const connections = new SshConnections({ home: "/home/test", runner, fs: memoryFs(new Set()) })

  const [first, second] = await Promise.all([connections.connect("one", "alpha"), connections.connect("one", "alpha")])

  assert.equal(runner.calls.filter((call) => call.args[0] === "-MNf").length, 1)
  assert.deepEqual(first, second)
})

test("a disconnect racing an in-flight connect still stops the started master", async () => {
  const runner = new DelayedRunner()
  runner.delays.set("-MNf", 25)
  const connections = new SshConnections({ home: "/home/test", runner, fs: memoryFs(new Set()) })

  await Promise.all([connections.connect("one", "alpha"), connections.disconnect("one")])

  assert.equal(connections.get("one"), undefined)
  assert.equal(stopCalls(runner), 1)
})

test("cleanup waits for in-flight connects and stops newly-started masters", async () => {
  const runner = new DelayedRunner()
  runner.delays.set("-MNf", 25)
  const connections = new SshConnections({ home: "/home/test", runner, fs: memoryFs(new Set()) })

  const connecting = connections.connect("one", "alpha")
  await connections.cleanup()
  await connecting

  assert.equal(connections.get("one"), undefined)
  assert.equal(stopCalls(runner), 1)
})

test("connect failures surface stderr from the ssh process", async () => {
  const runner: ProcessRunner = {
    async run(_file, args) {
      if (args[0] === "-MNf") throw Object.assign(new Error("Command failed"), { stderr: "host key verification failed\n" })
      return { stdout: "", stderr: "", code: 0 }
    },
  }
  const connections = new SshConnections({ home: "/home/test", runner, fs: memoryFs(new Set()) })

  await assert.rejects(() => connections.connect("one", "alpha"), /host key verification failed/)
})

test("isolates sessions, replaces connections, and cleans stale or failed sockets", async () => {
  const runner = new FakeRunner()
  const files = new Set<string>()
  const connections = new SshConnections({
    home: "/home/test",
    runner,
    fs: memoryFs(files),
  })

  const first = await connections.connect("one", "alpha")
  const second = await connections.connect("two", "alpha")
  assert.notEqual(first.socketPath, second.socketPath)
  assert.equal(connections.get("one")?.host, "alpha")
  await connections.connect("one", "beta")
  assert.equal(connections.get("one")?.host, "beta")
  await connections.disconnect("one")
  assert.equal(connections.get("one"), undefined)

  runner.failures.add("-MNf")
  await assert.rejects(() => connections.connect("three", "gamma"), /connection failed/)
  assert.equal(connections.get("three"), undefined)
})

test("reuses a healthy master and removes a stale socket before reconnecting", async () => {
  const runner = new FakeRunner()
  const files = new Set<string>()
  const connections = new SshConnections({ home: "/home/test", runner, fs: memoryFs(files) })
  const first = await connections.connect("one", "alpha")
  files.add(first.socketPath)
  await connections.connect("one", "alpha")
  assert.equal(runner.calls.filter((call) => call.args[0] === "-MNf").length, 1)
  runner.failures.add("-O")
  await connections.connect("one", "alpha")
  assert.equal(runner.calls.filter((call) => call.args[0] === "-MNf").length, 2)
  assert.equal(files.has(first.socketPath), false)
})

test("rejects unsafe hosts", async () => {
  const connections = new SshConnections({ home: "/home/test", runner: new FakeRunner(), fs: memoryFs(new Set()) })
  await assert.rejects(() => connections.connect("one", "bad;host"), /Invalid SSH host/)
})

test("enforces socket directory permissions and refuses symlinked directories", async () => {
  const runner = new FakeRunner()
  const fs = memoryFs(new Set())
  const connections = new SshConnections({ home: "/home/test", runner, fs })
  await connections.connect("one", "alpha")
  assert.deepEqual(fs.chmods, [{ path: "/home/test/.ssh/opencode-ssh", mode: 0o700 }])

  const bad = new SshConnections({ home: "/home/test", runner: new FakeRunner(), fs: memoryFs(new Set(), { symlink: true }) })
  await assert.rejects(() => bad.connect("one", "alpha"), /symlink/i)
})

test("wrapRemoteCommand pins an explicit config with -F only when one is provided", () => {
  assert.equal(wrapRemoteCommand("/tmp/cm.sock", "my-host", "pwd"), "ssh -S '/tmp/cm.sock' 'my-host' 'pwd'")
  assert.equal(
    wrapRemoteCommand("/tmp/cm.sock", "my-host", "echo 'hi'", "/home/test/.ssh/config"),
    "ssh -F '/home/test/.ssh/config' -S '/tmp/cm.sock' 'my-host' 'echo '\\''hi'\\'''",
  )
  assert.equal(
    wrapRemoteCommand("/s", "h", "c", "/odd 'dir/cfg"),
    "ssh -F '/odd '\\''dir/cfg' -S '/s' 'h' 'c'",
  )
})

test("transformShellExecuteBefore wraps through the pinned config and stays idempotent", () => {
  const states: StateMap = new Map([["one", { socketPath: "/tmp/one.sock", host: "alpha", configPath: "/cfg" }]])
  const event = shellEvent("one", "pwd")
  assert.equal(transformShellExecuteBefore(event, stateGetter(states)), true)
  const wrapped = "ssh -F '/cfg' -S '/tmp/one.sock' 'alpha' 'pwd'"
  assert.equal(event.input.command, wrapped)
  assert.equal(transformShellExecuteBefore(event, stateGetter(states)), true)
  assert.equal(event.input.command, wrapped)
})

test("a changed pinned config rewinds to the original command instead of nesting -F flags", () => {
  const state = { socketPath: "/tmp/one.sock", host: "alpha", configPath: "/cfg-a" }
  const states: StateMap = new Map([["one", state]])
  const event = shellEvent("one", "pwd")
  transformShellExecuteBefore(event, stateGetter(states))
  state.configPath = "/cfg-b"
  transformShellExecuteBefore(event, stateGetter(states))
  assert.equal(event.input.command, "ssh -F '/cfg-b' -S '/tmp/one.sock' 'alpha' 'pwd'")
})

test("starts masters with BatchMode=yes so prompts fail fast", async () => {
  const runner = new FakeRunner()
  const connections = new SshConnections({ home: "/home/test", runner, fs: memoryFs(new Set()) })
  await connections.connect("one", "alpha")
  const start = runner.calls.find((call) => call.args[0] === "-MNf")
  assert.ok(start)
  assert.deepEqual(start.args.slice(0, 4), ["-MNf", "-o", "BatchMode=yes", "-S"])
})

test("every ssh invocation pins <home>/.ssh/config with -F whenever it exists", async () => {
  const runner = new FakeRunner()
  const files = new Set<string>(["/home/test/.ssh/config"])
  const connections = new SshConnections({ home: "/home/test", runner, fs: memoryFs(files) })

  const state = await connections.connect("one", "alpha")
  assert.equal(state.configPath, "/home/test/.ssh/config")
  await connections.connect("one", "alpha") // exercises the -O check reuse path
  await connections.disconnect("one")

  const sshCalls = runner.calls.filter((call) => call.file === "ssh")
  assert.ok(sshCalls.length >= 3)
  assert.ok(sshCalls.some((call) => call.args.includes("-MNf")))
  assert.ok(sshCalls.some((call) => call.args.includes("-O")))
  for (const call of sshCalls) {
    assert.deepEqual(call.args.slice(0, 2), ["-F", "/home/test/.ssh/config"], JSON.stringify(call.args))
  }
})

test("without ~/.ssh/config, ssh invocations keep the default layout and no -F", async () => {
  const runner = new FakeRunner()
  const connections = new SshConnections({ home: "/home/test", runner, fs: memoryFs(new Set()) })

  const state = await connections.connect("one", "alpha")
  assert.equal(state.configPath, undefined)
  await connections.disconnect("one")

  const sshCalls = runner.calls.filter((call) => call.file === "ssh")
  assert.ok(sshCalls.length >= 2)
  const start = sshCalls.find((call) => call.args[0] === "-MNf")
  assert.ok(start)
  assert.deepEqual(start.args.slice(0, 4), ["-MNf", "-o", "BatchMode=yes", "-S"])
  for (const call of sshCalls) assert.notEqual(call.args[0], "-F")
})

test("connects made after cleanup begins reject as shutting down", async () => {
  const runner = new DelayedRunner()
  runner.delays.set("-MNf", 25)
  const connections = new SshConnections({ home: "/home/test", runner, fs: memoryFs(new Set()), shellDrainMs: 20 })

  const accepted = connections.connect("one", "alpha")
  const shutdown = connections.cleanup()
  await assert.rejects(() => connections.connect("two", "beta"), /shutting down/i)
  await Promise.all([accepted, shutdown])
  assert.equal(connections.get("one"), undefined)
  assert.equal(stopCalls(runner), 1)
})

test("connect after cleanup begins rejects immediately instead of awaiting shutdown", async () => {
  const runner = new DelayedRunner()
  runner.delays.set("-MNf", 25)
  const connections = new SshConnections({ home: "/home/test", runner, fs: memoryFs(new Set()), shellDrainMs: 20 })

  const accepted = connections.connect("one", "alpha")
  let shutdownSettled = false
  const shutdown = connections.cleanup().then(() => { shutdownSettled = true })

  const failure = await connections.connect("two", "beta").then(() => null, (error: unknown) => error)
  assert.ok(failure instanceof Error)
  assert.match(failure.message, /shutting down/i)
  assert.equal(shutdownSettled, false, "rejection must not wait for cleanup to finish")

  await Promise.all([accepted, shutdown])
  assert.equal(connections.get("one"), undefined)
  assert.equal(stopCalls(runner), 1)
})

test("cleanup is idempotent when awaited twice", async () => {
  const runner = new FakeRunner()
  const connections = new SshConnections({ home: "/home/test", runner, fs: memoryFs(new Set()) })
  await connections.connect("one", "alpha")
  const first = connections.cleanup()
  await Promise.all([first, connections.cleanup()])
  await connections.cleanup()
  assert.equal(stopCalls(runner), 1)
})

test("disconnect waits briefly for active shells before stopping the master", async () => {
  const runner = new FakeRunner()
  const connections = new SshConnections({ home: "/home/test", runner, fs: memoryFs(new Set()), shellDrainMs: 500 })
  await connections.connect("one", "alpha")
  connections.noteShellStart("one")
  connections.noteShellStart("one")
  const closing = connections.disconnect("one")
  await delay(10)
  assert.equal(stopCalls(runner), 0)
  connections.noteShellEnd("one")
  await delay(10)
  assert.equal(stopCalls(runner), 0)
  connections.noteShellEnd("one")
  await closing
  assert.equal(connections.get("one"), undefined)
  assert.equal(stopCalls(runner), 1)
})

test("shell attempts racing an in-flight disconnect are rejected instead of running locally", async () => {
  const runner = new DelayedRunner()
  runner.delays.set("-O", 60) // hold the master stop open so the teardown window is observable
  const connections = new SshConnections({ home: "/home/test", runner, fs: memoryFs(new Set()), shellDrainMs: 300 })

  await connections.connect("one", "alpha")
  const closing = connections.disconnect("one")
  await delay(10) // mid-teardown: state already torn down from the hook's point of view

  const command = "rm -rf ./local-fallback"
  const event = shellEvent("one", command)
  assert.throws(
    () => transformShellExecuteBefore(event, (sessionID) => connections.getForShell(sessionID)),
    /disconnect/i,
  )
  assert.equal(event.input.command, command) // untouched: neither wrapped remotely nor left to run locally
  await closing
  assert.equal(connections.getForShell("one"), undefined)
  assert.equal(stopCalls(runner), 1)
})

test("disconnecting rejects new shells yet lets already-running shells drain", async () => {
  const runner = new FakeRunner()
  const connections = new SshConnections({ home: "/home/test", runner, fs: memoryFs(new Set()), shellDrainMs: 1000 })

  await connections.connect("one", "alpha")
  connections.noteShellStart("one") // a shell that began before disconnect was requested
  const closing = connections.disconnect("one")
  await delay(10)

  assert.ok(connections.get("one"), "state stays visible until teardown finishes")
  assert.throws(() => connections.getForShell("one"), /disconnect/i) // new shells are refused...
  assert.equal(stopCalls(runner), 0) // ...while the master keeps serving the running shell
  connections.noteShellEnd("one")

  await closing
  assert.equal(stopCalls(runner), 1)
  assert.equal(connections.get("one"), undefined) // removed only once teardown completes
  assert.equal(connections.getForShell("one"), undefined)
})

test("cleanup drains active shells only for a bounded time", async () => {
  const runner = new FakeRunner()
  const connections = new SshConnections({ home: "/home/test", runner, fs: memoryFs(new Set()), shellDrainMs: 20 })
  await connections.connect("one", "alpha")
  connections.noteShellStart("one")
  const started = Date.now()
  await connections.cleanup()
  assert.ok(Date.now() - started < 500)
  assert.equal(stopCalls(runner), 1)
})

test("shell accounting clamps at zero and ignores unknown sessions", async () => {
  const connections = new SshConnections({ home: "/home/test", runner: new FakeRunner(), fs: memoryFs(new Set()) })
  assert.doesNotThrow(() => connections.noteShellEnd("ghost"))
  connections.noteShellEnd("one")
  connections.noteShellStart("one")
  await connections.disconnect("one")
  assert.equal(connections.get("one"), undefined)
})

async function* streamOf(events: Array<Record<string, unknown>>) {
  yield* events
}

test("consumes session.deleted events and tolerates malformed entries", async () => {
  const seen: string[] = []
  const stream = consumeSessionDeletions(
    streamOf([
      { type: "session.updated", data: { sessionID: "zzz" } },
      { type: "session.deleted", data: { sessionID: "one" } },
      { type: "session.deleted" },
      { type: "session.deleted", data: {} },
      { type: "session.deleted", data: { sessionID: "two" } },
    ]),
    async (sessionID) => { seen.push(sessionID) },
  )
  await delay(10)
  assert.deepEqual(seen, ["one", "two"])
  await stream.stop()
})

test("stop halts consumption and is idempotent", async () => {
  const seen: string[] = []
  const source = async function* () {
    yield { type: "session.deleted", data: { sessionID: "one" } }
    await delay(30)
    yield { type: "session.deleted", data: { sessionID: "never" } }
  }
  const stream = consumeSessionDeletions(source(), async (id) => { seen.push(id) })
  await delay(5)
  await stream.stop()
  await stream.stop()
  await delay(40)
  assert.deepEqual(seen, ["one"])
})

test("unexpected stream failures are reported without crashing; aborts stay quiet", async () => {
  const warnings: unknown[] = []
  const original = console.warn
  console.warn = (...args: unknown[]) => { warnings.push(args) }
  try {
    const failing = async function* () {
      yield { type: "session.deleted", data: { sessionID: "one" } }
      throw new Error("sse exploded")
    }
    const stream = consumeSessionDeletions(failing(), async () => {})
    await delay(10)
    assert.ok(warnings.length >= 1)
    await stream.stop()

    const countAfterFailure = warnings.length
    const aborting = async function* () {
      throw Object.assign(new Error("aborted"), { name: "AbortError" })
    }
    const quiet = consumeSessionDeletions(aborting(), async () => {})
    await quiet.stop()
    assert.equal(warnings.length, countAfterFailure)
  } finally {
    console.warn = original
  }
})

test("registers ssh tools as first-class direct tools with output schemas", () => {
  const connections = new SshConnections({ home: "/home/test", runner: new FakeRunner(), fs: memoryFs(new Set()) })
  const [connect, disconnect] = sshToolRegistrations(connections)

  assert.equal((connect.input.properties as any)?.host?.type, "string")
  assert.deepEqual(disconnect.input.properties, {})
  assert.deepEqual(connect.options, { codemode: false })
  assert.deepEqual(disconnect.options, { codemode: false })
})

test("ssh_connect resolves a direct-tool result and throws real errors", async () => {
  const good = new SshConnections({ home: "/home/test", runner: new FakeRunner(), fs: memoryFs(new Set()) })
  const [connect] = sshToolRegistrations(good)

  const result = await connect.execute({ host: "alpha" }, { sessionID: "one" } as never) as { title?: string; output: string; metadata?: unknown }
  assert.equal(result.title, "ssh_connect")
  assert.match(result.output, /^Connected to alpha\./)
  assert.deepEqual(result.metadata, { host: "alpha" })

  const badRunner: ProcessRunner = {
    async run(_file, args) {
      if (args[0] === "-MNf") throw Object.assign(new Error("Command failed"), { stderr: "permission denied\n" })
      return { stdout: "", stderr: "", code: 0 }
    },
  }
  const bad = new SshConnections({ home: "/home/test", runner: badRunner, fs: memoryFs(new Set()) })
  const [badConnect] = sshToolRegistrations(bad)
  await assert.rejects(() => badConnect.execute({ host: "alpha" }, { sessionID: "one" } as never), /permission denied/)
})

test("ssh_disconnect returns a direct-tool result and clears the session", async () => {
  const connections = new SshConnections({ home: "/home/test", runner: new FakeRunner(), fs: memoryFs(new Set()) })
  const [, disconnect] = sshToolRegistrations(connections)
  await connections.connect("one", "alpha")

  const result = await disconnect.execute({}, { sessionID: "one" } as never) as { title?: string; output: string; metadata?: unknown }

  assert.equal(result.title, "ssh_disconnect")
  assert.equal(result.output, "Disconnected. Shell commands now run locally.")
  assert.deepEqual(result.metadata, {})
  assert.equal(connections.get("one"), undefined)
})

test("plugin exposes dual v2 and legacy entrypoints", () => {
  assert.equal(plugin.id, "opencode-ssh")
  assert.equal(typeof plugin.server, "function")
  assert.equal(typeof setupV2, "function")
})

test("legacy server exposes populated argument schemas and v2 keeps direct options", async () => {
  const hooks = await plugin.server()
  const expected = {
    ssh_connect: ["host"], ssh_disconnect: [],
    ssh_channel_open: ["host"], ssh_channel_read: ["id", "cursor"],
    ssh_channel_write: ["id", "data"], ssh_channel_status: ["id"],
    ssh_channel_resize: ["id", "cols", "rows"], ssh_channel_close: ["id"],
  }
  assert.deepEqual(Object.keys(hooks.tool ?? {}).sort(), Object.keys(expected).sort())
  for (const [name, keys] of Object.entries(expected)) {
    const definition = (hooks.tool as any)[name]
    assert.ok(definition.args, `${name} must expose legacy args`)
    assert.deepEqual(Object.keys(definition.args).sort(), [...keys].sort())
    for (const key of keys) assert.equal(typeof definition.args[key].parse, "function")
  }
  const v2 = [...sshToolRegistrations({} as never), ...sshChannelToolRegistrations({} as never)]
  for (const definition of v2) assert.deepEqual(definition.options, { codemode: false })
})

test("v2 context policy keeps structured system parts", () => {
  const context = {
    sessionID: "one",
    system: [{ type: "text", text: "existing" }],
    tools: Object.fromEntries([...LOCAL_WORKSPACE_TOOLS, "ssh_connect"].map((name) => [name, {}])),
    generation: {},
    providerOptions: {},
  }
  applyV2SessionContext(context, "alpha")
  applyV2SessionContext(context, "alpha")
  assert.equal(context.system.some((part) => typeof part === "string"), false)
  assert.equal(context.system.filter((part) => part.type === "text").length, 2)
  assert.equal(context.system.at(-1)?.type, "text")
  assert.ok(context.system.at(-1)?.text?.includes("alpha"))
  assert.equal("read" in context.tools, false)
  assert.equal("ssh_connect" in context.tools, true)
})

test("v2 compatibility export registers every SSH tool as a direct tool", async () => {
  const added: Array<{ name: string; options?: unknown }> = []
  let contextHook: ((context: any) => Promise<void>) | undefined
  const context = {
    tool: {
      transform: async (transform: (draft: { add(tool: { name: string; options?: unknown }): void }) => void) => {
        transform({ add(tool) { added.push(tool) } })
      },
      hook: async () => {},
    },
    session: { hook: async (_name: string, hook: (context: any) => Promise<void>) => { contextHook = hook } },
    event: { subscribe: async function* () {} },
  }
  await setupV2(context as never)
  assert.equal(contextHook?.length, 1)
  await contextHook?.({ sessionID: "missing", system: [], tools: {}, generation: {}, providerOptions: {} })
  assert.deepEqual(added.map((tool) => tool.name), [
    "ssh_connect", "ssh_disconnect", "ssh_channel_open", "ssh_channel_read", "ssh_channel_write",
    "ssh_channel_status", "ssh_channel_resize", "ssh_channel_close",
  ])
  for (const tool of added) assert.deepEqual(tool.options, { codemode: false })
})

test("default export has one legacy registration surface", () => {
  assert.equal(plugin.id, "opencode-ssh")
  assert.equal(typeof plugin.server, "function")
  assert.equal((plugin as any).setup, undefined)
  assert.equal(typeof setupV2, "function")
})

test("package namespace exposes the compatibility setup under its non-colliding name", () => {
  assert.equal(typeof (pluginNamespace as any).setupV2, "function")
  assert.equal((pluginNamespace as any).setup, undefined)
})
