import test from "node:test"
import assert from "node:assert/strict"
import { quotePosix, transformShellExecuteBefore, wrapRemoteCommand, SshConnections, type ProcessRunner } from "../src/ssh.js"

test("quotes POSIX shell values and wraps commands deterministically", () => {
  assert.equal(quotePosix("a'b$`c;\n"), "'a'\\''b$`c;\n'")
  assert.equal(quotePosix(""), "''")
  assert.equal(wrapRemoteCommand("/tmp/cm.sock", "my-host", "echo 'hi'"), "ssh -S '/tmp/cm.sock' 'my-host' 'echo '\\''hi'\\'''")
})

test("does not double-wrap an already wrapped command", () => {
  const wrapped = wrapRemoteCommand("/tmp/cm.sock", "my-host", "printf '$x'")
  assert.equal(wrapRemoteCommand("/tmp/cm.sock", "my-host", wrapped), wrapped)
})

test("transforms only shell executions using the matching session", () => {
  const states = new Map([
    ["one", { socketPath: "/tmp/one.sock", host: "one-host" }],
    ["two", { socketPath: "/tmp/two.sock", host: "two-host" }],
  ])
  const getState = (sessionID: string) => states.get(sessionID)
  const remote = { tool: "shell", sessionID: "two", input: { command: "pwd" } }
  const local = { tool: "shell", sessionID: "missing", input: { command: "pwd" } }
  const other = { tool: "read", sessionID: "two", input: { command: "pwd" } }

  transformShellExecuteBefore(remote, getState)
  transformShellExecuteBefore(local, getState)
  transformShellExecuteBefore(other, getState)

  assert.equal(remote.input.command, "ssh -S '/tmp/two.sock' 'two-host' 'pwd'")
  assert.equal(local.input.command, "pwd")
  assert.equal(other.input.command, "pwd")
  transformShellExecuteBefore(remote, getState)
  assert.equal(remote.input.command, "ssh -S '/tmp/two.sock' 'two-host' 'pwd'")
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

function memoryFs(files: Set<string>) {
  return {
    async mkdir() {},
    async rm(file: string) { files.delete(file) },
    async exists(file: string) { return files.has(file) },
  }
}

class DelayedRunner implements ProcessRunner {
  calls: Array<{ file: string; args: string[] }> = []
  delays = new Map<string, number>()
  async run(file: string, args: string[]) {
    this.calls.push({ file, args })
    const delay = this.delays.get(args[0] ?? "")
    if (delay) await new Promise((resolve) => setTimeout(resolve, delay))
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
    fs: {
      async mkdir() {},
      async rm(file) { files.delete(file) },
      async exists(file) { return files.has(file) },
    },
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
  const connections = new SshConnections({ home: "/home/test", runner, fs: {
    async mkdir() {}, async rm(file) { files.delete(file) }, async exists(file) { return files.has(file) },
  } })
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
  const connections = new SshConnections({ home: "/home/test", runner: new FakeRunner(), fs: { async mkdir() {}, async rm() {}, async exists() { return false } } })
  await assert.rejects(() => connections.connect("one", "bad;host"), /Invalid SSH host/)
})
