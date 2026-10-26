import { readFileSync } from "node:fs"
import { parse as parseYaml } from "yaml"
import { foldAll, sessionIndex, gitState } from "../lib/host/evidence.js"

const doc = parseYaml(readFileSync("projects.yaml", "utf8"))
console.log("projects:", doc.projects.length)

let t = Date.now()
await foldAll(doc, Date.now())
console.log("foldAll 冷（6 个 git 进程并发）:", Date.now() - t, "ms")

t = Date.now()
await foldAll(doc, Date.now())
console.log("foldAll 热（git 命中缓存）:", Date.now() - t, "ms")

t = Date.now()
const g = await gitState("D:/work/my-project")
console.log("gitState 冷:", Date.now() - t, "ms branch=", g && g.branch)
t = Date.now()
await gitState("D:/work/my-project")
console.log("gitState 热:", Date.now() - t, "ms")

let blocking = 0
const t0 = Date.now()
const timer = setInterval(() => { blocking += 1 }, 5)
await foldAll(doc, Date.now())
clearInterval(timer)
console.log("折叠期间事件循环被调用次数（5ms 间隔，越多越不堵）:", blocking, " 总耗时:", Date.now() - t0, "ms")
