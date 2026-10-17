// model-router's $.state contract: the session's main-model pick and its panes.
export type Pick = string | null
// description: the dim text after the label; isAction: a router-mode management row (drawn below a separator).
export type PickerEntry = { value: string; label: string; description?: string; disabledReason?: string; isAction?: true }
export type PickerView = { kind: 'main' } | { kind: 'family' } | { kind: 'target'; family: string }
// current: the entry marked with the check; cursor: the row the arrow is on (absent: current, else the first).
export type PickerState = { mode: 'model' | 'router'; view: PickerView; entries: PickerEntry[]; current?: string; cursor?: string } | null
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
