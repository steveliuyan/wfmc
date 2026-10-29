import { spawn } from 'node:child_process'
import { createServer } from 'vite'
import electronPath from 'electron'

const server = await createServer({ server: { port: 5273, strictPort: true } })
await server.listen()
server.printUrls()

process.env.NODE_ENV = 'development'
process.env.VITE_DEV_SERVER_URL = 'http://localhost:5273'

const buildOnce = spawn(process.execPath, ['scripts/build-main.mjs'], { stdio: 'inherit' })
await new Promise((r) => buildOnce.on('exit', r))

const child = spawn(electronPath, ['.'], { stdio: 'inherit', env: process.env })
child.on('exit', async () => {
  await server.close()
  process.exit(0)
})
