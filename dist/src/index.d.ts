import { Plugin } from "@opencode-ai/plugin";
import { SshConnections } from "./ssh.js";
/**
 * Builds the ssh_connect/ssh_disconnect tool registrations. Both are declared
 * with `options: { codemode: false }` so OpenCode registers them as first-class
 * direct tools instead of Code-Mode-only tools, whose bridge drops plugin tool
 * results (the model would only ever see "Tool execution failed"). Direct tools
 * must return `{ title?, output, metadata? }` objects and surface failures by
 * throwing, which reaches the model as a real error message.
 */
export declare function sshToolRegistrations(connections: SshConnections): ({
    name: string;
    description: string;
    input: {
        readonly type: "object";
        readonly properties: {
            readonly host: {
                readonly type: "string";
                readonly description: "SSH host alias from ~/.ssh/config";
            };
        };
        readonly required: readonly ["host"];
        readonly additionalProperties: false;
    };
    output: {
        readonly type: "object";
        readonly properties: {};
        readonly additionalProperties: false;
    };
    options: {
        codemode: boolean;
    };
    execute(args: unknown, toolCtx: {
        sessionID: string;
    }): Promise<{
        title: string;
        output: string;
        metadata: {
            host: string;
        };
    }>;
} | {
    name: string;
    description: string;
    input: {
        type: string;
        properties: {};
        additionalProperties: boolean;
    };
    output: {
        readonly type: "object";
        readonly properties: {};
        readonly additionalProperties: false;
    };
    options: {
        codemode: boolean;
    };
    execute(_args: unknown, toolCtx: {
        sessionID: string;
    }): Promise<{
        title: string;
        output: string;
        metadata: {};
    }>;
})[];
declare const _default: Plugin.Plugin;
export default _default;
export { SshConnections, LOCAL_WORKSPACE_TOOLS, applyRemoteContext, consumeSessionDeletions, quotePosix, socketPath, transformShellExecuteBefore, validateHost, wrapRemoteCommand, } from "./ssh.js";
