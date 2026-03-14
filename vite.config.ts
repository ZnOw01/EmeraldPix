import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { defineConfig, type PluginOption } from 'vite';
import { visualizer } from 'rollup-plugin-visualizer';

const packageJson = JSON.parse(
  readFileSync(resolve(import.meta.dirname, 'package.json'), 'utf8')
) as { version: string };
const manifestJson = JSON.parse(
  readFileSync(resolve(import.meta.dirname, 'public/manifest.json'), 'utf8')
) as { version?: string };

function manifestVersionGuardPlugin(): PluginOption {
  return {
    name: 'emeraldpix-manifest-version-guard',
    buildStart() {
      if (manifestJson.version !== packageJson.version) {
        this.error(
          `public/manifest.json version (${manifestJson.version ?? 'missing'}) does not match package.json version (${packageJson.version}).`
        );
      }
    }
  };
}

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
      manifestVersionGuardPlugin(),
      buildMetaPlugin(buildId),
      ...(mode === 'development'
        ? [
            visualizer({
              filename: './dist/bundle-analysis.html',
              open: false,
              gzipSize: true,
              brotliSize: true
            })
          ]
        : [])
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
          popup: resolve(import.meta.dirname, 'popup.html'),
          offscreen: resolve(import.meta.dirname, 'offscreen.html'),
          service_worker: resolve(import.meta.dirname, 'src/background/service-worker.ts'),
          content_script: resolve(import.meta.dirname, 'src/content/content-script.ts')
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
