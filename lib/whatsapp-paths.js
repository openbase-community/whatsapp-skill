import { chmodSync, existsSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

export function defaultRuntimeRoot() {
  return resolve(process.env.WHATSAPP_RUNTIME_HOME || join(homedir(), '.whatsapp'))
}

export function runtimeRootFromOptions({ root = null } = {}) {
  return resolve(root || defaultRuntimeRoot())
}

export function ensureRuntimeLayout({ root = null } = {}) {
  const runtimeRoot = runtimeRootFromOptions({ root })
  const dirs = [
    [runtimeRoot, 0o710],
    [join(runtimeRoot, 'data'), 0o710],
    [join(runtimeRoot, 'data', 'catalog'), 0o750],
    [join(runtimeRoot, 'data', 'approved'), 0o750],
    [join(runtimeRoot, 'data', 'protected'), 0o700],
    [join(runtimeRoot, 'data', 'protected', 'archive'), 0o700],
    [join(runtimeRoot, 'data', 'protected', 'state'), 0o700],
    [join(runtimeRoot, 'auth'), 0o700],
    [join(runtimeRoot, 'logs'), 0o770],
  ]

  return {
    root: runtimeRoot,
    directories: dirs.map(([path, mode]) => ensureDirectory(path, mode)),
  }
}

function ensureDirectory(path, mode) {
  if (existsSync(path)) return { path, mode, created: false, ok: true }
  try {
    mkdirSync(path, { recursive: true, mode })
    try {
      chmodSync(path, mode)
    } catch {
      // The launchd installer owns authoritative mode repair.
    }
    return { path, mode, created: true, ok: true }
  } catch (err) {
    return {
      path,
      mode,
      created: false,
      ok: false,
      error: err?.code ?? err?.message ?? String(err),
    }
  }
}
