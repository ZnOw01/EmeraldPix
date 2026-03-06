import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { defineConfig, type PluginOption } from 'vite';
import { visualizer } from 'rollup-plugin-visualizer';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const packageJson = JSON.parse(
  readFileSync(resolve(__dirname, 'package.json'), 'utf8')
) as { version: string };

function buildMetaPlugin(buildId: string): PluginOption {
  return {
    name: 'emeraldpix-build-meta',
    generateBundle() {
      this.emitFile({
        type: 'asset',
        fileName: 'build-meta.json',
        source: JSON.stringify(
          {
            buildId,
            version: packageJson.version,
            builtAt: new Date().toISOString()
          },
          null,
          2
        )
      });
    }
  };
}

export default defineConfig(({ mode }) => {
  const buildId = new Date().toISOString();

  return {
    plugins: [
      svelte(),
      buildMetaPlugin(buildId),
      visualizer({
        filename: './dist/bundle-analysis.html',
        open: false,
        gzipSize: true,
        brotliSize: true
      })
    ],
    define: {
      __DEV_MODE__: mode === 'development',
      __BUILD_ID__: JSON.stringify(buildId),
      __APP_VERSION__: JSON.stringify(packageJson.version)
    },
    build: {
      target: 'chrome120',
      outDir: 'dist',
      emptyOutDir: true,
      sourcemap: mode === 'development',
      modulePreload: { polyfill: false },
      watch: process.env.VITE_BUILD_WATCH === 'true' ? {} : null,
      rollupOptions: {
        input: {
          popup: resolve(__dirname, 'popup.html'),
          offscreen: resolve(__dirname, 'offscreen.html'),
          service_worker: resolve(__dirname, 'src/background/service-worker.ts'),
          content_script: resolve(__dirname, 'src/content/content-script.ts')
        },
        output: {
          entryFileNames: 'assets/[name].js',
          chunkFileNames: 'assets/[name].js',
          assetFileNames: 'assets/[name].[ext]'
        }
      }
    }
  };
});
