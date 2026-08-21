export type ProcessRunner = {
    run(file: string, args: string[], options?: {
        timeout?: number;
    }): Promise<{
        stdout: string;
        stderr: string;
        code: number;
    }>;
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
};
export type ConnectionState = {
    host: string;
    socketPath: string;
};
export type ShellExecuteBeforeEvent = {
    tool: string;
    sessionID: string;
    input: unknown;
};
export declare function quotePosix(value: string): string;
export declare function socketPath(home: string, sessionID: string, host: string): string;
export declare function validateHost(host: string): void;
export declare function wrapRemoteCommand(socket: string, host: string, command: string): string;
export declare function transformShellExecuteBefore(event: ShellExecuteBeforeEvent, getState: (sessionID: string) => ConnectionState | undefined): void;
export declare class SshConnections {
    private readonly states;
    private readonly operations;
    private readonly options;
    constructor(options: {
        home?: string;
        runner: ProcessRunner;
        fs: FileOps;
    });
    get(sessionID: string): ConnectionState | undefined;
    /** Serializes per-session async operations so connect/disconnect cannot interleave. */
    private runExclusive;
    connect(sessionID: string, host: string): Promise<ConnectionState>;
    private connectUnlocked;
    disconnect(sessionID: string): Promise<void>;
    private disconnectUnlocked;
    cleanup(): Promise<void>;
}
