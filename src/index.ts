import { execFile } from "node:child_process"
import { promises as fs } from "node:fs"
import { Plugin } from "@opencode-ai/plugin"
import {
  SshConnections,
  applyRemoteContext,
  consumeSessionDeletions,
  transformShellExecuteBefore,
  type ProcessRunner,
} from "./ssh.js"

const runner: ProcessRunner = {
  run(file, args, options) {
    return new Promise((resolve, reject) => {
      execFile(file, args, { ...options, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
        if (error) {
          Object.assign(error, { stderr })
          reject(error)
        }
        else resolve({ stdout, stderr, code: 0 })
      })
    })
  },
}

const input = {
  type: "object",
  properties: { host: { type: "string", description: "SSH host alias from ~/.ssh/config" } },
  required: ["host"],
  additionalProperties: false,
} as const

const isInputObject = (value: unknown): value is object => typeof value === "object" && value !== null

export default Plugin.define({
  id: "opencode-ssh",
  async setup(ctx) {
    const connections = new SshConnections({ runner, fs: {
      mkdir: async (path, options) => { await fs.mkdir(path, options) },
      rm: async (path, options) => { await fs.rm(path, options) },
      exists: async (path) => { try { await fs.stat(path); return true } catch { return false } },
      chmod: async (path, mode) => { await fs.chmod(path, mode) },
      lstat: async (path) => { return await fs.lstat(path) },
    } })

    // One WeakSet entry per shell tool call, so repeated execute.before runs on the
    // same input do not inflate the active-shell counter that disconnect waits on.
    const countedShells = new WeakSet<object>()

    await ctx.tool.transform((draft) => {
      draft.add({
        name: "ssh_connect",
        description: "Connect to an SSH host alias from ~/.ssh/config.",
        input,
        async execute(args, toolCtx) {
          try {
            const state = await connections.connect(toolCtx.sessionID, (args as { host: string }).host)
            return { output: `Connected to ${state.host}. Shell commands now run remotely. Use ssh_disconnect to return local.` }
          } catch (error) {
            return { output: error instanceof Error ? error.message : String(error) }
          }
        },
      })
      draft.add({
        name: "ssh_disconnect",
        description: "Disconnect the current SSH session and return to local mode.",
        input: { type: "object", properties: {}, additionalProperties: false },
        async execute(_args, toolCtx) {
          await connections.disconnect(toolCtx.sessionID)
          return { output: "Disconnected. Shell commands now run locally." }
        },
      })
    })

    await ctx.tool.hook("execute.before", (event) => {
      // getForShell rejects shell attempts racing an in-progress disconnect so
      // they cannot fall through to local execution; context keeps using get().
      if (!transformShellExecuteBefore(event, (sessionID) => connections.getForShell(sessionID))) return
      if (isInputObject(event.input) && !countedShells.has(event.input)) {
        countedShells.add(event.input)
        connections.noteShellStart(event.sessionID)
      }
    })

    await ctx.tool.hook("execute.after", (event) => {
      if (!isInputObject(event.input) || !countedShells.has(event.input)) return
      countedShells.delete(event.input)
      connections.noteShellEnd(event.sessionID)
    })

    await ctx.session.hook("context", (context) => {
      const state = connections.get(context.sessionID)
      if (!state) return
      applyRemoteContext(context, state.host)
    })

    const deletions = consumeSessionDeletions(ctx.event.subscribe(), (sessionID) =>
      connections.disconnect(sessionID),
    )

    return async () => {
      await deletions.stop()
      await connections.cleanup()
    }
  },
})

export {
  SshConnections,
  LOCAL_WORKSPACE_TOOLS,
  applyRemoteContext,
  consumeSessionDeletions,
  quotePosix,
  socketPath,
  transformShellExecuteBefore,
  validateHost,
  wrapRemoteCommand,
} from "./ssh.js"
