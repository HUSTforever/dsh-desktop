// Drives the real Win32 folder-dialog worker on a given engine: expects the
// `{kind:'showing'}` IPC notice (spawn + koffi + COM + dialog creation all
// worked), then force-closes the worker. Usage: node drive-worker.mjs <node.exe>
import { spawn } from 'node:child_process'
import { resolve } from 'node:path'

const engine = resolve(process.argv[2] ?? './backend/runtime/node.exe')
const worker = resolve('./backend/node_modules/@deepseek-ai/dsh-host-directory-picker-native/lib/worker.cjs')
const child = spawn(engine, [worker], {
  env: { ...process.env, DSH_DIALOG_TITLE: 'DSH Desktop 冒烟测试（将自动关闭）' },
  stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
})
const timer = setTimeout(() => {
  console.log('RESULT: TIMEOUT — no showing notice within 20s')
  child.kill()
  process.exit(2)
}, 20_000)
child.on('message', message => {
  console.log('IPC:', JSON.stringify(message))
  if (message?.kind === 'showing') {
    clearTimeout(timer)
    console.log('RESULT: SHOWING_OK — dialog created under the new engine')
    child.kill()
    setTimeout(() => process.exit(0), 500)
  }
})
child.on('exit', code => {
  if (code !== null && code !== 0) {
    clearTimeout(timer)
    console.log(`RESULT: WORKER_CRASHED code=${code}`)
    process.exit(1)
  }
})
