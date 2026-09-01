import * as pty from "node-pty";
const frame = (type, payload) => {
    const body = typeof payload === "string" ? new TextEncoder().encode(payload) : payload;
    const result = new Uint8Array(5 + body.length);
    new DataView(result.buffer).setUint32(0, body.length + 1);
    result[4] = type;
    result.set(body, 5);
    return result;
};
let terminal;
let input = new Uint8Array();
process.stdin.on("data", (chunk) => {
    const next = new Uint8Array(input.length + chunk.length);
    next.set(input);
    next.set(chunk, input.length);
    input = next;
    while (input.length >= 4) {
        const length = new DataView(input.buffer, input.byteOffset).getUint32(0);
        if (length > 1024 * 1024) {
            process.stderr.write("PTY frame is too large\n");
            process.exit(1);
            return;
        }
        if (input.length < length + 4)
            return;
        const type = input[4];
        const payload = input.slice(5, length + 4);
        input = input.slice(length + 4);
        try {
            if (type === 0) {
                const config = JSON.parse(new TextDecoder().decode(payload));
                terminal = pty.spawn(config.command, config.args, { name: "xterm-256color", cols: config.cols, rows: config.rows, cwd: config.home, env: config.env });
                terminal.onData((data) => process.stdout.write(frame(1, new TextEncoder().encode(data))));
                terminal.onExit(() => { process.stdout.write(frame(2, new Uint8Array()), () => process.exit(0)); });
                process.stdout.write(frame(0, new Uint8Array()));
            }
            else if (type === 1)
                terminal.write(new TextDecoder().decode(payload));
            else if (type === 2) {
                const size = JSON.parse(new TextDecoder().decode(payload));
                terminal.resize(size.cols, size.rows);
            }
            else if (type === 3)
                terminal.kill();
        }
        catch (error) {
            process.stdout.write(frame(4, error instanceof Error ? error.message : String(error)));
        }
    }
});
