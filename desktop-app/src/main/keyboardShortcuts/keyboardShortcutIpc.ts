import {
  keyboardShortcutConfigSchema,
  keyboardShortcutUpdateRequestSchema,
  type KeyboardShortcutConfig
} from '../../shared/keyboardShortcutsApi'
import type { KeyboardShortcutService } from './KeyboardShortcutService'

type KeyboardShortcutServiceLike = Pick<KeyboardShortcutService, 'get' | 'update' | 'reset'>

export function createKeyboardShortcutIpcHandlers(service: KeyboardShortcutServiceLike): {
  get(): KeyboardShortcutConfig
  update(_event: unknown, payload: unknown): Promise<KeyboardShortcutConfig>
  reset(): Promise<KeyboardShortcutConfig>
} {
  return {
    get: () => keyboardShortcutConfigSchema.parse(service.get()),
    update: async (_event, payload) =>
      keyboardShortcutConfigSchema.parse(
        await service.update(keyboardShortcutUpdateRequestSchema.parse(payload))
      ),
    reset: async () => keyboardShortcutConfigSchema.parse(await service.reset())
  }
}
