import { join, posix } from "node:path";
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { validateHost } from "./ssh.js";
const MAX_OUTPUT_BYTES = 1024 * 1024;
export function createCommandRunner() {
    const run = (file, args, options = {}) => new Promise((resolve, reject) => {
        const child = spawn(file, args, { stdio: ["pipe", options.stdio ?? "pipe", options.stdio ?? "pipe"] });
        let stdout = "";
        let stderr = "";
        let settled = false;
        const timer = options.timeout ? setTimeout(() => { child.kill("SIGKILL"); finish(new Error(`${file} timed out`)); }, options.timeout) : undefined;
        const finish = (error, code = 0) => { if (settled)
            return; settled = true; if (timer)
            clearTimeout(timer); error ? reject(Object.assign(error, { stdout, stderr, code })) : resolve({ stdout, stderr, code }); };
        if (child.stdout)
            child.stdout.on("data", (chunk) => { stdout += String(chunk); if (Buffer.byteLength(stdout) > MAX_OUTPUT_BYTES) {
                child.kill("SIGKILL");
                finish(new Error(`${file} output exceeded limit`));
            } });
        if (child.stderr)
            child.stderr.on("data", (chunk) => { stderr += String(chunk); if (Buffer.byteLength(stderr) > MAX_OUTPUT_BYTES) {
                child.kill("SIGKILL");
                finish(new Error(`${file} output exceeded limit`));
            } });
        child.once("error", (error) => finish(error));
        child.once("close", (code) => code === 0 ? finish(undefined, 0) : finish(Object.assign(new Error(`${file} exited with ${code}`), { stderr }), code ?? 1));
        if (child.stdin) {
            if (options.input !== undefined)
                child.stdin.end(options.input);
            else
                child.stdin.end();
        }
    });
    const start = async (file, args) => {
        const child = spawn(file, args, { stdio: ["ignore", "pipe", "pipe"] });
        let stderr = "";
        let stdout = "";
        let overflow = false;
        child.stdout.on("data", (chunk) => { stdout += String(chunk); if (Buffer.byteLength(stdout) > MAX_OUTPUT_BYTES) {
            overflow = true;
            child.kill("SIGKILL");
        } });
        child.stderr.on("data", (chunk) => { stderr += String(chunk); if (Buffer.byteLength(stderr) > MAX_OUTPUT_BYTES) {
            overflow = true;
            child.kill("SIGKILL");
        } });
        const exit = new Promise((resolve, reject) => { child.once("error", reject); child.once("close", (code) => resolve({ code: overflow ? 1 : (code ?? 1), stdout, stderr })); });
        return { running: () => child.exitCode === null, async kill(force = false) { if (child.exitCode === null)
                child.kill(force ? "SIGKILL" : "SIGTERM"); }, async wait(timeout) { return await Promise.race([exit, new Promise((_, reject) => setTimeout(() => reject(new Error("child wait timed out")), timeout))]); } };
    };
    return { run, start };
}
const registries = new Map();
function sharedRegistry(home) {
    let registry = registries.get(home);
    if (!registry) {
        registry = { state: { owned: new Set(), created: new Set(), mounted: new Set(), ready: new Set(), failed: new Set(), cleaned: new Set(), pending: new Set(), signatures: new Map(), children: new Map(), creating: new Map() }, references: 0 };
        registries.set(home, registry);
    }
    return registry;
}
function extraOf(config) {
    if (!config.extra || typeof config.extra !== "object")
        throw new Error("Invalid workspace configuration");
    const extra = config.extra;
    const host = extra.host;
    const path = extra.path;
    if (typeof host !== "string")
        throw new Error("Invalid SSH host alias");
    try {
        validateHost(host);
    }
    catch {
        throw new Error("Invalid SSH host alias; use a configured OpenSSH alias");
    }
    if (host.includes("@") || /[\s/\\$'\"`;&|<>]/.test(host))
        throw new Error("Invalid SSH host alias; credentials and command strings are not allowed");
    if (typeof path !== "string" || !path.startsWith("/") || path.includes("\u0000") || /[\x00-\x1f\x7f]/.test(path))
        throw new Error("Invalid remote path; it must be an absolute POSIX path");
    if (posix.normalize(path) !== path || path.split("/").some((part) => part === "." || part === ".."))
        throw new Error("Invalid remote path; traversal is not allowed");
    return { host, path };
}
function mountpoint(home, id) {
    if (!id || id.includes("/") || id === "." || id === "..")
        throw new Error("Invalid workspace ID");
    return join(home, ".cache", "opencode-ssh", "workspaces", id);
}
function ownedComponents(home, directory) {
    const root = join(home, ".cache", "opencode-ssh", "workspaces");
    return [join(home, ".cache"), join(home, ".cache", "opencode-ssh"), root, directory];
}
function batchPath(path) { return `'${path.replaceAll("'", "'\\''")}'`; }
function identity(home, config) {
    const extra = extraOf(config);
    const directory = mountpoint(home, config.id);
    return { directory, signature: `${extra.host}\0${extra.path}` };
}
async function refuseSymlink(fs, path) {
    try {
        const info = await fs.lstat(path);
        if (info.isSymbolicLink())
            throw new Error(`Workspace mountpoint is symlinked or not owned: ${path}`);
    }
    catch (error) {
        if (error instanceof Error && error.code === "ENOENT")
            return;
        throw error;
    }
}
export function createWorkspaceAdapter(dependencies) {
    const home = dependencies.home ?? homedir();
    const registry = dependencies.registry ?? sharedRegistry(home);
    registry.references++;
    const { owned, created, mounted, ready, failed, cleaned, pending, signatures, children, creating } = registry.state;
    let released = false;
    const configPath = join(home, ".ssh", "config");
    return {
        name: "SSH/SFTP workspace",
        description: "Use a final SSH/SFTP directory through the configured SSH route",
        async configure(config) {
            const { directory, signature } = identity(home, config);
            const extra = extraOf(config);
            const existing = creating.get(directory);
            if (existing)
                await existing;
            const operation = (async () => {
                if (owned.has(directory))
                    throw new Error(`Workspace mountpoint is already owned: ${directory}`);
                if (pending.has(directory))
                    throw new Error(`Workspace cleanup is pending for ${directory}`);
                for (const component of ownedComponents(home, directory))
                    await refuseSymlink(dependencies.fs, component);
                if (await dependencies.fs.exists(directory))
                    throw new Error(`Workspace mountpoint already exists: ${directory}`);
                cleaned.delete(directory);
                failed.delete(directory);
                pending.delete(directory);
                ready.delete(directory);
                owned.add(directory);
                signatures.set(directory, signature);
            })();
            creating.set(directory, operation);
            try {
                await operation;
                return { ...config, extra, directory };
            }
            finally {
                if (creating.get(directory) === operation)
                    creating.delete(directory);
            }
        },
        async create(config) {
            const directory = config.directory;
            if (directory) {
                const existing = creating.get(directory);
                if (existing) {
                    await existing;
                    if (ready.has(directory))
                        return;
                }
            }
            const operation = (async () => {
                const extra = extraOf(config);
                const expected = identity(home, config);
                if (!directory || directory !== expected.directory || signatures.get(directory) !== expected.signature || !owned.has(directory))
                    throw new Error("Workspace creation refused: mountpoint identity is not owned");
                let stage = "workspace setup";
                try {
                    const workspaces = join(home, ".cache", "opencode-ssh", "workspaces");
                    for (const component of ownedComponents(home, directory))
                        await refuseSymlink(dependencies.fs, component);
                    await dependencies.fs.mkdir(workspaces, { recursive: true, mode: 0o700 });
                    await refuseSymlink(dependencies.fs, directory);
                    if (await dependencies.fs.exists(directory))
                        throw new Error(`Workspace mountpoint already exists: ${directory}`);
                    await dependencies.fs.mkdir(directory, { recursive: false, mode: 0o700 });
                    created.add(directory);
                    await dependencies.fs.chmod(directory, 0o700);
                    stage = "SFTP preflight";
                    const sshPrefix = (await dependencies.fs.exists(configPath)) ? ["-F", configPath] : [];
                    stage = "SFTP preflight";
                    const sftp = await dependencies.runner.run("sftp", [...sshPrefix, "-o", "BatchMode=yes", "-b", "-", extra.host], { timeout: 10000, input: `cd ${batchPath(extra.path)}\npwd\n` });
                    const remoteDirectory = sftp.stdout.match(/Remote working directory:\s*(.+)/i)?.[1]?.trim();
                    if (!remoteDirectory)
                        throw new Error("SFTP cd/pwd did not prove the remote path is a directory");
                    stage = "sshfs";
                    if (!dependencies.runner.start)
                        throw new Error("sshfs process runner is unavailable");
                    const child = await dependencies.runner.start("sshfs", [...sshPrefix, "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes", "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=3", "-f", `${extra.host}:${extra.path}`, directory], { timeout: 10000 });
                    children.set(directory, child);
                    if (!child.running()) {
                        const result = await child.wait(1000);
                        throw new Error(result.stderr || "sshfs exited before mount verification");
                    }
                    mounted.add(directory);
                    stage = "mount verification";
                    const mountArgs = ["--mountpoint", directory, "--noheadings"];
                    let mount;
                    let mountError;
                    for (let attempt = 0; attempt < 5; attempt++) {
                        try {
                            const probe = await dependencies.runner.run("findmnt", mountArgs, { timeout: 5000 });
                            if (probe.stdout.trim() && probe.stdout.includes(directory)) {
                                mount = probe;
                                break;
                            }
                            mountError = new Error("findmnt returned no record for the owned mountpoint");
                        }
                        catch (error) {
                            mountError = error;
                        }
                        if (attempt < 4)
                            await new Promise((resolve) => setTimeout(resolve, 100));
                    }
                    if (!mount)
                        throw mountError instanceof Error ? mountError : new Error("findmnt returned no record for the owned mountpoint");
                    if (!(await dependencies.fs.exists(directory)))
                        throw new Error("mount root is not readable");
                    ready.add(directory);
                }
                catch (error) {
                    const detail = error instanceof Error ? error.message : String(error);
                    try {
                        await cleanupOwned(dependencies, directory, owned, created, mounted, children, pending);
                        failed.add(directory);
                    }
                    catch (cleanupError) {
                        failed.add(directory);
                        pending.add(directory);
                        const cleanupDetail = cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
                        throw new Error(`${stage} failed: ${detail}; cleanup failed: ${cleanupDetail}`);
                    }
                    throw new Error(`${stage} failed: ${detail}`);
                }
            })();
            if (!directory)
                return await operation;
            creating.set(directory, operation);
            try {
                await operation;
            }
            finally {
                if (creating.get(directory) === operation)
                    creating.delete(directory);
            }
        },
        async remove(config) {
            const directory = config.directory;
            const expected = identity(home, config);
            const signature = expected.signature;
            if (!directory)
                throw new Error("Workspace mountpoint is not owned");
            if (signatures.get(directory) !== signature || directory !== expected.directory)
                throw new Error("Workspace mountpoint is not owned");
            if (cleaned.has(directory) && !pending.has(directory))
                return;
            if (failed.has(directory) && !pending.has(directory)) {
                failed.delete(directory);
                cleaned.add(directory);
                return;
            }
            if (!owned.has(directory) && !pending.has(directory))
                throw new Error("Workspace mountpoint is not owned");
            try {
                await cleanupOwned(dependencies, directory, owned, created, mounted, children, pending);
                pending.delete(directory);
                failed.delete(directory);
                cleaned.add(directory);
            }
            catch (error) {
                pending.add(directory);
                throw error;
            }
            finally {
                ready.delete(directory);
            }
        },
        target(config) {
            const expected = identity(home, config);
            if (!config.directory || config.directory !== expected.directory || signatures.get(config.directory) !== expected.signature || !owned.has(config.directory) || !ready.has(config.directory))
                throw new Error("Workspace target refused: workspace is not ready");
            return { type: "local", directory: config.directory };
        },
        lookup(directory) {
            if (typeof directory !== "string" || !directory.startsWith("/") || /[\x00-\x1f\x7f]/.test(directory))
                return undefined;
            for (const [root, signature] of signatures) {
                if (!ready.has(root) || (directory !== root && !directory.startsWith(`${root}/`)))
                    continue;
                const suffix = directory.slice(root.length);
                if (suffix.split("/").some((part) => part === "." || part === ".."))
                    return undefined;
                const [host, remotePath] = signature.split("\0");
                return { host, remotePath: posix.join(remotePath, suffix) };
            }
            return undefined;
        },
        ownsWorkspace(id) {
            if (typeof id !== "string" || !id || id.includes("/") || id === "." || id === "..")
                return false;
            return owned.has(mountpoint(home, id));
        },
        lookupWorkspace(id) {
            if (typeof id !== "string" || !id || id.includes("/") || id === "." || id === "..")
                return undefined;
            const directory = mountpoint(home, id);
            const signature = signatures.get(directory);
            if (!signature || !ready.has(directory) || !owned.has(directory))
                return undefined;
            const [host, remotePath] = signature.split("\0");
            return { host, remotePath, localDirectory: directory };
        },
        async cleanup() {
            if (released)
                return;
            if (registry.references > 1) {
                released = true;
                registry.references--;
                return;
            }
            const directories = new Set([...owned, ...pending]);
            const errors = [];
            for (const directory of directories) {
                try {
                    await cleanupOwned(dependencies, directory, owned, created, mounted, children, pending);
                    pending.delete(directory);
                    ready.delete(directory);
                    failed.delete(directory);
                    cleaned.add(directory);
                }
                catch (error) {
                    pending.add(directory);
                    errors.push(error instanceof Error ? error.message : String(error));
                }
            }
            if (errors.length)
                throw new Error(errors.join("; "));
            released = true;
            registry.references--;
            registries.delete(home);
        },
    };
}
/** Maintains the validated session -> plugin-owned workspace relationship. */
export function createSessionWorkspaceAssociations(workspace) {
    const sessionWorkspaces = new Map();
    return {
        attach(sessionID, workspaceID) {
            if (typeof sessionID !== "string" || !sessionID || typeof workspaceID !== "string" || !workspaceID)
                return false;
            const owned = workspace.ownsWorkspace
                ? workspace.ownsWorkspace(workspaceID) || !!workspace.lookupWorkspace(workspaceID)
                : true;
            if (!owned)
                return false;
            sessionWorkspaces.set(sessionID, workspaceID);
            return !!workspace.lookupWorkspace(workspaceID);
        },
        has(sessionID) { return sessionWorkspaces.has(sessionID); },
        lookup(sessionID) {
            const workspaceID = sessionWorkspaces.get(sessionID);
            if (!workspaceID)
                return undefined;
            return workspace.lookupWorkspace(workspaceID);
        },
        remove(sessionID) { sessionWorkspaces.delete(sessionID); },
    };
}
async function cleanupOwned(dependencies, directory, owned, created, mounted, children, pending) {
    if (!owned.has(directory) && !pending.has(directory))
        throw new Error("Workspace mountpoint is not owned");
    const errors = [];
    let childTerminated = true;
    try {
        const required = mounted.has(directory) || pending.has(directory);
        let unmounted = !required;
        const attemptUnmount = async () => {
            try {
                await dependencies.runner.run("fusermount3", ["-u", directory], { timeout: 5000 });
                unmounted = true;
            }
            catch (error) {
                const detail = error instanceof Error ? `${error.message} ${error.stderr ?? ""}` : String(error);
                if (/already unmounted|not mounted|no such device|not found/i.test(detail))
                    unmounted = true;
                else
                    errors.push(`fusermount/unmount: ${detail}`);
            }
        };
        if (required)
            await attemptUnmount();
        const child = children.get(directory);
        if (child) {
            childTerminated = false;
            try {
                await child.kill();
            }
            catch (error) {
                errors.push(`child kill: ${error instanceof Error ? error.message : String(error)}`);
            }
            try {
                await child.wait(5000);
            }
            catch (error) {
                errors.push(`child wait: ${error instanceof Error ? error.message : String(error)}`);
                try {
                    await child.kill(true);
                }
                catch (forceError) {
                    errors.push(`child force-kill: ${forceError instanceof Error ? forceError.message : String(forceError)}`);
                }
                try {
                    await child.wait(5000);
                }
                catch (forceWaitError) {
                    errors.push(`child force-wait: ${forceWaitError instanceof Error ? forceWaitError.message : String(forceWaitError)}`);
                }
            }
            if (!child.running())
                childTerminated = true;
            else {
                errors.push("child remained running after cleanup");
            }
        }
        if (required && !unmounted)
            await attemptUnmount();
        if (unmounted && created.has(directory)) {
            try {
                await dependencies.fs.rm(directory, { recursive: true, force: true });
                created.delete(directory);
            }
            catch (error) {
                errors.push(`remove mountpoint: ${error instanceof Error ? error.message : String(error)}`);
            }
        }
    }
    finally {
        if (childTerminated)
            children.delete(directory);
        mounted.delete(directory);
        owned.delete(directory);
    }
    if (errors.length)
        throw new Error(errors.join("; "));
}
