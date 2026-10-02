import { defineConfig } from 'tsup';

export default defineConfig({
    entry: { index: 'src/index.ts', contracts: 'src/contracts.ts', chain: 'src/chain.ts' },
    format: ['esm', 'cjs'],
    dts: {
        // Bundle the neutral message contracts instead of publishing a workspace dependency.
        compilerOptions: { paths: { '@itookit/llm-context': ['../llm-context/src/domain/message.ts'] } },
    },
    clean: true,
    sourcemap: true,
    splitting: false,
});
