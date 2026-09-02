# opencode-ssh

[![CI](https://github.com/bedasrv/opencode-ssh/actions/workflows/ci.yml/badge.svg)](https://github.com/bedasrv/opencode-ssh/actions/workflows/ci.yml)

An OpenCode plugin with a certified legacy server() surface and a conditional setupV2() surface. It runs shell commands through a persistent SSH ControlMaster and uses SSH host aliases from ~/.ssh/config; OpenCode itself does not need to be installed on the remote host.

## Install

Install the package in the OpenCode config directory. For a local source checkout, use `--install-links` so npm copies the package instead of creating a symlink with a missing runtime dependency:

```sh
npm install --prefix ~/.config/opencode --install-links /path/to/opencode-ssh
```

Add it to `~/.config/opencode/opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["./node_modules/opencode-ssh"]
}
```

For a local source checkout, install the package into `~/.config/opencode` as above, then reference the installed package by its explicit local path, `./node_modules/opencode-ssh`. The singular `plugin` key is the OpenCode v2 configuration key. Local paths start with `./` and are resolved relative to `~/.config/opencode/opencode.json`.

The package exports a dual default entrypoint, `server()` and `setup()`, plus a named `setupV2()` alias. On the verified OpenCode runtime 0.0.0-dev-202608311804 the native `/api/session` surface loads the dual default entrypoint (no `SchemaError`), but its live promise context did not expose a custom-tool registration hook, so the native runtime no-ops setup safely and the certified model-facing route is the legacy `server()` surface through `/session` and `/experimental/tool`. On runtimes that do expose a `tool.hook("execute.before")` context, `setup()` registers the SSH tools and routes native `shell`/`bash` calls through SSHFS workspaces. Contexts without that hook no-op and return a no-op cleanup, and cleanup aggregates errors from the workspace adapter, channels, and connections.

## Usage

Ask the model to connect to an alias, for example:

```text
Connect to myHost
```

The model calls `ssh_connect`. Both `ssh_connect` and `ssh_disconnect` are first-class direct tools (`options.codemode: false` with a declared output schema), so call them directly — not through Code Mode `execute`. They return structured results, and failures surface as tool errors carrying the real error message instead of a generic "Tool execution failed". After connection, the shell tool hook rewrites every shell command using that OpenCode session's persistent ControlMaster. This is not dependent on prompt instructions. Remote commands start in the SSH login shell's working directory; OpenCode's local workdir is stripped from remote shell calls rather than translated to a remote `cd`. Use `ssh_disconnect` or ask to return local to close it.

### Interactive channels

Use `ssh_channel_open` with a validated SSH alias to create a persistent interactive terminal. Use `ssh_channel_read` and `ssh_channel_write` for UTF-8 terminal text (including control characters and NUL; this is not arbitrary binary transport), `ssh_channel_resize` for viewport changes, `ssh_channel_status` for state, and `ssh_channel_close` when finished. Channel writes are limited to 64 KiB after UTF-8 encoding. The plugin owns a real PTY running `ssh -tt`, so nested `ssh`, `telnet`, `picocom`, serial consoles, and `docker exec -it` can run without wrappers. Output is bounded to 64 KiB and reads return a cursor plus dropped-byte count. Channels persist across prompts while the plugin process remains alive; they are not recoverable after a plugin restart.

## SSH setup

### SSHFS workspaces (certified legacy `server()` mode)

The legacy plugin also provides an `sshfs` workspace adapter. The local machine must have `sshfs`, FUSE, and the OpenSSH `sftp` client available; the plugin never installs these prerequisites. Configure a final-host OpenSSH alias in `~/.ssh/config` (including any `ProxyJump` there) and use an absolute POSIX project path on that host. Workspace metadata accepts the alias and path only—no `user@host`, passwords, private keys, or inline hop strings.

When OpenCode creates the workspace, the adapter performs a non-mutating SFTP directory preflight, allocates a private plugin-owned local mount under the user's cache, starts SSHFS through the configured alias with `BatchMode=yes` and no password prompts, verifies the mount, and returns that private mount as the OpenCode local workspace target. Normal `read`, `write`, `edit`, `glob`, `grep`, VCS, and LSP operations therefore use the mounted directory. The original local project directory is not mounted over.

For a ready SSHFS mount, `shell` and legacy `bash` commands are routed through a per-session SSH ControlMaster and run in the matching final-host remote directory. Repeated shell/workspace binds reuse a successful per-session ControlMaster health check for up to 1000 ms by default, then run `ssh -O check` again; a failed recheck follows the existing reconnect/cleanup path. This is only a local latency optimization: ordinary shell-only connect behavior is unchanged, and the workspace remains fail-closed. The mount root and safe descendants map to corresponding remote paths; paths outside the managed mount, removed mounts, failed preflights, and unverified mounts fail closed rather than falling back to local execution. Workspace mode does not disable local filesystem tools. The explicit `ssh_connect`/`ssh_disconnect` mode remains separate and shell-only: it routes shell commands remotely but rejects local workspace tools as before.

Telnet, serial, console, `picocom`, and other PTY-only endpoints are not filesystem workspaces and cannot be offered to SSHFS. Use the persistent channel tools for those endpoints. SSHFS workspace cleanup is owner-scoped: disposal and workspace removal unmount the tracked mount, terminate and await the owned SSHFS process, and remove only private local state. Unmount or verification errors remain fail-closed and may require retry; the plugin does not claim that a live SSHFS mount has been run on every host.

OpenCode remains installed and runs locally; no OpenCode process is started on the final SSH host. The certified workspace registration is on the legacy `server()` surface. The native promise `setupV2()` export remains available only for runtimes exposing its tested custom-tool API and does not claim native workspace registration when that root workspace API is unavailable.

Use an SSH key or an SSH agent. Password prompts and `sshpass` are intentionally unsupported; master startup uses `BatchMode=yes`, so a missing key or passphrase fails fast instead of hanging. Every `ssh` invocation passes `-F ~/.ssh/config` explicitly when that file exists, so an overridden process `HOME` cannot silently switch OpenSSH to a different config.

Interactive channels use the plugin-owned `node-pty` process transport. The child receives a minimal environment containing the configured home, PATH, terminal type, SSH agent socket, and locale values; unrelated OpenCode service variables are not inherited. PTY state is process-local and is intentionally not recovered after plugin restart.

```sshconfig
Host myHost
    HostName 192.0.2.10
    User username
    ServerAliveInterval 60
```

Ensure the public key is in the remote user's `~/.ssh/authorized_keys` and verify `ssh myHost` works before using the plugin.

## Development and releases

Install the locked dependencies and run the same checks used by GitHub Actions:

```sh
npm ci
npm run typecheck
npm test
npm run build
```

CI runs on pushes and pull requests targeting `master` across Node.js 20 and 22. It also verifies that the checked-in `dist/src` artifacts are reproducible and that the npm package contains only the intended runtime files.

The release workflow publishes a tagged package after the full CI workflow passes. To publish, configure an `NPM_TOKEN` GitHub Actions secret for the repository, then push a tag matching the version in `package.json`, for example `v2.0.0`.

## Files

Shell file commands such as `cat`, `tee`, `find`, and remote `grep` run on the server. Both OpenCode shell tool names, `shell` and legacy `bash`, are rewritten through the ControlMaster while remote mode is active. In v2, local workspace tools may be removed from the session context; in legacy mode, `read`, `write`, `edit`, `patch`, `apply_patch`, `glob`, and `grep` are rejected at execution time, including when a stale tool list attempts to invoke them. Disconnect to restore local tools.

Control sockets are kept in a private `~/.ssh/opencode-ssh` directory whose `0700` mode is enforced on every connect (symlinked socket directories are refused). Socket names are collision-resistant, and sockets are removed when a session disconnects or the plugin is cleaned up. Deleting an OpenCode session disconnects it as well. Stale sockets are discarded and healthy masters are reused.

## Troubleshooting

- `Invalid SSH host`: use a host alias or hostname containing only letters, numbers, `.`, `_`, `:`, or `-`; shell metacharacters are rejected.
- Connection failure: run `ssh -v myHost` manually and check key, agent, hostname, and SSH config settings.
- Permission denied for the socket directory: ensure the home directory and `~/.ssh` are writable by the current user.
- Commands still run locally: confirm the v2 plugin is installed in the active config and that `ssh_connect` completed successfully.
