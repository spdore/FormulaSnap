import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

export default defineConfig({
  cacheDir: resolve(workspaceRoot, '.toolchain', 'vite-cache'),
  plugins: [react()],
})