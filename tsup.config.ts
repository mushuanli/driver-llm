import { defineConfig } from 'tsup';

export default defineConfig({
    entry: { index: 'src/index.ts', contracts: 'src/contracts.ts', chain: 'src/chain.ts' },
    format: ['esm', 'cjs'],
    dts: true,
    clean: true,
    sourcemap: true,
    splitting: false,
});
