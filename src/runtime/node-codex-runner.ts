import type { CodexCommandRunner } from '../types/provider';

/** Node-only runner, loaded lazily so browser bundles never evaluate child_process. */
export const nodeCodexCommandRunner: CodexCommandRunner = {
    async run(command, args, options) {
        const [{ execFile }, { promisify }] = await Promise.all([
            import('node:child_process'), import('node:util'),
        ]);
        const result = await promisify(execFile)(command, args, {
            cwd: options?.cwd, signal: options?.signal, encoding: 'utf8',
            maxBuffer: 16 * 1024 * 1024,
        });
        return { stdout: result.stdout, stderr: result.stderr };
    },
    async *stream(command, args, options) {
        const { spawn } = await import('node:child_process');
        const child = spawn(command, args, {
            cwd: options?.cwd, signal: options?.signal, stdio: ['ignore', 'pipe', 'pipe'],
        });
        let stderr = '';
        const closed = new Promise<number | null>((resolve, reject) => {
            child.once('error', reject);
            child.once('close', resolve);
        });
        child.stderr.setEncoding('utf8');
        child.stderr.on('data', chunk => { stderr += chunk; });
        child.stdout.setEncoding('utf8');
        for await (const chunk of child.stdout) yield String(chunk);
        const exitCode = await closed;
        if (exitCode !== 0) throw new Error(stderr.trim() || `codex exited with code ${exitCode}`);
    },
};
