import {
  keyboardShortcutCommands,
  keyboardShortcutMatchesKeyEvent,
  type KeyboardShortcutCommand,
  type KeyboardShortcutConfig
} from '../../../../shared/keyboardShortcutsApi'
import { isWorkspaceEditableTarget } from '../workspace-container/workspaceFocusManager'

export function keyboardShortcutCommandForEvent(
  config: KeyboardShortcutConfig,
  event: KeyboardEvent
): KeyboardShortcutCommand | undefined {
  if (event.defaultPrevented || event.isComposing || isWorkspaceEditableTarget(event.target)) {
    return undefined
  }
  return keyboardShortcutCommands.find((command) =>
    keyboardShortcutMatchesKeyEvent(config[command], event)
  )
}
