// Host work the mod cannot do itself (no Node here): router/launch.mjs does it.
import type { EngineInterface } from 'claude-code'

export type ToolOut = { ok?: boolean; error?: string; [key: string]: unknown }

export async function runTool($: EngineInterface, args: readonly string[], options: { stdin?: string; timeoutMs?: number } = {}): Promise<ToolOut> {
  const argv = ['node', `${$.plugin.root}/router/launch.mjs`, ...args]
  let result
  try {
    result = await $.process.run(argv, { ...(options.stdin !== undefined ? { stdin: options.stdin } : {}), timeoutMs: options.timeoutMs ?? 30_000 })
  } catch (err) {
    return { ok: false, error: `could not run node: ${String(err)}` }
  }
  return parseToolOut(result)
}

// A tool prints its answer as one JSON line, last on stdout.
export function parseToolOut(result: { exitCode: number; stdout: string; stderr: string }): ToolOut {
  const last = result.stdout.trim().split('\n').at(-1) ?? ''
  try { return JSON.parse(last) as ToolOut }
  catch { return { ok: false, error: (result.stderr || result.stdout || `exit ${result.exitCode}`).trim().slice(0, 500) } }
}

export async function readText($: EngineInterface, path: string): Promise<string | null> {
  try {
    const text = await $.fs.read(path)
    return typeof text === 'string' ? text : null
  } catch {
    return null
  }
}

export async function writeFile($: EngineInterface, path: string, text: string, options: { isPrivate?: boolean } = {}): Promise<void> {
  const out = await runTool($, ['write', path, ...(options.isPrivate ? ['--private'] : [])], { stdin: text })
  if (out.ok !== true) throw new Error(`could not write ${path}: ${out.error ?? 'unknown error'}`)
}

export async function deleteFile($: EngineInterface, path: string): Promise<void> {
  const out = await runTool($, ['delete', path])
  if (out.ok !== true) throw new Error(`could not delete ${path}: ${out.error ?? 'unknown error'}`)
}
