import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
	plugins: [react(), tailwindcss()],
	// strictPort, not "take the next one": the core's CORS is open to exactly
	// :3000, and a silent move to 3001 would trade a clear port error for an
	// obscure request error.
	server: { port: 3000, strictPort: true },
})
