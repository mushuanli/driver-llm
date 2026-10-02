// @file: driver-llm/runtime/node-codex-app-server-transport.ts
// Node stdio JSON-RPC transport for `codex app-server`. Framing/dispatch is
// inherited from JsonRpcLineTransport; only the stdio wire and process
// lifecycle are Node-specific.

import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { JsonRpcLineTransport } from './json-rpc-transport';

export class NodeCodexAppServerTransport extends JsonRpcLineTransport {
    private constructor(private readonly child: ChildProcessWithoutNullStreams) {
        super();
    }

    static async create(command = 'codex', cwd?: string): Promise<NodeCodexAppServerTransport> {
        const { spawn } = await import('node:child_process');
        const child = spawn(command, ['app-server', '--listen', 'stdio://'], {
            cwd,
            stdio: ['pipe', 'pipe', 'pipe'],
        });
        const transport = new NodeCodexAppServerTransport(child);
        transport.start();
        await transport.request('initialize', {
            clientInfo: { name: '@itookit/driver-llm', title: 'iTooKit LLM Driver', version: '0.1.0' },
            capabilities: { experimentalApi: true },
        });
        transport.notify('initialized');
        return transport;
    }

    protected writeLine(line: string): void {
        this.child.stdin.write(`${line}\n`);
    }

    async close(): Promise<void> {
        await super.close();
        this.child.kill();
    }

    private start(): void {
        this.child.stdout.setEncoding('utf8');
        let buffer = '';
        this.child.stdout.on('data', (chunk: Buffer) => {
            buffer += String(chunk);
            const lines = buffer.split(/\r?\n/);
            buffer = lines.pop() ?? '';
            for (const line of lines) this.handleLine(line);
        });
        // Swallow stderr so a chatty CLI cannot backpressure-block the process.
        this.child.stderr.setEncoding('utf8');
        this.child.stderr.on('data', () => {});
        this.child.once('error', error => this.fail(error));
        this.child.once('exit', code => this.fail(new Error(`codex app-server exited with code ${code ?? 'null'}`)));
    }
}
