export type ProcessRunner = {
    run(file: string, args: string[], options?: {
        timeout?: number;
    }): Promise<{
        stdout: string;
        stderr: string;
        code: number;
    }>;
};
export type FileInfo = {
    isSymbolicLink(): boolean;
};
export type FileOps = {
    mkdir(path: string, options: {
        recursive: boolean;
        mode: number;
    }): Promise<void>;
    rm(path: string, options?: {
        force?: boolean;
    }): Promise<void>;
    exists(path: string): Promise<boolean>;
    chmod(path: string, mode: number): Promise<void>;
    lstat(path: string): Promise<FileInfo>;
};
export type ConnectionState = {
    host: string;
    socketPath: string;
};
/** Local workspace tools disabled while an SSH session owns the shell. */
export declare const LOCAL_WORKSPACE_TOOLS: readonly ["read", "write", "edit", "patch", "glob", "grep"];
export type ShellExecuteBeforeEvent = {
    tool: string;
    sessionID: string;
    input: unknown;
};
export declare function quotePosix(value: string): string;
export declare function socketPath(home: string, sessionID: string, host: string): string;
export declare function validateHost(host: string): void;
/** Always POSIX-quotes the complete command as one SSH argument. Never trusts prefixes. */
export declare function wrapRemoteCommand(socket: string, host: string, command: string): string;
/**
 * Rewrites tool executions for sessions in remote mode:
 * - shell: idempotently wraps the command through the session's ControlMaster and
 *   strips local workdir/cwd so nothing local leaks into remote execution.
 * - local workspace tools (read/write/edit/patch/glob/grep): rejected so a stale
 *   tool list captured before ssh_connect cannot touch the workspace mid-turn.
 * Returns true when a remote shell execution was observed.
 */
export declare function transformShellExecuteBefore(event: ShellExecuteBeforeEvent, getState: (sessionID: string) => ConnectionState | undefined): boolean;
export declare function remoteSystemMessage(host: string): string;
type RemoteContextLike = {
    tools: Record<string, unknown>;
    system: Array<{
        type: unknown;
        text?: unknown;
    }>;
};
/** Applies the remote policy to a session context; safe to call repeatedly. */
export declare function applyRemoteContext(context: RemoteContextLike, host: string): void;
export type SessionEventLike = {
    type?: unknown;
    data?: unknown;
};
/**
 * Consumes a v2 event stream and disconnects sessions when they are deleted.
 * stop() aborts iteration, awaits settlement (bounded), and never throws.
 */
export declare function consumeSessionDeletions(events: AsyncIterable<SessionEventLike>, onDeleted: (sessionID: string) => Promise<void>): {
    stop(): Promise<void>;
};
export declare class SshConnections {
    private readonly states;
    private readonly disconnecting;
    private readonly operations;
    private readonly shells;
    private closing;
    private readonly options;
    constructor(options: {
        home?: string;
        runner: ProcessRunner;
        fs: FileOps;
        shellDrainMs?: number;
    });
    get(sessionID: string): ConnectionState | undefined;
    /**
     * Hook-time view used by execute.before: like get(), but throws once a
     * disconnect has begun until its teardown finishes, so a racing shell attempt
     * is rejected instead of finding no state and falling through to local execution.
     */
    getForShell(sessionID: string): ConnectionState | undefined;
    /** Tracks a remote shell execution starting; no-op without an active connection. */
    noteShellStart(sessionID: string): void;
    /** Tracks a remote shell execution ending; clamped at zero. */
    noteShellEnd(sessionID: string): void;
    /** Serializes per-session async operations so connect/disconnect cannot interleave. */
    private runExclusive;
    connect(sessionID: string, host: string): Promise<ConnectionState>;
    private connectUnlocked;
    disconnect(sessionID: string): Promise<void>;
    private disconnectUnlocked;
    /** Best-effort bounded wait for in-flight remote shells so masters are not stopped underneath them. */
    private awaitQuietShells;
    /** Shutdown barrier: drains accepted connects and active shells, stops every master, idempotent. */
    cleanup(): Promise<void>;
}
export {};
