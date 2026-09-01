import test from "node:test"
import assert from "node:assert/strict"
import plugin from "../src/index.js"
import { createCommandRunner, createSessionWorkspaceAssociations, createWorkspaceAdapter, type WorkspaceChild, type WorkspaceFileOps, type WorkspaceRunner } from "../src/workspace.js"
import { SshConnections } from "../src/ssh.js"
import { SshChannelManager } from "../src/channel.js"

const config = (extra: unknown, id = "ws-1") => ({ id, type: "sshfs", name: "SSHFS", branch: null, directory: null, extra, projectID: "p" })
type Call = { file: string; args: string[]; input?: string }
function fakes(options: { files?: Set<string>; symlinks?: Set<string>; hangWait?: boolean; results?: Record<string, { stdout?: string; stderr?: string; code?: number }> } = {}) {
  const files = options.files ?? new Set<string>(); const symlinks = options.symlinks ?? new Set<string>(); const calls: Call[] = []; const rmCalls: string[] = []
  let child: (WorkspaceChild & { killed: boolean; forceKilled: boolean; awaited: boolean; waits: number }) | undefined
  const runner: WorkspaceRunner = { async run(file, args, runOptions) { calls.push({ file, args, input: runOptions?.input }); const result = options.results?.[file] ?? { code: 0 }; if (file === "sftp" && runOptions?.input?.includes("stat")) throw Object.assign(new Error("Invalid command"), { stderr: "Invalid command" }); if ((result.code ?? 0) !== 0) throw Object.assign(new Error(result.stderr ?? `${file} failed`), { stderr: result.stderr }); return { stdout: result.stdout ?? (file === "sftp" ? "Remote working directory: /srv\n" : file === "findmnt" ? `${args[1]} fuse.sshfs\n` : ""), stderr: result.stderr ?? "", code: result.code ?? 0 } }, async start(file, args) { calls.push({ file, args }); const success = (options.results?.[file]?.code ?? 0) === 0
      child = { killed: false, forceKilled: false, awaited: false, waits: 0, running: () => success && !child!.killed, async kill(force?: boolean) { this.killed = true; this.forceKilled = !!force }, async wait() { this.awaited = true; this.waits++; if (options.hangWait) throw new Error("wait timeout"); return { code: success ? 0 : 1, stderr: options.results?.[file]?.stderr } } }; return child! } }
  const fs: WorkspaceFileOps = { async mkdir(path) { files.add(path) }, async rm(path) { rmCalls.push(path); files.delete(path) }, async exists(path) { return files.has(path) }, async chmod() {}, async lstat(path) { if (!files.has(path)) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" }); return { isSymbolicLink: () => symlinks.has(path) || path.includes("symlink") } } }
  return { runner, fs, calls, files, rmCalls, child: () => child }
}

test("workspace config accepts an SSH alias and absolute remote path", async () => { const adapter = createWorkspaceAdapter({ home: "/home/test", ...fakes() }); const result = await adapter.configure(config({ host: "prod-jump", path: "/srv/app" }, "config")); assert.equal((result.extra as any).host, "prod-jump"); assert.equal((result.extra as any).path, "/srv/app"); assert.equal(result.directory, "/home/test/.cache/opencode-ssh/workspaces/config") })
test("workspace config rejects credentials, metacharacters, and non-absolute/control paths", async () => { const adapter = createWorkspaceAdapter({ home: "/home/test", ...fakes() }); for (const extra of [{ host: "user@host", path: "/srv/app" }, { host: "prod;rm", path: "/srv/app" }, { host: "prod", path: "relative" }, { host: "prod", path: "/srv/../app" }, { host: "prod", path: "/srv/\u0000app" }, { host: "prod", path: "/srv/\napp" }]) await assert.rejects(() => adapter.configure(config(extra, `invalid-${Math.random()}`)), /Invalid|absolute|path/i) })
test("concurrent configure calls serialize ownership of one workspace ID", async () => {
  const fake = fakes();
  let lstatCalls = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve });
  const fs: WorkspaceFileOps = {
    ...fake.fs,
    async lstat(path) {
      lstatCalls++;
      if (lstatCalls === 1) await gate;
      return fake.fs.lstat(path);
    },
  };
  const adapter = createWorkspaceAdapter({ home: "/home/test", runner: fake.runner, fs });
  const first = adapter.configure(config({ host: "prod", path: "/srv" }, "configure-race"));
  const second = adapter.configure(config({ host: "prod", path: "/srv" }, "configure-race"));
  setTimeout(release, 10);
  const results = await Promise.allSettled([first, second]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(results.filter((result) => result.status === "rejected").length, 1);
  assert.match(String((results.find((result) => result.status === "rejected") as PromiseRejectedResult).reason), /duplicate|pending|already/i);
  assert.ok(lstatCalls > 0);
});

test("workspace allocates a private mountpoint and refuses duplicate or symlinked ownership", async () => { const bad = fakes({ files: new Set(["/home/test/.cache"]), symlinks: new Set(["/home/test/.cache"]) }); const badAdapter = createWorkspaceAdapter({ home: "/home/test", ...bad }); await assert.rejects(() => badAdapter.configure(config({ host: "prod", path: "/srv" }, "symlink-parent")), /symlink|owned/i); const fake = fakes(); const adapter = createWorkspaceAdapter({ home: "/home/test", ...fake }); await adapter.configure(config({ host: "prod", path: "/srv" }, "allocation")); await assert.rejects(() => adapter.configure(config({ host: "prod", path: "/srv" }, "allocation")), /duplicate|already/i) })

test("concurrent workspace creates share one sshfs child and cleanup reaps it", async () => {
  const fake = fakes();
  let started = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve });
  const children: WorkspaceChild[] = [];
  const runner: WorkspaceRunner = {
    ...fake.runner,
    async start(file, args) {
      started++;
      await gate;
      const child = await fake.runner.start!(file, args);
      children.push(child);
      return child;
    },
  };
  const adapter = createWorkspaceAdapter({ home: "/home/test", runner, fs: fake.fs });
  const cfg = await adapter.configure(config({ host: "prod", path: "/srv" }, "concurrent-create"));
  setTimeout(release, 10);
  await Promise.all([adapter.create(cfg, {}), adapter.create(cfg, {})]);
  assert.equal(started, 1);
  await adapter.remove(cfg);
  assert.equal(children.length, 1);
  assert.equal(children[0].running(), false);
});

