// Minimal repro of the directory-picker crash: koffi.view() over native memory.
import { createRequire } from 'node:module'
const require = createRequire('D:/tools/deepseek-harness/desktop/backend/lib/bin.js')
const koffi = require('koffi')
const ole32 = koffi.load('ole32.dll')
const coTaskMemAlloc = ole32.func('__stdcall', 'CoTaskMemAlloc', 'void *', ['uintptr'])
const p = coTaskMemAlloc(256)
if (p === null || p === undefined) { console.log('ALLOC FAILED'); process.exit(3) }
const view = koffi.view(p, 256)
console.log('KOFFI_VIEW_OK bytes=' + view.byteLength)
