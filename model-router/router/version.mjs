// The one version number: the router reports it, the launcher and the mod compare against it.
export const VERSION = '0.1.0'

// Versions compare as semver numbers (major.minor.patch; a missing part is 0, a
// pre-release suffix is ignored). Something that is not a version is the oldest.
function partsOf(v) {
  const m = typeof v === 'string' ? v.match(/^\d+(\.\d+)*/) : null
  return m ? m[0].split('.').map(Number) : null
}

export function compareVersions(a, b) {
  const x = partsOf(a)
  const y = partsOf(b)
  if (x === null || y === null) return x === y ? 0 : x === null ? -1 : 1
  for (let i = 0; i < Math.max(x.length, y.length, 3); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0)
    if (d !== 0) return d > 0 ? 1 : -1
  }
  return 0
}

// A running router of the same or a newer version is reused; only an older one is
// drained and replaced. force always replaces.
export const isReusable = (running, mine, force) => !force && compareVersions(running, mine) >= 0
