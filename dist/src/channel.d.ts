import { spawn, type ChildProcess } from "node:child_process";
export declare const MAX_INPUT: number;
export declare const MAX_CLOSED_OWNERS = 256;
export declare function interactiveSshArgs(home: string, host: string, configExists: boolean): string[];
export type ChannelSocket = {
    send(data: string): void;
    close(): void;
    onData(handler: (data: string) => void): void;
    onClose(handler: () => void): void;
};
export type PtyTransport = {
    create(input: {
        command: string;
        args: string[];
        cols: number;
        rows: number;
    }): Promise<{
        id: string;
    }>;
    token(id: string): Promise<string>;
    connect(id: string, ticket: string): Promise<ChannelSocket>;
    resize(id: string, cols: number, rows: number): Promise<void>;
    remove(id: string): Promise<void>;
};
export type ChannelRecord = {
    id: string;
    ownerSessionID: string;
    host: string;
    ptyID: string;
    state: "open" | "closed" | "exited";
    cursor: number;
    dropped: number;
    output: Uint8Array;
    endedAt?: number;
};
export type ChannelStatus = Pick<ChannelRecord, "id" | "host" | "state" | "cursor" | "dropped" | "endedAt">;
export declare class SshChannelManager {
    private readonly channels;
    private readonly sockets;
    private readonly closingChannels;
    private readonly closePromises;
    private readonly operations;
    private closing;
    private readonly closedOwners;
    private readonly ownerClosePromises;
    private readonly transportRemovals;
    private readonly transport;
    constructor(options: {
        transport: PtyTransport;
    });
    open(ownerSessionID: string, host: string): Promise<ChannelRecord>;
    status(ownerSessionID: string, id: string): ChannelStatus;
    read(ownerSessionID: string, id: string, cursor?: number): {
        data: Uint8Array;
        cursor: number;
        dropped: number;
        state: ChannelRecord["state"];
    };
    write(ownerSessionID: string, id: string, data: string): void;
    resize(ownerSessionID: string, id: string, cols: number, rows: number): Promise<void>;
    close(ownerSessionID: string, id: string): Promise<void>;
    closeSession(ownerSessionID: string): Promise<void>;
    cleanup(): Promise<void>;
    private owned;
    private append;
    private handleExit;
    private removeTransport;
    private serial;
}
export declare function createLocalPtyTransport(options?: {
    home?: string;
    configExists?: boolean;
    command?: string;
    exitWaitMs?: number;
    spawnProcess?: typeof spawn;
    stdinWrite?: (child: ChildProcess, data: Uint8Array) => boolean;
}): PtyTransport;
