import test from "node:test"
import assert from "node:assert/strict"
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

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

type StateMap = Map<string, { host: string; socketPath: string }>
const stateGetter = (states: StateMap) => (sessionID: string) => states.get(sessionID)

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

test("starts masters with BatchMode=yes so prompts fail fast", async () => {
  const runner = new FakeRunner()
  const connections = new SshConnections({ home: "/home/test", runner, fs: memoryFs(new Set()) })
  await connections.connect("one", "alpha")
  const start = runner.calls.find((call) => call.args[0] === "-MNf")
  assert.ok(start)
  assert.deepEqual(start.args.slice(0, 4), ["-MNf", "-o", "BatchMode=yes", "-S"])
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
