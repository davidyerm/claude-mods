import type { EngineInterface } from 'claude-code'

export type Paths = {
  claudeDir: string
  userSettings: string
  routerHome: string
  config: string
  stateDir: string
  token: string
  backup: string
}

export type PathsEnv = { USERPROFILE?: string; HOME?: string; CLAUDE_CONFIG_DIR?: string; MODEL_ROUTER_HOME?: string }

// Same order as the router's routerHome(): MODEL_ROUTER_HOME, CLAUDE_CONFIG_DIR, ~/.claude.
// An empty string counts as unset.
export function pathsFrom(env: PathsEnv): Paths {
  const home = env.USERPROFILE || env.HOME || ''
  const claudeDir = env.CLAUDE_CONFIG_DIR || `${home}/.claude`
  const routerHome = env.MODEL_ROUTER_HOME || claudeDir
  const stateDir = `${routerHome}/model-router`
  return {
    claudeDir,
    userSettings: `${claudeDir}/settings.json`,
    routerHome,
    config: `${routerHome}/model-router.json`,
    stateDir,
    token: `${stateDir}/token`,
    backup: `${stateDir}/setup-backup.json`,
  }
}

export async function getPaths($: EngineInterface): Promise<Paths> {
  return pathsFrom({
    USERPROFILE: await $.env.get('USERPROFILE'),
    HOME: await $.env.get('HOME'),
    CLAUDE_CONFIG_DIR: await $.env.get('CLAUDE_CONFIG_DIR'),
    MODEL_ROUTER_HOME: await $.env.get('MODEL_ROUTER_HOME'),
  })
}
