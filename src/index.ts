import { execFile } from "node:child_process"
import { promises as fs } from "node:fs"
import { z } from "zod"
import {
  SshConnections,
  applyRemoteContext,
  consumeSessionDeletions,
  remoteSystemMessage,
  transformShellExecuteBefore,
  type ProcessRunner,
} from "./ssh.js"
import { SshChannelManager, createLocalPtyTransport, type ChannelRecord } from "./channel.js"

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

type JsonTool = {
  name: string
  description: string
  input: Record<string, unknown>
  output: Record<string, unknown>
  options: { codemode: false }
  execute(args: any, context: { sessionID: string }): Promise<{ title?: string; output: string; metadata?: Record<string, unknown> }>
}

type V2SessionContext = {
  sessionID: string
  system: Array<{ type: unknown; text?: unknown }>
  tools: Record<string, unknown>
  generation: Record<string, unknown>
  providerOptions: Record<string, unknown>
}

type V2Context = {
  tool: {
    transform(fn: (draft: { add(tool: JsonTool): void }) => void): Promise<unknown>
    hook(name: string, fn: (event: any) => Promise<void>): Promise<unknown>
  }
  session: {
    hook(name: "context", fn: (context: V2SessionContext) => Promise<void>): Promise<unknown>
  }
  event: { subscribe(): AsyncIterable<unknown> }
}

const emptyOutput = { type: "object", properties: {}, additionalProperties: false }
const directOptions = { codemode: false as const }
const schema = (properties: Record<string, unknown>, required?: string[]) => ({
  type: "object", properties, additionalProperties: false, ...(required ? { required } : {}),
})

export function applyV2SessionContext(context: V2SessionContext, host: string): void {
  applyRemoteContext(context, host)
}

function channelResult(c: ChannelRecord) { return { title: "ssh_channel_open", output: `Opened channel ${c.id} to ${c.host}.`, metadata: { id: c.id, host: c.host, state: c.state } } }

export function sshChannelToolRegistrations(manager: SshChannelManager): JsonTool[] {
  return [
    { name: "ssh_channel_open", description: "Open a persistent interactive SSH terminal channel.", input: schema({ host: { type: "string" } }, ["host"]), output: emptyOutput, options: directOptions, async execute({ host }, ctx) { return channelResult(await manager.open(ctx.sessionID, host)) } },
    { name: "ssh_channel_read", description: "Read output from a channel; metadata includes the next cursor, dropped bytes, and state.", input: schema({ id: { type: "string" }, cursor: { type: "integer", minimum: 0 } }), output: emptyOutput, options: directOptions, async execute({ id, cursor }, ctx) { const r = manager.read(ctx.sessionID, id, cursor); return { output: new TextDecoder().decode(r.data), metadata: { cursor: r.cursor, dropped: r.dropped, state: r.state } } } },
    { name: "ssh_channel_write", description: "Write literal terminal input to a channel (maximum 64 KiB UTF-8 bytes).", input: schema({ id: { type: "string" }, data: { type: "string", maxLength: 65536 } }, ["id", "data"]), output: emptyOutput, options: directOptions, async execute({ id, data }, ctx) { manager.write(ctx.sessionID, id, data); return { output: "written", metadata: {} } } },
    { name: "ssh_channel_status", description: "Get persistent SSH channel status.", input: schema({ id: { type: "string" } }, ["id"]), output: emptyOutput, options: directOptions, async execute({ id }, ctx) { return { output: "", metadata: manager.status(ctx.sessionID, id) } } },
    { name: "ssh_channel_resize", description: "Resize a persistent SSH terminal channel.", input: schema({ id: { type: "string" }, cols: { type: "integer", minimum: 1, maximum: 500 }, rows: { type: "integer", minimum: 1, maximum: 500 } }, ["id", "cols", "rows"]), output: emptyOutput, options: directOptions, async execute({ id, cols, rows }, ctx) { await manager.resize(ctx.sessionID, id, cols, rows); return { output: "resized", metadata: {} } } },
    { name: "ssh_channel_close", description: "Close a persistent SSH terminal channel.", input: schema({ id: { type: "string" } }, ["id"]), output: emptyOutput, options: directOptions, async execute({ id }, ctx) { await manager.close(ctx.sessionID, id); return { output: "closed", metadata: {} } } },
  ]
}

export function sshToolRegistrations(connections: SshConnections): JsonTool[] {
  return [
    { name: "ssh_connect", description: "Connect to an SSH host alias from ~/.ssh/config. First-class direct tool.", input: schema({ host: { type: "string" } }, ["host"]), output: emptyOutput, options: directOptions, async execute({ host }, ctx) { try { const state = await connections.connect(ctx.sessionID, host); return { title: "ssh_connect", output: `Connected to ${state.host}. Shell commands now run remotely. Use ssh_disconnect to return local.`, metadata: { host: state.host } } } catch (error) { throw new Error(error instanceof Error ? error.message : String(error)) } } },
    { name: "ssh_disconnect", description: "Disconnect the current SSH session and return to local mode. First-class direct tool.", input: schema({}, []), output: emptyOutput, options: directOptions, async execute(_args, ctx) { await connections.disconnect(ctx.sessionID); return { title: "ssh_disconnect", output: "Disconnected. Shell commands now run locally.", metadata: {} } } },
  ]
}

