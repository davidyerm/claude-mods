// model-router's $.state contract: the session's main-model pick and its panes.
export type Pick = string | null
export type PickerEntry = { value: string; label: string; disabledReason?: string }
export type PickerView = { kind: 'main' } | { kind: 'family' } | { kind: 'target'; family: string }
export type PickerState = { mode: 'model' | 'router'; view: PickerView; entries: PickerEntry[] } | null
export type WizardStep = 'name' | 'baseUrl' | 'key' | 'models' | 'test'
export type WizardState = {
  step: WizardStep
  name: string
  baseUrl: string
  key: string
  models: string
  message: string
  isProbeOk: boolean
} | null

declare module 'claude-code' {
  interface PluginState {
    'model-router': {
      pick: Pick
      seenModel: string | null
      isStarted: boolean
      picker: PickerState
      wizard: WizardState
    }
  }
}
