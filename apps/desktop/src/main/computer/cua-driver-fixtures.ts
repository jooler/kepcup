import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

// P-B1 B 层契约测试的 fixture（真实 cua-driver 应答录制，findings 0.40.1 复核）。
// 录制方式见 todo/computer-use-cua-adapter-findings.md；文件在 fixtures/cua-driver/。

const FIXTURE_DIRECTORY = join(
  fileURLToPath(new URL('.', import.meta.url)),
  'fixtures',
  'cua-driver'
)

export type CuaDriverFixture = {
  recordedFrom: string
  tool: string
  structuredContent: Record<string, unknown>
  screenshotBase64?: string
  result?: {
    isError?: boolean
    content: Array<{ type: string; text?: string }>
    structuredContent: Record<string, unknown> | null
  }
}

export function readCuaDriverFixture(name: string): CuaDriverFixture {
  return JSON.parse(readFileSync(join(FIXTURE_DIRECTORY, name), 'utf8')) as CuaDriverFixture
}
