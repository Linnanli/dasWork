import { z } from 'zod'

export const keyboardShortcutCommands = [
  'new-task',
  'command-palette',
  'find-conversation',
  'toggle-sidebar',
  'focus-task-search'
] as const

export type KeyboardShortcutCommand = (typeof keyboardShortcutCommands)[number]
export type KeyboardShortcutBinding = `Mod+${string}`
export type KeyboardShortcutConfig = Record<KeyboardShortcutCommand, KeyboardShortcutBinding>
type KeyboardShortcutKeyEvent = {
  key: string
  altKey: boolean
  ctrlKey: boolean
  metaKey: boolean
  shiftKey: boolean
}

export const defaultKeyboardShortcutConfig: KeyboardShortcutConfig = {
  'new-task': 'Mod+N',
  'command-palette': 'Mod+K',
  'find-conversation': 'Mod+F',
  'toggle-sidebar': 'Mod+B',
  'focus-task-search': 'Mod+G'
}

export const keyboardShortcutCommandSchema = z.enum(keyboardShortcutCommands)
export const keyboardShortcutBindingSchema = z
  .string()
  .regex(/^Mod(?:\+Shift)?\+[A-Z0-9]$/, '快捷键必须是 Cmd/Ctrl 加一个字母或数字。')
  .transform((binding) => binding as KeyboardShortcutBinding)

const reservedShortcutKeys = new Set(['H', 'L', 'M', 'Q', 'R', 'T', 'W'])

export const keyboardShortcutConfigSchema = z
  .object({
    'new-task': keyboardShortcutBindingSchema,
    'command-palette': keyboardShortcutBindingSchema,
    'find-conversation': keyboardShortcutBindingSchema,
    'toggle-sidebar': keyboardShortcutBindingSchema,
    'focus-task-search': keyboardShortcutBindingSchema
  })
  .superRefine((config, context) => {
    const bindings = new Map<KeyboardShortcutBinding, KeyboardShortcutCommand>()
    for (const command of keyboardShortcutCommands) {
      const binding = config[command]
      const key = shortcutKey(binding)
      if (reservedShortcutKeys.has(key)) {
        context.addIssue({
          code: 'custom',
          path: [command],
          message: `${displayKeyboardShortcut(binding)} 是系统或浏览器保留组合，不能用于应用快捷键。`
        })
      }
      const existingCommand = bindings.get(binding)
      if (existingCommand) {
        context.addIssue({
          code: 'custom',
          path: [command],
          message: `${displayKeyboardShortcut(binding)} 已用于“${keyboardShortcutLabel(existingCommand)}”。`
        })
      } else {
        bindings.set(binding, command)
      }
    }
  })
  .transform((config) => config as KeyboardShortcutConfig)

export const keyboardShortcutUpdateRequestSchema = z.object({
  command: keyboardShortcutCommandSchema,
  binding: keyboardShortcutBindingSchema
})

export type KeyboardShortcutUpdateRequest = z.infer<typeof keyboardShortcutUpdateRequestSchema>

export const keyboardShortcutIpcChannels = {
  get: 'codex:keyboard-shortcuts:get',
  update: 'codex:keyboard-shortcuts:update',
  reset: 'codex:keyboard-shortcuts:reset'
} as const

export function displayKeyboardShortcut(binding: KeyboardShortcutBinding): string {
  return binding.replace(/^Mod/, 'Cmd/Ctrl').replace('+', ' + ')
}

export function keyboardShortcutLabel(command: KeyboardShortcutCommand): string {
  return (
    {
      'new-task': '新建任务',
      'command-palette': '命令面板',
      'find-conversation': '查找当前对话',
      'toggle-sidebar': '显示或隐藏侧栏',
      'focus-task-search': '搜索任务'
    } satisfies Record<KeyboardShortcutCommand, string>
  )[command]
}

export function keyboardShortcutFromKeyEvent(
  event: KeyboardShortcutKeyEvent
): KeyboardShortcutBinding | undefined {
  if (event.altKey || !(event.ctrlKey || event.metaKey)) return undefined
  const key = event.key.toLocaleUpperCase()
  if (!/^[A-Z0-9]$/.test(key)) return undefined
  return `Mod${event.shiftKey ? '+Shift' : ''}+${key}`
}

export function keyboardShortcutMatchesKeyEvent(
  binding: KeyboardShortcutBinding,
  event: KeyboardShortcutKeyEvent
): boolean {
  return keyboardShortcutFromKeyEvent(event) === binding
}

function shortcutKey(binding: KeyboardShortcutBinding): string {
  return binding.slice(binding.lastIndexOf('+') + 1)
}