test("workspace preflights SFTP, constructs sshfs through the alias, verifies mount, and removes only its owned mount", async () => { const fake = fakes({ files: new Set(["/home/test/.ssh/config"]) }); const adapter = createWorkspaceAdapter({ home: "/home/test", ...fake }); const cfg = await adapter.configure(config({ host: "prod-jump", path: "/srv/app" }, "life")); await adapter.create(cfg, {}); assert.deepEqual(fake.calls.map((c) => c.file), ["sftp", "sshfs", "findmnt"]); assert.deepEqual(fake.calls[0].args, ["-F", "/home/test/.ssh/config", "-o", "BatchMode=yes", "-b", "-", "prod-jump"]); assert.deepEqual(fake.calls[1].args, ["-F", "/home/test/.ssh/config", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes", "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=3", "-f", "prod-jump:/srv/app", cfg.directory!]); assert.deepEqual(adapter.target(cfg), { type: "local", directory: cfg.directory }); await adapter.remove(cfg); assert.ok(!fake.files.has(cfg.directory!)); assert.equal(fake.calls.at(-1)?.file, "fusermount3") })
test("sshfs runs foreground and the foreground child is the owned lifecycle process", async () => { const fake = fakes(); const adapter = createWorkspaceAdapter({ home: "/home/test", ...fake }); const cfg = await adapter.configure(config({ host: "prod", path: "/srv" }, "foreground")); await adapter.create(cfg, {}); const call = fake.calls.find((entry) => entry.file === "sshfs"); assert.equal(call?.args.at(-3), "-f"); assert.equal(fake.child()?.running(), true); await adapter.remove(cfg); assert.equal(fake.child()?.killed, true) })

test("workspace retries a transient findmnt failure before declaring mount verification failed", async () => { const fake = fakes(); let probes = 0; const runner: WorkspaceRunner = { ...fake.runner, async run(file, args, options) { if (file === "findmnt" && probes++ === 0) throw Object.assign(new Error("findmnt exited with 1"), { code: 1 }); return fake.runner.run(file, args, options) } }; const adapter = createWorkspaceAdapter({ home: "/home/test", runner, fs: fake.fs }); const cfg = await adapter.configure(config({ host: "prod", path: "/srv" }, "findmnt-retry")); await adapter.create(cfg, {}); assert.equal(probes, 2); assert.deepEqual(adapter.target(cfg), { type: "local", directory: cfg.directory }); await adapter.remove(cfg) })
test("workspace fails closed and cleans up after SFTP, sshfs, or mount verification failure", async () => { for (const [file, message] of [["sftp", "SFTP preflight"], ["sshfs", "sshfs"], ["findmnt", "mount verification"]] as const) { const fake = fakes({ results: { [file]: { code: 1, stderr: "permission denied" } } }); const adapter = createWorkspaceAdapter({ home: "/home/test", ...fake }); const cfg = await adapter.configure(config({ host: "prod", path: "/srv" }, `failure-${file}`)); await assert.rejects(() => adapter.create(cfg, {}), new RegExp(message)); assert.ok(!fake.files.has(cfg.directory!)); await adapter.remove(cfg) } })
test("workspace rejects missing SFTP and non-directory remote paths without attempting sshfs", async () => { const fake = fakes({ results: { sftp: { code: 1, stderr: "subsystem request failed" } } }); const adapter = createWorkspaceAdapter({ home: "/home/test", ...fake }); const cfg = await adapter.configure(config({ host: "telnet-only", path: "/srv" }, "sftp-only")); await assert.rejects(() => adapter.create(cfg, {}), /SFTP preflight/i); assert.equal(fake.calls.some((c) => c.file === "sshfs"), false) })
test("legacy plugin registers one sshfs workspace adapter and disposes it", async () => { const registrations: string[] = []; let disposed = false; const hooks = await plugin.server({ experimental_workspace: { register(type: string, adapter: any) { registrations.push(type); adapter.cleanup = async () => { disposed = true } } } } as any); assert.deepEqual(registrations, ["sshfs"]); await hooks.dispose?.(); assert.equal(disposed, true) })
test("create resolves while sshfs child remains running and remove kills and awaits it", async () => { const fake = fakes(); const adapter = createWorkspaceAdapter({ home: "/home/test", ...fake }); const cfg = await adapter.configure(config({ host: "prod", path: "/srv" }, "running")); await adapter.create(cfg, {}); assert.equal(fake.child()?.killed, false); await adapter.remove(cfg); assert.equal(fake.child()?.killed, true); assert.equal(fake.child()?.awaited, true) })
test("SFTP and sshfs omit -F when the user SSH config is absent", async () => { const fake = fakes(); const adapter = createWorkspaceAdapter({ home: "/home/test", ...fake }); const cfg = await adapter.configure(config({ host: "prod", path: "/srv" }, "no-config")); await adapter.create(cfg, {}); assert.deepEqual(fake.calls.find((call) => call.file === "sftp")?.args, ["-o", "BatchMode=yes", "-b", "-", "prod"]); assert.equal(fake.calls.find((call) => call.file === "sshfs")?.args.includes("-F"), false); await adapter.remove(cfg) })
test("adapter ownership and cleanup are isolated and repeated cleanup is deterministic", async () => { const first = fakes(); const second = fakes(); const one = createWorkspaceAdapter({ home: "/home/test", ...first }); const two = createWorkspaceAdapter({ home: "/home/test", ...second }); const cfgOne = await one.configure(config({ host: "one", path: "/srv" }, "isolated-one")); const cfgTwo = await two.configure(config({ host: "two", path: "/srv" }, "isolated-two")); await one.create(cfgOne, {}); await one.remove(cfgOne); await one.remove(cfgOne); await two.remove(cfgTwo) })

test("failed create can be removed idempotently, but an unrelated path cannot", async () => { const fake = fakes({ results: { sftp: { code: 1, stderr: "denied" } } }); const adapter = createWorkspaceAdapter({ home: "/home/test", ...fake }); const cfg = await adapter.configure(config({ host: "prod", path: "/srv" }, "failed-remove")); await assert.rejects(() => adapter.create(cfg, {}), /SFTP preflight/i); await adapter.remove(cfg); await adapter.remove(cfg); await assert.rejects(() => adapter.remove({ ...cfg, directory: "/tmp/unrelated" }), /not owned|unknown/i) })

test("failed create cannot produce a ready local target", async () => { const fake = fakes({ results: { findmnt: { code: 1, stderr: "not mounted" } } }); const adapter = createWorkspaceAdapter({ home: "/home/test", ...fake }); const cfg = await adapter.configure(config({ host: "prod", path: "/srv" }, "not-ready")); await assert.rejects(() => adapter.create(cfg, {}), /mount verification/i); assert.throws(() => adapter.target(cfg), /not ready|not owned|refused/i) })

test("fusermount failure still kills and awaits the running child and clears state", async () => { const fake = fakes({ results: { fusermount3: { code: 1, stderr: "permission denied" } } }); const adapter = createWorkspaceAdapter({ home: "/home/test", ...fake }); const cfg = await adapter.configure(config({ host: "prod", path: "/srv" }, "unmount-failure")); await adapter.create(cfg, {}); await assert.rejects(() => adapter.remove(cfg), /fusermount|unmount/i); assert.equal(fake.child()?.killed, true); assert.equal(fake.child()?.awaited, true); assert.throws(() => adapter.target(cfg), /not ready|not owned|refused/i); await assert.rejects(() => adapter.remove(cfg), /fusermount|unmount/i); assert.equal(fake.calls.filter((call) => call.file === "fusermount3").length, 4) })

test("sshfs early exit is reported and cleaned", async () => { const fake = fakes({ results: { sshfs: { code: 1, stderr: "connection lost" } } }); const adapter = createWorkspaceAdapter({ home: "/home/test", ...fake }); const cfg = await adapter.configure(config({ host: "prod", path: "/srv" }, "early-exit")); await assert.rejects(() => adapter.create(cfg, {}), /sshfs/i); await adapter.remove(cfg) })
test("cleanup force-kills a child whose bounded wait fails and waits again", async () => { const fake = fakes({ hangWait: true }); const adapter = createWorkspaceAdapter({ home: "/home/test", ...fake }); const cfg = await adapter.configure(config({ host: "prod", path: "/srv" }, "force-kill")); await adapter.create(cfg, {}); await assert.rejects(() => adapter.remove(cfg), /child wait/i); assert.equal(fake.child()?.killed, true); assert.equal(fake.child()?.forceKilled, true); assert.equal(fake.child()?.waits, 2); await adapter.remove(cfg) })

test("command runner writes bounded input and captures output and exit", async () => { const runner = createCommandRunner(); const result = await runner.run(process.execPath, ["-e", "process.stdin.on('data', d => process.stdout.write(d.toString().toUpperCase()))"], { input: "sftp input\n" }); assert.equal(result.stdout, "SFTP INPUT\n"); assert.equal(result.code, 0) })
test("SFTP cd/pwd requires a directory and safely quotes spaces and quotes", async () => { const fake = fakes({ results: { sftp: { stdout: "Remote working directory: /srv\n" } } }); const adapter = createWorkspaceAdapter({ home: "/home/test", ...fake }); const cfg = await adapter.configure(config({ host: "prod", path: "/srv/a path/'quoted'" }, "file-cd")); await adapter.create(cfg, {}); assert.match(fake.calls.find((call) => call.file === "sftp")?.input ?? "", /cd '\/srv\/a path\/.*quoted.*'\npwd/) ; await adapter.remove(cfg) })
test("SFTP cd fails closed for a regular file or missing directory", async () => { const fake = fakes({ results: { sftp: { code: 1, stderr: "is not a directory" } } }); const adapter = createWorkspaceAdapter({ home: "/home/test", ...fake }); const cfg = await adapter.configure(config({ host: "prod", path: "/srv/file" }, "file-cd-failure")); await assert.rejects(() => adapter.create(cfg, {}), /SFTP preflight/i); assert.equal(fake.calls.some((call) => call.file === "sshfs"), false); await adapter.remove(cfg) })
test("mount verification rejects empty or wrong findmnt output", async () => { for (const output of ["", "/other fuse.sshfs\n"]) { const fake = fakes({ results: { findmnt: { stdout: output } } }); const adapter = createWorkspaceAdapter({ home: "/home/test", ...fake }); const cfg = await adapter.configure(config({ host: "prod", path: "/srv" }, `bad-mount-${output.length}`)); await assert.rejects(() => adapter.create(cfg, {}), /mount verification/i); await adapter.remove(cfg) } })
test("short and long-lived runners fail closed on output overflow", async () => { const runner = createCommandRunner(); await assert.rejects(() => runner.run(process.execPath, ["-e", "process.stdout.write('x'.repeat(1048577))"]), /output|limit/i); const child = await runner.start!(process.execPath, ["-e", "process.stdout.write('x'.repeat(1048577))"]); const result = await child.wait(1000); assert.notEqual(result.code, 0) })
test("ready workspace lookup maps only its mount root and safe descendants", async () => { const fake = fakes(); const adapter = createWorkspaceAdapter({ home: "/home/test", ...fake }); const cfg = await adapter.configure(config({ host: "prod", path: "/srv/app" }, "lookup")); assert.equal(adapter.lookup(cfg.directory!), undefined); await adapter.create(cfg, {}); assert.deepEqual(adapter.lookup(cfg.directory!), { host: "prod", remotePath: "/srv/app" }); assert.deepEqual(adapter.lookup(`${cfg.directory}/src/file`), { host: "prod", remotePath: "/srv/app/src/file" }); assert.equal(adapter.lookup(`${cfg.directory}/../other`), undefined); assert.equal(adapter.lookup("/tmp/local"), undefined); await adapter.remove(cfg); assert.equal(adapter.lookup(cfg.directory!), undefined) })
test("workspace lookup joins descendants safely when remote root is slash", async () => { const fake = fakes(); const adapter = createWorkspaceAdapter({ home: "/home/test", ...fake }); const cfg = await adapter.configure(config({ host: "prod", path: "/" }, "root-lookup")); await adapter.create(cfg, {}); assert.deepEqual(adapter.lookup(`${cfg.directory}/etc`), { host: "prod", remotePath: "/etc" }); await adapter.remove(cfg) })

test("create and target reject a forged ID or host/path for the owned directory", async () => { const fake = fakes(); const adapter = createWorkspaceAdapter({ home: "/home/test", ...fake }); const cfg = await adapter.configure(config({ host: "prod", path: "/srv" }, "identity")); const forged = { ...cfg, id: "other", extra: { host: "other", path: "/secret" } }; await assert.rejects(() => adapter.create(forged, {}), /owned|identity/i); assert.equal(fake.calls.length, 0); await adapter.create(cfg, {}); assert.throws(() => adapter.target(forged), /owned|ready|refused/i); await adapter.remove(cfg) })
test("unmount failure never removes the mountpoint and retries unmount later", async () => { const fake = fakes({ results: { fusermount3: { code: 1, stderr: "permission denied" } } }); const adapter = createWorkspaceAdapter({ home: "/home/test", ...fake }); const cfg = await adapter.configure(config({ host: "prod", path: "/srv" }, "unmount-safety")); await adapter.create(cfg, {}); await assert.rejects(() => adapter.remove(cfg), /unmount|fusermount/i); assert.deepEqual(fake.rmCalls, []); await assert.rejects(() => adapter.remove(cfg), /unmount|fusermount/i); assert.equal(fake.calls.filter((call) => call.file === "fusermount3").length, 4) })
test("pending cleanup blocks reconfiguration of the same workspace ID", async () => { const fake = fakes({ results: { fusermount3: { code: 1, stderr: "permission denied" } } }); const adapter = createWorkspaceAdapter({ home: "/home/test", ...fake }); const cfg = await adapter.configure(config({ host: "prod", path: "/srv" }, "pending-id")); await adapter.create(cfg, {}); await assert.rejects(() => adapter.remove(cfg)); await assert.rejects(() => adapter.configure(config({ host: "other", path: "/other" }, "pending-id")), /pending|owned|cleanup/i) })

test("session association is validated by workspace ID and removed on deletion", async () => {
  const fake = fakes();
  const adapter = createWorkspaceAdapter({ home: "/home/test", ...fake });
  const cfg = await adapter.configure(config({ host: "prod", path: "/srv/app" }, "session-workspace"));
  const associations = createSessionWorkspaceAssociations(adapter);

  assert.equal(associations.attach("session-1", "session-workspace"), false);
  await adapter.create(cfg, {});
  assert.equal(associations.attach("session-1", "session-workspace"), true);
  assert.deepEqual(associations.lookup("session-1"), { host: "prod", remotePath: "/srv/app", localDirectory: "/home/test/.cache/opencode-ssh/workspaces/session-workspace" });
  assert.equal(associations.attach("session-1", "missing-workspace"), false);
  assert.deepEqual(associations.lookup("session-1"), { host: "prod", remotePath: "/srv/app", localDirectory: "/home/test/.cache/opencode-ssh/workspaces/session-workspace" });
  associations.remove("session-1");
  assert.equal(associations.lookup("session-1"), undefined);
  await adapter.remove(cfg);
});

test("session association resolves lazily after a workspace becomes ready", async () => {
  const fake = fakes();
  const adapter = createWorkspaceAdapter({ home: "/home/test", ...fake });
  const cfg = await adapter.configure(config({ host: "prod", path: "/srv/app" }, "lazy-session-workspace"));
  const associations = createSessionWorkspaceAssociations(adapter);

  assert.equal(associations.attach("session-lazy", "lazy-session-workspace"), false);
  assert.equal(associations.has("session-lazy"), true);
  assert.equal(associations.lookup("session-lazy"), undefined);

  await adapter.create(cfg, {});

  assert.deepEqual(associations.lookup("session-lazy"), {
    host: "prod",
    remotePath: "/srv/app",
    localDirectory: "/home/test/.cache/opencode-ssh/workspaces/lazy-session-workspace",
  });
  await adapter.remove(cfg);
});

test("workspace state is visible across adapter instances in one process", async () => {
  const firstFake = fakes();
  const secondFake = fakes();
  const first = createWorkspaceAdapter({ home: "/home/test", ...firstFake });
  const second = createWorkspaceAdapter({ home: "/home/test", ...secondFake });
  const cfg = await first.configure(config({ host: "prod", path: "/srv/app" }, "shared-instance"));

  await first.create(cfg, {});

  assert.deepEqual(second.lookupWorkspace("shared-instance"), {
    host: "prod",
    remotePath: "/srv/app",
    localDirectory: "/home/test/.cache/opencode-ssh/workspaces/shared-instance",
  });
  await second.remove(cfg);
});
