// 生成一份静态预览：不装插件、不开 GUI，也能用浏览器看看面板长什么样。
//   node scripts/preview.mjs  →  写出 preview.html
// 数据是实时折叠的，所以它和装上之后看到的完全一致（除了刷新按钮）。

import { writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const { snapshot } = await import(pathToFileURL(join(ROOT, 'lib', 'host', 'index.js')).href)
const { renderPage } = await import(pathToFileURL(join(ROOT, 'lib', 'host', 'page.js')).href)

const file = join(ROOT, 'preview.html')
writeFileSync(file, renderPage(snapshot()), 'utf8')
console.log(`已写出 ${file}`)
