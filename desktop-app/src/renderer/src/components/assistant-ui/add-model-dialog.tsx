import { useState, type FormEvent } from 'react'
import { EyeIcon } from 'lucide-react'

import type { AddLocalModelInput } from '../../../../shared/codexIpcApi'
import { Button } from '@/components/ui/button'
import { Combobox } from '@/components/ui/combobox'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Field, FieldDescription, FieldError, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'

type AddModelDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  onSubmit: (input: AddLocalModelInput) => Promise<void>
}

const initialInput: AddLocalModelInput = {
  platform: 'custom',
  baseUrl: '',
  fullUrl: false,
  apiKey: '',
  modelId: '',
  imageInput: 'auto',
  apiMode: 'auto'
}

export function AddModelDialog({
  open,
  onOpenChange,
  onSubmit
}: AddModelDialogProps): React.JSX.Element {
  const [input, setInput] = useState<AddLocalModelInput>(initialInput)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | undefined>()

  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault()
    setSaving(true)
    setError(undefined)
    try {
      await onSubmit(input)
      onOpenChange(false)
      setInput(initialInput)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[min(92vh,860px)] gap-0 overflow-y-auto p-0 sm:max-w-xl">
        <DialogHeader className="border-b px-6 py-5 text-left">
          <DialogTitle className="text-xl font-semibold">添加模型</DialogTitle>
          <DialogDescription className="sr-only">配置本地模型和请求地址</DialogDescription>
        </DialogHeader>
        <form onSubmit={(event) => void submit(event)} className="space-y-5 px-6 py-6">
          <Field>
            <FieldLabel htmlFor="add-model-platform">
              <span className="text-destructive">* </span>模型平台
            </FieldLabel>
            <Combobox
              id="add-model-platform"
              options={[
                { label: '自定义', value: 'custom' },
                { label: 'DeepSeek', value: 'deepseek' }
              ]}
              value={input.platform}
              onValueChange={(platform) => {
                if (platform !== 'custom' && platform !== 'deepseek') return
                setInput((current) => ({
                  ...current,
                  platform,
                  baseUrl: platform === 'deepseek' ? 'https://api.deepseek.com' : '',
                  fullUrl: false
                }))
              }}
            />
          </Field>

          <Field>
            <FieldLabel htmlFor="add-model-base-url">
              <span className="text-destructive">* </span>API 请求地址
            </FieldLabel>
            <Input
              id="add-model-base-url"
              type="url"
              required
              placeholder={
                input.fullUrl ? 'https://example.com/v1/responses' : 'https://example.com/v1'
              }
              value={input.baseUrl}
              onChange={(event) =>
                setInput((current) => ({ ...current, baseUrl: event.target.value }))
              }
            />
          </Field>

          <div className="flex items-start gap-3">
            <Switch
              id="add-model-full-url"
              checked={input.fullUrl}
              onCheckedChange={(fullUrl) => setInput((current) => ({ ...current, fullUrl }))}
            />
            <div className="grid gap-1">
              <FieldLabel htmlFor="add-model-full-url">完整 URL</FieldLabel>
              <FieldDescription>
                开启时填写以 /responses 结尾的完整地址；关闭时自动拼接请求路径。
              </FieldDescription>
            </div>
          </div>

          <Field>
            <FieldLabel htmlFor="add-model-api-key">
              <span className="text-destructive">* </span>API Key
            </FieldLabel>
            <Input
              id="add-model-api-key"
              type="password"
              required
              autoComplete="off"
              value={input.apiKey}
              onChange={(event) =>
                setInput((current) => ({ ...current, apiKey: event.target.value }))
              }
            />
            <FieldDescription>密钥经系统加密后保存在本机。</FieldDescription>
          </Field>

          <Field>
            <FieldLabel htmlFor="add-model-name">
              <span className="text-destructive">* </span>模型名称
            </FieldLabel>
            <Input
              id="add-model-name"
              required
              placeholder={
                input.platform === 'deepseek'
                  ? '输入模型 ID，例如 deepseek-flash'
                  : '输入模型 ID，例如 my-model'
              }
              value={input.modelId}
              onChange={(event) =>
                setInput((current) => ({ ...current, modelId: event.target.value }))
              }
            />
          </Field>

          <Field>
            <FieldLabel htmlFor="add-model-image-input" className="flex items-center gap-2">
              <EyeIcon className="size-4" />
              视觉输入
            </FieldLabel>
            <Combobox
              id="add-model-image-input"
              options={[
                { label: '自动识别', value: 'auto' },
                { label: '支持图片', value: 'supported' },
                { label: '不支持图片', value: 'unsupported' }
              ]}
              value={input.imageInput}
              onValueChange={(imageInput) => {
                if (
                  imageInput !== 'auto' &&
                  imageInput !== 'supported' &&
                  imageInput !== 'unsupported'
                )
                  return
                setInput((current) => ({ ...current, imageInput }))
              }}
            />
            <FieldDescription>
              自动识别目前按纯文本处理；若模型支持图片，请手动选择。
            </FieldDescription>
          </Field>

          <Field>
            <FieldLabel htmlFor="add-model-api-mode">请求接口</FieldLabel>
            <Combobox
              id="add-model-api-mode"
              options={[
                { label: '自动（Responses API）', value: 'auto' },
                { label: 'Responses API', value: 'responses' }
              ]}
              value={input.apiMode}
              onValueChange={(apiMode) => {
                if (apiMode !== 'auto' && apiMode !== 'responses') return
                setInput((current) => ({ ...current, apiMode }))
              }}
            />
            <FieldDescription>当前 Codex 服务使用 Responses API。</FieldDescription>
          </Field>

          {error && <FieldError role="alert">{error}</FieldError>}

          <DialogFooter className="pt-4">
            <Button
              type="button"
              variant="secondary"
              disabled={saving}
              onClick={() => onOpenChange(false)}
            >
              取消
            </Button>
            <Button type="submit" disabled={saving}>
              {saving ? '保存中…' : '确定'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