const legacyArgs = {
  ssh_connect: { host: z.string() },
  ssh_disconnect: {},
  ssh_channel_open: { host: z.string() },
  ssh_channel_read: { id: z.string(), cursor: z.number().int().min(0).optional() },
  ssh_channel_write: { id: z.string(), data: z.string().max(65536) },
  ssh_channel_status: { id: z.string() },
  ssh_channel_resize: { id: z.string(), cols: z.number().int().min(1).max(500), rows: z.number().int().min(1).max(500) },
  ssh_channel_close: { id: z.string() },
}

const isInputObject = (value: unknown): value is object => typeof value === "object" && value !== null

const server = async () => {
    const connections = new SshConnections({ runner, fs: {
      mkdir: async (path, options) => { await fs.mkdir(path, options) },
      rm: async (path, options) => { await fs.rm(path, options) },
      exists: async (path) => { try { await fs.stat(path); return true } catch { return false } },
      chmod: async (path, mode) => { await fs.chmod(path, mode) },
      lstat: async (path) => { return await fs.lstat(path) },
    } })
    const channels = new SshChannelManager({ transport: createLocalPtyTransport() })

    // Call IDs remain stable across before/after hook payloads.
    const countedShells = new Set<string>()

    const definitions = [...sshToolRegistrations(connections), ...sshChannelToolRegistrations(channels)]
    const tools = Object.fromEntries(definitions.map((definition) => [definition.name, {
      description: definition.description,
      args: legacyArgs[definition.name as keyof typeof legacyArgs],
      execute: definition.execute,
    }]))
    return {
      tool: tools,
      "tool.execute.before": async (event: any, output: any) => {
      // getForShell rejects shell attempts racing an in-progress disconnect so
      // they cannot fall through to local execution; context keeps using get().
        const shellEvent = { tool: event.tool, sessionID: event.sessionID, input: output.args }
        if (!transformShellExecuteBefore(shellEvent, (sessionID) => connections.getForShell(sessionID))) return
        if (!countedShells.has(event.callID)) {
          countedShells.add(event.callID)
          connections.noteShellStart(event.sessionID)
        }
      }
      ,
      "tool.execute.after": async (event: any) => {
        if (!countedShells.delete(event.callID)) return
        connections.noteShellEnd(event.sessionID)
      },
      event: async ({ event }: any) => {
        if (event.type !== "session.deleted") return
        await Promise.all([connections.disconnect(event.properties.info.id), channels.closeSession(event.properties.info.id)])
      },
      "experimental.chat.system.transform": async ({ sessionID }: any, output: any) => {
        if (!sessionID) return
        const state = connections.get(sessionID)
        if (state) {
          const text = remoteSystemMessage(state.host)
          if (!output.system.includes(text)) output.system.push(text)
        }
      },
      dispose: async () => {
      await channels.cleanup()
      await connections.cleanup()
      },
    }
}

export async function setupV2(ctx: V2Context) {
  const connections = new SshConnections({ runner, fs: {
    mkdir: async (path, options) => { await fs.mkdir(path, options) },
    rm: async (path, options) => { await fs.rm(path, options) },
    exists: async (path) => { try { await fs.stat(path); return true } catch { return false } },
    chmod: async (path, mode) => { await fs.chmod(path, mode) },
    lstat: async (path) => await fs.lstat(path),
  } })
  const channels = new SshChannelManager({ transport: createLocalPtyTransport() })
  const countedShells = new Set<string>()

  await ctx.tool.transform((draft) => {
    for (const definition of [...sshToolRegistrations(connections), ...sshChannelToolRegistrations(channels)]) draft.add(definition)
  })
  await ctx.tool.hook("execute.before", async (event) => {
    const shellEvent = { tool: event.tool, sessionID: event.sessionID, input: event.input }
    if (!transformShellExecuteBefore(shellEvent, (sessionID) => connections.getForShell(sessionID))) return
    if (!countedShells.has(event.id)) {
      countedShells.add(event.id)
      connections.noteShellStart(event.sessionID)
    }
  })
  await ctx.tool.hook("execute.after", async (event) => {
    if (!countedShells.delete(event.id)) return
    connections.noteShellEnd(event.sessionID)
  })
  await ctx.session.hook("context", async (context) => {
    const state = connections.get(context.sessionID)
    if (!state) return
    applyV2SessionContext(context, state.host)
  })
  const deletions = consumeSessionDeletions(ctx.event.subscribe() as AsyncIterable<any>, async (sessionID) => {
    await Promise.all([connections.disconnect(sessionID), channels.closeSession(sessionID)])
  })
  return async () => {
    await deletions.stop()
    await channels.cleanup()
    await connections.cleanup()
  }
}

export default { id: "opencode-ssh", server }

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
