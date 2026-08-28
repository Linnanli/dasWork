import { KeyboardIcon, RotateCcwIcon } from 'lucide-react'
import { useState } from 'react'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import {
  displayKeyboardShortcut,
  keyboardShortcutCommands,
  keyboardShortcutFromKeyEvent,
  keyboardShortcutLabel,
  type KeyboardShortcutBinding,
  type KeyboardShortcutCommand,
  type KeyboardShortcutConfig
} from '../../../../shared/keyboardShortcutsApi'

type KeyboardShortcutDialogProps = {
  config: KeyboardShortcutConfig
  open: boolean
  onOpenChange(open: boolean): void
  onReset(): Promise<void>
  onUpdate(command: KeyboardShortcutCommand, binding: KeyboardShortcutBinding): Promise<void>
}

export function KeyboardShortcutDialog({
  config,
  open,
  onOpenChange,
  onReset,
  onUpdate
}: KeyboardShortcutDialogProps): React.JSX.Element {
  const [recording, setRecording] = useState<KeyboardShortcutCommand | undefined>()
  const [query, setQuery] = useState('')
  const [error, setError] = useState<string | undefined>()
  const [saving, setSaving] = useState(false)

  const stopRecording = (): void => {
    setRecording(undefined)
    setError(undefined)
  }
  const captureShortcut = async (
    event: React.KeyboardEvent<HTMLButtonElement>,
    command: KeyboardShortcutCommand
  ): Promise<void> => {
    if (recording !== command) return
    event.preventDefault()
    event.stopPropagation()
    const binding = keyboardShortcutFromKeyEvent(event)
    if (!binding) {
      setError('请按住 Cmd 或 Ctrl，再按一个字母或数字。')
      return
    }

    setSaving(true)
    setError(undefined)
    try {
      await onUpdate(command, binding)
      stopRecording()
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : '无法保存快捷键。')
    } finally {
      setSaving(false)
    }
  }
  const reset = async (): Promise<void> => {
    setSaving(true)
    setError(undefined)
    try {
      await onReset()
      stopRecording()
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : '无法恢复默认快捷键。')
    } finally {
      setSaving(false)
    }
  }
  const visibleCommands = keyboardShortcutCommands.filter((command) =>
    keyboardShortcutLabel(command).includes(query.trim())
  )

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) stopRecording()
        onOpenChange(nextOpen)
      }}
    >
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>键盘快捷键</DialogTitle>
          <DialogDescription>
            点击一个操作后按下新组合键。只支持 Cmd/Ctrl 加字母或数字；编辑文字、使用终端或输入法时不会触发这些操作。
          </DialogDescription>
        </DialogHeader>
        <Input
          aria-label="搜索快捷键操作"
          placeholder="搜索快捷键操作…"
          value={query}
          onChange={(event) => setQuery(event.currentTarget.value)}
        />
        <div className="divide-y rounded-md border">
          {visibleCommands.map((command) => (
            <div key={command} className="flex items-center justify-between gap-3 px-3 py-2.5">
              <span className="text-sm">{keyboardShortcutLabel(command)}</span>
              <Button
                type="button"
                variant={recording === command ? 'default' : 'outline'}
                size="sm"
                aria-label={`修改${keyboardShortcutLabel(command)}快捷键`}
                disabled={saving}
                onBlur={() => recording === command && stopRecording()}
                onClick={() => {
                  setError(undefined)
                  setRecording(command)
                }}
                onKeyDown={(event) => void captureShortcut(event, command)}
              >
                <KeyboardIcon aria-hidden />
                {recording === command ? '请按快捷键…' : displayKeyboardShortcut(config[command])}
              </Button>
            </div>
          ))}
          {visibleCommands.length === 0 && (
            <p className="px-3 py-5 text-center text-sm text-muted-foreground">没有匹配的操作。</p>
          )}
        </div>
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        <DialogFooter>
          <Button type="button" variant="outline" disabled={saving} onClick={() => void reset()}>
            <RotateCcwIcon aria-hidden />
            恢复默认
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
