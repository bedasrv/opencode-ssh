import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
export function quotePosix(value) {
    return `'${value.replaceAll("'", "'\\''")}'`;
}
export function socketPath(home, sessionID, host) {
    const id = createHash("sha256").update(`${sessionID}\0${host}`).digest("hex").slice(0, 32);
    return join(home, ".ssh", "opencode-ssh", `${id}.sock`);
}
export function validateHost(host) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(host) || host.startsWith("-")) {
        throw new Error(`Invalid SSH host: ${host}`);
    }
}
export function wrapRemoteCommand(socket, host, command) {
    const prefix = `ssh -S ${quotePosix(socket)} ${quotePosix(host)} `;
    return command.startsWith(prefix) ? command : `${prefix}${quotePosix(command)}`;
}
export function transformShellExecuteBefore(event, getState) {
    if (event.tool !== "shell")
        return;
    if (!isRecord(event.input) || typeof event.input.command !== "string")
        return;
    const state = getState(event.sessionID);
    if (!state)
        return;
    event.input.command = wrapRemoteCommand(state.socketPath, state.host, event.input.command);
}
function isRecord(value) {
    return typeof value === "object" && value !== null;
}
function describeError(error) {
    if (!(error instanceof Error))
        return String(error);
    const stderr = error.stderr;
    const detail = typeof stderr === "string" ? stderr.trim() : "";
    return detail ? `${error.message}: ${detail}` : error.message;
}
export class SshConnections {
    states = new Map();
    operations = new Map();
    options;
    constructor(options) {
        this.options = { ...options, home: options.home ?? homedir() };
    }
    get(sessionID) { return this.states.get(sessionID); }
    /** Serializes per-session async operations so connect/disconnect cannot interleave. */
    runExclusive(sessionID, operation) {
        const previous = this.operations.get(sessionID) ?? Promise.resolve();
        const result = previous.then(operation);
        const settled = result.then(() => { }, () => { });
        this.operations.set(sessionID, settled);
        void settled.then(() => {
            if (this.operations.get(sessionID) === settled)
                this.operations.delete(sessionID);
        });
        return result;
    }
    connect(sessionID, host) {
        return this.runExclusive(sessionID, () => this.connectUnlocked(sessionID, host));
    }
    async connectUnlocked(sessionID, host) {
        validateHost(host);
        const existing = this.states.get(sessionID);
        if (existing?.host === host) {
            try {
                await this.options.runner.run("ssh", ["-O", "check", "-S", existing.socketPath, host], { timeout: 5000 });
                return existing;
            }
            catch {
                await this.disconnectUnlocked(sessionID);
            }
        }
        else {
            await this.disconnectUnlocked(sessionID);
        }
        const socket = socketPath(this.options.home, sessionID, host);
        await this.options.fs.mkdir(join(this.options.home, ".ssh", "opencode-ssh"), { recursive: true, mode: 0o700 });
        try {
            if (await this.options.fs.exists(socket)) {
                try {
                    await this.options.runner.run("ssh", ["-O", "check", "-S", socket, host], { timeout: 5000 });
                    const state = { host, socketPath: socket };
                    this.states.set(sessionID, state);
                    return state;
                }
                catch {
                    await this.options.fs.rm(socket, { force: true });
                }
            }
            await this.options.runner.run("ssh", ["-MNf", "-S", socket, host], { timeout: 15000 });
            const state = { host, socketPath: socket };
            this.states.set(sessionID, state);
            return state;
        }
        catch (error) {
            await this.options.fs.rm(socket, { force: true }).catch(() => { });
            throw new Error(`Failed to connect to ${host}: ${describeError(error)}`);
        }
    }
    disconnect(sessionID) {
        return this.runExclusive(sessionID, () => this.disconnectUnlocked(sessionID));
    }
    async disconnectUnlocked(sessionID) {
        const state = this.states.get(sessionID);
        if (!state)
            return;
        this.states.delete(sessionID);
        try {
            await this.options.runner.run("ssh", ["-O", "stop", "-S", state.socketPath, state.host], { timeout: 5000 });
        }
        catch { }
        await this.options.fs.rm(state.socketPath, { force: true }).catch(() => { });
    }
    async cleanup() {
        for (;;) {
            const inFlight = [...this.operations.values()];
            if (inFlight.length === 0)
                break;
            await Promise.all(inFlight);
        }
        await Promise.all([...this.states.keys()].map((sessionID) => this.disconnect(sessionID)));
    }
}
