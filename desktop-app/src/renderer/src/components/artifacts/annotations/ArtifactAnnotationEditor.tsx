import { SendIcon, Trash2Icon } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import type { ArtifactAnnotationDraft } from './artifactAnnotationTypes'

export function ArtifactAnnotationEditor({
  draft,
  onBodyChange,
  onCancel,
  onSave,
  onSubmit
}: {
  draft: ArtifactAnnotationDraft
  onBodyChange(body: string): void
  onCancel(): void
  onSave(): void
  onSubmit(): void
}): React.JSX.Element {
  return (
    <section className="border-b border-border/70 bg-muted/30 px-4 py-3" aria-label="编辑批注">
      <div className="mb-2 flex items-center justify-between gap-2">
        <p className="text-sm font-medium">{targetLabel(draft)}</p>
        <Button
          type="button"
          size="icon-sm"
          variant="ghost"
          aria-label="取消批注"
          onClick={onCancel}
        >
          <Trash2Icon className="size-4" />
        </Button>
      </div>
      <Textarea
        autoFocus
        aria-label="批注内容"
        className="min-h-20"
        placeholder="写下需要审阅的内容…"
        value={draft.body}
        onChange={(event) => onBodyChange(event.target.value)}
      />
      <div className="mt-2 flex justify-end gap-2">
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={onSave}
          disabled={!draft.body.trim()}
        >
          保存到输入框
        </Button>
        <Button type="button" size="sm" onClick={onSubmit} disabled={!draft.body.trim()}>
          <SendIcon className="size-4" />
          直接提交
        </Button>
      </div>
    </section>
  )
}

function targetLabel(draft: ArtifactAnnotationDraft): string {
  switch (draft.target.kind) {
    case 'slide':
      return '整页批注'
    case 'element':
      return '元素批注'
    case 'region':
      return '区域批注'
  }
}
