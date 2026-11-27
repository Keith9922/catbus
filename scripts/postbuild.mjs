#!/usr/bin/env node
// 构建后处理：给 dist/cli/main.js 加上可执行权限
import { chmod } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { resolve, dirname } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const mainJs = resolve(__dirname, '../dist/cli/main.js')

await chmod(mainJs, 0o755)
console.log('✓ dist/cli/main.js 已设为可执行')
