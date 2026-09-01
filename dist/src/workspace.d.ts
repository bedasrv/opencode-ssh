import { type FileInfo } from "./ssh.js";
import type { WorkspaceAdapter, WorkspaceInfo } from "@opencode-ai/plugin";
export type WorkspaceChild = {
    running(): boolean;
    kill(force?: boolean): Promise<void>;
    wait(timeout: number): Promise<{
        stdout?: string;
        stderr?: string;
        code: number;
    }>;
};
export type WorkspaceRunner = {
    run(file: string, args: string[], options?: {
        timeout?: number;
        input?: string;
        stdio?: "pipe" | "ignore";
    }): Promise<{
        stdout: string;
        stderr: string;
        code: number;
    }>;
    start?(file: string, args: string[], options?: {
        timeout?: number;
    }): Promise<WorkspaceChild>;
};
export declare function createCommandRunner(): WorkspaceRunner;
export type WorkspaceFileOps = {
    mkdir(path: string, options: {
        recursive: boolean;
        mode: number;
    }): Promise<void>;
    rm(path: string, options?: {
        force?: boolean;
        recursive?: boolean;
    }): Promise<void>;
    exists(path: string): Promise<boolean>;
    chmod(path: string, mode: number): Promise<void>;
    lstat(path: string): Promise<FileInfo>;
};
type WorkspaceState = {
    owned: Set<string>;
    created: Set<string>;
    mounted: Set<string>;
    ready: Set<string>;
    failed: Set<string>;
    cleaned: Set<string>;
    pending: Set<string>;
    signatures: Map<string, string>;
    children: Map<string, WorkspaceChild>;
    creating: Map<string, Promise<void>>;
};
export type WorkspaceRegistry = {
    state: WorkspaceState;
    references: number;
};
type Dependencies = {
    home?: string;
    runner: WorkspaceRunner;
    fs: WorkspaceFileOps;
    registry?: WorkspaceRegistry;
};
export type WorkspaceAdapterInstance = Omit<WorkspaceAdapter, "configure"> & {
    configure(config: WorkspaceInfo): Promise<WorkspaceInfo>;
    cleanup(): Promise<void>;
    lookup(directory: string): WorkspaceBinding | undefined;
    lookupWorkspaceDirectory(directory: string): WorkspaceSessionBinding | undefined;
    ownsWorkspace(id: string): boolean;
    lookupWorkspace(id: string): WorkspaceBinding | undefined;
};
export type WorkspaceBinding = {
    host: string;
    remotePath: string;
};
export type WorkspaceSessionBinding = WorkspaceBinding & {
    localDirectory: string;
};
export declare function createWorkspaceAdapter(dependencies: Dependencies): WorkspaceAdapterInstance;
/** Maintains the validated session -> plugin-owned workspace relationship. */
export declare function createSessionWorkspaceAssociations(workspace: Pick<WorkspaceAdapterInstance, "lookupWorkspace"> & {
    ownsWorkspace?: (id: string) => boolean;
}): {
    attach(sessionID: string, workspaceID: string): boolean;
    has(sessionID: string): boolean;
    lookup(sessionID: string): WorkspaceBinding | undefined;
    remove(sessionID: string): void;
};
export {};
