import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";
const host = process.env.TAURI_DEV_HOST;

// https://vite.dev/config/
export default defineConfig(async () => {
  const packageJson = await import('./package.json');
  return {
    plugins: [react()],
    define: {
      'import.meta.env.PACKAGE_VERSION': JSON.stringify(packageJson.version),
    },
    resolve: {
      alias: {
        "@": path.resolve(__dirname, "./src"),
      },
    },

    // Bundle optimization: split vendor chunks
    build: {
      rollupOptions: {
        output: {
          manualChunks: {
            'vendor-react': ['react', 'react-dom'],
            'vendor-radix': [
              '@radix-ui/react-dialog',
              '@radix-ui/react-dropdown-menu',
              '@radix-ui/react-popover',
              '@radix-ui/react-tabs',
              '@radix-ui/react-tooltip',
              '@radix-ui/react-slider',
              '@radix-ui/react-switch',
              '@radix-ui/react-label',
              '@radix-ui/react-separator',
              '@radix-ui/react-radio-group',
              '@radix-ui/react-avatar',
            ],
            'vendor-dnd': ['@dnd-kit/core', '@dnd-kit/sortable', '@dnd-kit/utilities'],
            'vendor-icons': ['lucide-react', 'react-icons'],
          }
        }
      }
    },

    // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
    //
    // 1. prevent Vite from obscuring rust errors
    clearScreen: false,
    // 2. tauri expects a fixed port, fail if that port is not available
    server: {
      port: 1420,
      strictPort: true,
      host: host || false,
      hmr: host
        ? {
          protocol: "ws",
          host,
          port: 1421,
        }
        : undefined,
      watch: {
        // 3. tell Vite to ignore watching `src-tauri`
        ignored: ["**/src-tauri/**"],
      },
    },
  }
});
