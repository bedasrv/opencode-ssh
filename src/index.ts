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

const output = {
  type: "object",
  properties: {},
  additionalProperties: false,
} as const

/**
 * Builds the ssh_connect/ssh_disconnect tool registrations. Both are declared
 * with `options: { codemode: false }` so OpenCode registers them as first-class
 * direct tools instead of Code-Mode-only tools, whose bridge drops plugin tool
 * results (the model would only ever see "Tool execution failed"). Direct tools
 * must return `{ title?, output, metadata? }` objects and surface failures by
 * throwing, which reaches the model as a real error message.
 */
export function sshToolRegistrations(connections: SshConnections) {
  return [
    {
      name: "ssh_connect",
      description:
        "Connect to an SSH host alias from ~/.ssh/config. First-class tool: call it directly, not through execute.",
      input,
      output,
      options: { codemode: false },
      async execute(args: unknown, toolCtx: { sessionID: string }) {
        const host = (args as { host: string }).host
        try {
          const state = await connections.connect(toolCtx.sessionID, host)
          return {
            title: "ssh_connect",
            output: `Connected to ${state.host}. Shell commands now run remotely. Use ssh_disconnect to return local.`,
            metadata: { host: state.host },
          }
        } catch (error) {
          throw new Error(error instanceof Error ? error.message : String(error))
        }
      },
    },
    {
      name: "ssh_disconnect",
      description:
        "Disconnect the current SSH session and return to local mode. First-class tool: call it directly, not through execute.",
      input: { type: "object", properties: {}, additionalProperties: false },
      output,
      options: { codemode: false },
      async execute(_args: unknown, toolCtx: { sessionID: string }) {
        await connections.disconnect(toolCtx.sessionID)
        return {
          title: "ssh_disconnect",
          output: "Disconnected. Shell commands now run locally.",
          metadata: {},
        }
      },
    },
  ]
}

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
      for (const tool of sshToolRegistrations(connections)) draft.add(tool)
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
