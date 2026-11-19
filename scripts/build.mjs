import { existsSync, rmSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

// 清掉旧产物并在生产模式下构建（Windows / macOS 通用）
rmSync('dist', { recursive: true, force: true })
const rspackBin = fileURLToPath(new URL('../node_modules/@rspack/cli/bin/rspack.js', import.meta.url))
const result = spawnSync(process.execPath, [rspackBin, 'build', '-c', 'rspack.config.ts'], {
  stdio: 'inherit',
  env: { ...process.env, NODE_ENV: 'production' },
})

// rspack 2 在 Windows 上退出时偶发 0xC0000005，只要产物写出来了就按成功处理
const crashedAfterBuild = result.status === 3221225477 && existsSync('dist/index.html')
if (crashedAfterBuild) {
  console.log('[rspack 退出时崩溃 0xC0000005，产物已生成，按成功处理]')
}
process.exitCode = result.status === 0 || crashedAfterBuild ? 0 : (result.status ?? 1)
