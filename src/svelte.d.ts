/// <reference types="vite/client" />

declare const __APP_VERSION__: string;
declare const __BUILD_ID__: string;
declare const __DEV_MODE__: boolean;

declare module '*.svelte' {
  import type { ComponentType, SvelteComponent } from 'svelte';

  const component: ComponentType<SvelteComponent>;
  export default component;
}
