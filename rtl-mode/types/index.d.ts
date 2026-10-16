export type RtlMode = boolean

declare module 'claude-code' {
  interface PluginState {
    'rtl-mode': { isOn: RtlMode }
  }
}
