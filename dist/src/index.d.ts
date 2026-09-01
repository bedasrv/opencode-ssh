import { z } from "zod";
import { SshConnections } from "./ssh.js";
import { SshChannelManager } from "./channel.js";
type JsonTool = {
    name: string;
    description: string;
    input: Record<string, unknown>;
    output: Record<string, unknown>;
    options: {
        codemode: false;
    };
    execute(args: any, context: {
        sessionID: string;
    }): Promise<{
        title?: string;
        output: string;
        metadata?: Record<string, unknown>;
    }>;
};
type V2SessionContext = {
    sessionID: string;
    system: Array<{
        type: unknown;
        text?: unknown;
    }>;
    tools: Record<string, unknown>;
    generation: Record<string, unknown>;
    providerOptions: Record<string, unknown>;
};
type V2Context = {
    tool: {
        transform(fn: (draft: {
            add(tool: JsonTool): void;
        }) => void): Promise<unknown>;
        hook(name: string, fn: (event: any) => Promise<void>): Promise<unknown>;
    };
    session: {
        hook(name: "context", fn: (context: V2SessionContext) => Promise<void>): Promise<unknown>;
    };
    event: {
        subscribe(): AsyncIterable<unknown>;
    };
};
export declare function applyV2SessionContext(context: V2SessionContext, host: string): void;
export declare function sshChannelToolRegistrations(manager: SshChannelManager): JsonTool[];
export declare function sshToolRegistrations(connections: SshConnections): JsonTool[];
export declare function setupV2(ctx: V2Context): Promise<() => Promise<void>>;
declare const _default: {
    id: string;
    server: () => Promise<{
        tool: {
            [k: string]: {
                description: string;
                args: {
                    host: z.ZodString;
                } | {} | {
                    host: z.ZodString;
                } | {
                    id: z.ZodString;
                    cursor: z.ZodOptional<z.ZodNumber>;
                } | {
                    id: z.ZodString;
                    data: z.ZodString;
                } | {
                    id: z.ZodString;
                } | {
                    id: z.ZodString;
                    cols: z.ZodNumber;
                    rows: z.ZodNumber;
                } | {
                    id: z.ZodString;
                };
                execute: (args: any, context: {
                    sessionID: string;
                }) => Promise<{
                    title?: string;
                    output: string;
                    metadata?: Record<string, unknown>;
                }>;
            };
        };
        "tool.execute.before": (event: any, output: any) => Promise<void>;
        "tool.execute.after": (event: any) => Promise<void>;
        event: ({ event }: any) => Promise<void>;
        "experimental.chat.system.transform": ({ sessionID }: any, output: any) => Promise<void>;
        dispose: () => Promise<void>;
    }>;
};
export default _default;
export { SshConnections, LOCAL_WORKSPACE_TOOLS, applyRemoteContext, consumeSessionDeletions, quotePosix, socketPath, transformShellExecuteBefore, validateHost, wrapRemoteCommand, } from "./ssh.js";
