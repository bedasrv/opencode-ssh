import { promises as fs } from "node:fs"
import { z } from "zod"
import type { PluginInput } from "@opencode-ai/plugin"
import { createCommandRunner, createSessionWorkspaceAssociations, createWorkspaceAdapter, type WorkspaceBinding } from "./workspace.js"
import {
  SshConnections,
  applyRemoteContext,
  consumeSessionDeletions,
  remoteSystemMessage,
  workspaceSystemMessage,
  transformShellExecuteBefore,
} from "./ssh.js"
import { SshChannelManager, createLocalPtyTransport, type ChannelRecord } from "./channel.js"

const runner = createCommandRunner()

let legacyConnections: SshConnections | undefined
let legacyConnectionUsers = 0

function acquireLegacyConnections(): SshConnections {
  if (!legacyConnections) legacyConnections = new SshConnections({ runner, fs: {
    mkdir: async (path, options) => { await fs.mkdir(path, options) },
    rm: async (path, options) => { await fs.rm(path, options) },
    exists: async (path) => { try { await fs.stat(path); return true } catch { return false } },
    chmod: async (path, mode) => { await fs.chmod(path, mode) },
    lstat: async (path) => await fs.lstat(path),
  } })
  legacyConnectionUsers++
  return legacyConnections
}

async function releaseLegacyConnections(connections: SshConnections): Promise<void> {
  legacyConnectionUsers--
  if (legacyConnectionUsers > 0 || legacyConnections !== connections) return
  legacyConnections = undefined
  await connections.cleanup()
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

function sessionEventID(event: any): string | undefined {
  const info = event?.properties?.info ?? event?.data?.info ?? event?.data
  return typeof info?.id === "string" ? info.id : typeof info?.sessionID === "string" ? info.sessionID : undefined
}

function sessionWorkspaceID(event: any): string | undefined {
  const info = event?.properties?.info ?? event?.data?.info ?? event?.data
  return typeof info?.workspaceID === "string" ? info.workspaceID : undefined
}

async function hydrateWorkspaceSession(input: PluginInput | undefined, sessionID: string, workspace: { lookupWorkspace(id: string): unknown }, associations: ReturnType<typeof createSessionWorkspaceAssociations>): Promise<void> {
  if (!input || associations.lookup(sessionID)) return
  const response = await input.client.session.get({ path: { id: sessionID } })
  const workspaceID = (response as any)?.data?.location?.workspaceID ?? (response as any)?.data?.workspaceID
  if (typeof workspaceID === "string") associations.attach(sessionID, workspaceID)
}

async function waitForWorkspaceBinding(associations: ReturnType<typeof createSessionWorkspaceAssociations>, sessionID: string): Promise<WorkspaceBinding | undefined> {
  const deadline = Date.now() + 5000
  while (Date.now() < deadline) {
    const binding = associations.lookup(sessionID)
    if (binding) return binding
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  return associations.lookup(sessionID)
}

function isWorkspaceRootOrDescendant(root: string, directory: string): boolean {
  return directory === root || directory.startsWith(`${root}/`)
}

export async function prepareWorkspaceShell(sessionID: string, tool: string, input: any, workspace: { lookup(directory: string): { host: string; remotePath: string } | undefined }, connections: SshConnections, associations?: ReturnType<typeof createSessionWorkspaceAssociations>): Promise<void> {
  if (tool !== "shell" && tool !== "bash") return
  if (!isInputObject(input)) return
  const current = connections.get(sessionID)
  if (current?.mode === "shell") return
  const payload = input as Record<string, unknown>
  const workdir = typeof payload.workdir === "string" ? payload.workdir : typeof payload.cwd === "string" ? payload.cwd : undefined
  let associated: (WorkspaceBinding & { localDirectory?: string }) | undefined = associations?.lookup(sessionID)
  if (associations?.has(sessionID) && !associated) associated = await waitForWorkspaceBinding(associations, sessionID)
  if (associations?.has(sessionID) && !associated) throw new Error("SSHFS workspace session is not attached to a ready workspace")
  if (!associated && !current && (associations || !workdir)) return
  const workdirBinding = workdir ? workspace.lookup(workdir) : undefined
  const associatedRoot = associated?.localDirectory ?? current?.localDirectory
  if ((current?.mode === "workspace" || associated) && workdir && (!workdirBinding || !associatedRoot || !isWorkspaceRootOrDescendant(associatedRoot, workdir))) throw new Error("SSHFS workspace workdir is outside the associated managed mount")
  const binding = workdirBinding ?? associated ?? (associations
    ? (current?.mode === "workspace" ? { host: current.host, remotePath: current.remotePath! } : undefined)
    : (current?.mode === "workspace" ? { host: current.host, remotePath: current.remotePath! } : undefined))
  if (!binding) return
  const state = await connections.connectWorkspace(sessionID, binding.host, binding.remotePath, (associated as { localDirectory?: string } | undefined)?.localDirectory ?? current?.localDirectory ?? workdir ?? "")
  if (!state.localDirectory) throw new Error("SSHFS workspace binding has no local directory")
}

const server = async (input?: PluginInput) => {
    const workspace = createWorkspaceAdapter({ home: undefined, runner, fs: {
      mkdir: async (path, options) => { await fs.mkdir(path, options) },
      rm: async (path, options) => { await fs.rm(path, options) },
      exists: async (path) => { try { await fs.stat(path); return true } catch { return false } },
      chmod: async (path, mode) => { await fs.chmod(path, mode) },
      lstat: async (path) => await fs.lstat(path),
    } })
    if (input) input.experimental_workspace.register("sshfs", workspace)
    const associations = createSessionWorkspaceAssociations(workspace)
    const connections = acquireLegacyConnections()
    const channels = new SshChannelManager({ transport: createLocalPtyTransport() })

    // Call IDs remain stable across before/after hook payloads.
    const countedShells = new Set<string>()
    let disposed = false

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
        if ((event.tool === "shell" || event.tool === "bash") && connections.get(event.sessionID)?.mode !== "shell") {
          await hydrateWorkspaceSession(input, event.sessionID, workspace, associations)
        }
        await prepareWorkspaceShell(event.sessionID, event.tool, output.args, workspace, connections, associations)
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
        const sessionID = sessionEventID(event)
        if (event.type === "session.created" || event.type === "session.updated") {
          if (sessionID) {
            const workspaceID = sessionWorkspaceID(event)
            if (workspaceID) associations.attach(sessionID, workspaceID)
            else associations.remove(sessionID)
          }
          return
        }
        if (event.type !== "session.deleted" || !sessionID) return
        associations.remove(sessionID)
        await Promise.all([connections.disconnect(sessionID), channels.closeSession(sessionID)])
      },
      "experimental.chat.system.transform": async ({ sessionID }: any, output: any) => {
        if (!sessionID) return
        const state = connections.get(sessionID)
        if (state) {
          const text = state.mode === "workspace" ? workspaceSystemMessage(state.host, state.remotePath ?? "") : remoteSystemMessage(state.host)
          if (!output.system.includes(text)) output.system.push(text)
        }
      },
      dispose: async () => {
        if (disposed) return
        disposed = true
        const results = await Promise.allSettled([workspace.cleanup(), channels.cleanup(), releaseLegacyConnections(connections)])
        const errors = results.flatMap((result) => result.status === "rejected" ? [result.reason] : [])
        if (errors.length) throw new AggregateError(errors, errors.map((error) => error instanceof Error ? error.message : String(error)).join("; "))
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

export { createWorkspaceAdapter } from "./workspace.js"
