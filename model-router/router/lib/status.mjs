import { allRefs } from './schema.mjs'

export function buildStatus({ version, pid, uptimeMs, config, configOk = config !== null, keyAvailability, breaker, eventsSeq }) {
  return {
    name: 'model-router',
    version,
    pid,
    uptimeMs,
    upstream: config?.upstream ?? null,
    configOk,
    providers: (config?.providers ?? []).map(p => {
      const a = keyAvailability(p.name)
      return { name: p.name, available: a.ok, ...(a.ok ? {} : { reason: a.reason }), breaker: breaker.status(p.name) }
    }),
    models: config ? allRefs(config).map(ref => ({ ref })) : [],
    policyApi: 1,
    eventsSeq,
  }
}
