# opencode-ssh

[![CI](https://github.com/bedasrv/opencode-ssh/actions/workflows/ci.yml/badge.svg)](https://github.com/bedasrv/opencode-ssh/actions/workflows/ci.yml)

An OpenCode v2 plugin that runs shell commands through a persistent SSH ControlMaster. It uses SSH host aliases from `~/.ssh/config`; OpenCode itself does not need to be installed on the remote host.

## Install

Install the package in the OpenCode config directory. For a local source checkout, use `--install-links` so npm copies the package instead of creating a symlink with a missing runtime dependency:

```sh
npm install --prefix ~/.config/opencode --install-links /path/to/opencode-ssh
```

Add it to `~/.config/opencode/opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [{"package": "./node_modules/opencode-ssh", "options": {}}]
}
```

For a local source checkout, reference the installed package by its explicit local path, `./node_modules/opencode-ssh`. A bare package name like `opencode-ssh` is treated as an npm registry dependency (and fails with `No versions available for opencode-ssh`). Local paths must start with `./` and are resolved relative to `~/.config/opencode/opencode.json`.

The plugin requires the OpenCode v2 beta plugin runtime.

## Usage

Ask the model to connect to an alias, for example:

```text
Connect to myHost
```

The model calls `ssh_connect`. After connection, the v2 shell tool hook rewrites every shell command using that OpenCode session's persistent ControlMaster. This is not dependent on prompt instructions. Remote commands start in the SSH login shell's working directory; the plugin does not preserve OpenCode's local cwd. Use `ssh_disconnect` or ask to return local to close it.

## SSH setup

Use an SSH key or an SSH agent. Password prompts and `sshpass` are intentionally unsupported.

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

Shell file commands such as `cat`, `tee`, `find`, and remote `grep` run on the server. OpenCode's local `read`, `edit`, `glob`, and `grep` tools are removed from the session context while remote mode is active, preventing accidental local edits or searches. Disconnect to restore local tools.

Control sockets are kept in a private `~/.ssh/opencode-ssh` directory with mode `0700`, use collision-resistant names, and are removed when a session disconnects or the plugin is cleaned up. Stale sockets are discarded and healthy masters are reused.

## Troubleshooting

- `Invalid SSH host`: use a host alias or hostname containing only letters, numbers, `.`, `_`, `:`, or `-`; shell metacharacters are rejected.
- Connection failure: run `ssh -v myHost` manually and check key, agent, hostname, and SSH config settings.
- Permission denied for the socket directory: ensure the home directory and `~/.ssh` are writable by the current user.
- Commands still run locally: confirm the v2 plugin is installed in the active config and that `ssh_connect` completed successfully.
