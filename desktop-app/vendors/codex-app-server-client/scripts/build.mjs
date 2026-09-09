import { rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { build } from 'esbuild';

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const distDir = join(packageRoot, 'dist');

await rm(distDir, { recursive: true, force: true });

const sharedOptions = {
    entryPoints: [join(packageRoot, 'src/index.ts')],
    bundle: true,
    minify: false,
    packages: 'external',
    platform: 'node',
    sourcemap: true,
    target: 'es2022',
    treeShaking: true,
};

await Promise.all([
    build({
        ...sharedOptions,
        format: 'esm',
        outfile: join(distDir, 'index.js'),
    }),
    build({
        ...sharedOptions,
        format: 'cjs',
        outfile: join(distDir, 'index.cjs'),
    }),
]);
