import { build } from 'esbuild';

await build({
  entryPoints: ['src/extension.ts'],
  bundle: true,
  outfile: 'dist/extension.js',
  platform: 'node',
  target: 'node18',
  format: 'cjs',
  // Supplied by the extension host at runtime; bundling it would break activation.
  external: ['vscode'],
  minify: true,
  sourcemap: false,
  logLevel: 'info',
});
