import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";
const host = process.env.TAURI_DEV_HOST;

// https://vite.dev/config/
export default defineConfig(async () => {
  const { default: packageJson } = await import('./package.json', { with: { type: 'json' } });
  return {
    plugins: [react()],
    define: {
      'import.meta.env.PACKAGE_VERSION': JSON.stringify(packageJson.version),
    },
    resolve: {
      alias: {
        "@": path.resolve(import.meta.dirname, "./src"),
      },
    },

    // Vite 8 / Rolldownのグループ指定でvendor分割を維持する。
    build: {
      rolldownOptions: {
        output: {
          codeSplitting: {
            groups: [
              { name: 'vendor-react', test: /[\\/]node_modules[\\/](?:react|react-dom|scheduler)[\\/]/ },
              { name: 'vendor-radix', test: /[\\/]node_modules[\\/]@radix-ui[\\/]/ },
              { name: 'vendor-dnd', test: /[\\/]node_modules[\\/]@dnd-kit[\\/]/ },
              { name: 'vendor-icons', test: /[\\/]node_modules[\\/](?:lucide-react|react-icons)[\\/]/ },
            ],
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
