import test from "node:test"
import assert from "node:assert/strict"
import plugin from "../src/index.js"
import { createCommandRunner, createWorkspaceAdapter, type WorkspaceChild, type WorkspaceFileOps, type WorkspaceRunner } from "../src/workspace.js"
import { SshConnections } from "../src/ssh.js"
import { SshChannelManager } from "../src/channel.js"

test("remove retains a still-running child when both waits fail and retries it later", async () => {
  const files = new Set<string>()
  let killCalls = 0
  let waitCalls = 0
  const child: WorkspaceChild = { running: () => true, async kill() { killCalls++ }, async wait() { waitCalls++; throw new Error("child wait timeout") } }
  const runner: WorkspaceRunner = { async run(file, args) { if (file === "findmnt") return { stdout: `${args[1]} fuse.sshfs\n`, stderr: "", code: 0 }; if (file === "fusermount3") throw Object.assign(new Error("unmount denied"), { stderr: "unmount denied" }); if (file === "sftp") return { stdout: "Remote working directory: /srv\n", stderr: "", code: 0 }; return { stdout: "", stderr: "", code: 0 } }, async start() { return child } }
  const fs: WorkspaceFileOps = { async mkdir(path) { files.add(path) }, async rm() {}, async exists(path) { return files.has(path) }, async chmod() {}, async lstat() { return { isSymbolicLink: () => false } } }
  const adapter = createWorkspaceAdapter({ home: "/home/failed-child", runner, fs })
  const config = await adapter.configure({ id: "failed-child", type: "sshfs", name: "SSHFS", branch: null, directory: null, extra: { host: "prod", path: "/srv" }, projectID: "p" })
  await adapter.create(config, {})
  await assert.rejects(() => adapter.remove(config), /unmount|child wait/i)
  assert.equal(killCalls, 2); assert.equal(waitCalls, 2)
  await assert.rejects(() => adapter.remove(config), /unmount|child wait/i)
  assert.equal(killCalls, 4); assert.equal(waitCalls, 4)
})

test("plugin dispose continues cleanup after workspace cleanup fails and aggregates errors", async () => {
  let workspace: { cleanup(): Promise<void> } | undefined
  let channelCleanupCalls = 0; let connectionCleanupCalls = 0
  const originalChannelCleanup = SshChannelManager.prototype.cleanup; const originalConnectionCleanup = SshConnections.prototype.cleanup
  SshChannelManager.prototype.cleanup = async function () { channelCleanupCalls++ }; SshConnections.prototype.cleanup = async function () { connectionCleanupCalls++ }
  try {
    const hooks = await plugin.server({ experimental_workspace: { register(_type: string, adapter: { cleanup(): Promise<void> }) { workspace = adapter; adapter.cleanup = async () => { throw new Error("workspace cleanup failed") } } } } as any)
    await assert.rejects(() => hooks.dispose?.(), /workspace cleanup failed/)
    assert.equal(channelCleanupCalls, 1); assert.equal(connectionCleanupCalls, 1)
  } finally { SshChannelManager.prototype.cleanup = originalChannelCleanup; SshConnections.prototype.cleanup = originalConnectionCleanup }
  assert.ok(workspace)
})

test("command runner start reports a SIGTERM-resistant child as running until exit", async () => {
  const runner = createCommandRunner()
  const child = await runner.start!(process.execPath, ["-e", "process.on('SIGTERM', () => {}); setTimeout(() => {}, 3000)"])
  try {
    await child.kill()
    assert.equal(child.running(), true)
  } finally {
    await child.kill(true)
    await child.wait(1000)
  }
})

test("workspace configuration fails closed on mountpoint lstat errors", async () => {
  const error = Object.assign(new Error("permission denied"), { code: "EACCES" })
  const adapter = createWorkspaceAdapter({
    home: "/home/test",
    fs: {
      async mkdir() {}, async rm() {}, async exists() { return false }, async chmod() {},
      async lstat(path: string) {
        if (path === "/home/test/.cache/opencode-ssh/workspaces/blocked") throw error
        throw Object.assign(new Error("ENOENT"), { code: "ENOENT" })
      },
    },
    runner: { async run() { return { stdout: "", stderr: "", code: 0 } } },
  })

  await assert.rejects(
    () => adapter.configure({ id: "blocked", type: "sshfs", name: "SSHFS", branch: null, directory: null, extra: { host: "prod", path: "/srv" }, projectID: "p" }),
    (actual) => actual === error,
  )
})

test("existing workspace mountpoints are never removed when create fails", async () => {
  const directory = "/home/test/.cache/opencode-ssh/workspaces/pre-existing"
  const files = new Set<string>()
  const removed: string[] = []
  const fs = {
    async mkdir(path: string) {
      if (files.has(path)) throw Object.assign(new Error("EEXIST"), { code: "EEXIST" })
      files.add(path)
    },
    async rm(path: string) { removed.push(path); files.delete(path) },
    async exists(path: string) { return files.has(path) },
    async chmod() {},
    async lstat(path: string) { if (!files.has(path)) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" }); return { isSymbolicLink: () => false } },
  }
  const adapter = createWorkspaceAdapter({
    home: "/home/test",
    fs,
    runner: { async run() { return { stdout: "", stderr: "", code: 0 } } },
  })
  const config = await adapter.configure({ id: "pre-existing", type: "sshfs", name: "SSHFS", branch: null, directory: null, extra: { host: "prod", path: "/srv" }, projectID: "p" })
  files.add(directory)

  await assert.rejects(() => adapter.create(config, {}), /EEXIST|already exists|mountpoint/i)
  assert.deepEqual(removed, [])
  assert.equal(files.has(directory), true)
})

test("command runner can ignore stdio for detached backgrounding commands", async () => {
  const runner = createCommandRunner()
  const childCode = "setTimeout(() => {}, 3000)"
  const backgroundingCommand = `const { spawn } = require('node:child_process'); const child = spawn(process.execPath, ['-e', ${JSON.stringify(childCode)}], { detached: true, stdio: ['ignore', 'inherit', 'inherit'] }); child.unref()`

  const result = await (runner.run as any)(process.execPath, ["-e", backgroundingCommand], { timeout: 100, stdio: "ignore" })
  assert.equal(result.code, 0)
})

test("legacy server hooks share connection state across server lifecycle callbacks", async () => {
  const originalConnect = SshConnections.prototype.connect; const originalGet = SshConnections.prototype.get; const originalGetForShell = SshConnections.prototype.getForShell
  try {
    SshConnections.prototype.connect = async function (sessionID, host) { const state = { host, socketPath: "/tmp/shared.sock" }; (this as any).state = { sessionID, ...state }; return state }
    SshConnections.prototype.get = function (sessionID) { const state = (this as any).state; return state?.sessionID === sessionID ? state : undefined }
    SshConnections.prototype.getForShell = function (sessionID) { return this.get(sessionID) }
    const first = await plugin.server(); const second = await plugin.server()
    await (first.tool as any).ssh_connect.execute({ host: "alpha" }, { sessionID: "session-1" })
    const args = { command: "pwd" }
    await second["tool.execute.before"]?.({ tool: "shell", sessionID: "session-1", callID: "call-1" }, { args })
    assert.match(args.command, /ssh .*shared\.sock/)
    await first.dispose?.(); await second.dispose?.()
  } finally { SshConnections.prototype.connect = originalConnect; SshConnections.prototype.get = originalGet; SshConnections.prototype.getForShell = originalGetForShell }
})
