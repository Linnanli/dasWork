import { useMemo, useState } from 'react'
import {
  ToolGroupContent,
  ToolGroupRoot,
  ToolGroupTrigger
} from '@/components/assistant-ui/tool-group'
import { useChatImageConversation } from '@/components/conversation/chatImageConversationContext'
import { ChatImage, useImagePreview, type ChatImageDescriptor } from '@/components/images'
import type { AssistantRenderUnit, ToolItem } from '@/lib/assistantRenderUnits'
import { renderUnitAttributes } from './renderUnitAttributes'

function imagePath(item: ToolItem): string {
  const input = item.input
  if (input && typeof input === 'object' && 'path' in input && typeof input.path === 'string') {
    return input.path
  }
  return typeof item.rawItem?.path === 'string' ? item.rawItem.path : ''
}

function imageViewError(item: ToolItem): string | undefined {
  if (typeof item.error === 'string') return item.error
  if (item.error instanceof Error) return item.error.message
  const part = item.rawPart
  return 'errorText' in part && typeof part.errorText === 'string' ? part.errorText : undefined
}

export function ImageViewActivity({
  unit
}: {
  unit: Extract<AssistantRenderUnit, { type: 'tool-group' }>
}): React.JSX.Element {
  const [expanded, setExpanded] = useState(false)
  const owner = useChatImageConversation()
  const preview = useImagePreview()
  const images = useMemo<ChatImageDescriptor[]>(
    () =>
      unit.children.map((item) => ({
        id: `${unit.key}:${item.id}`,
        source: imagePath(item),
        sourceKind: 'native-path',
        alt: imagePath(item).split(/[\\/]/u).at(-1) || '图片',
        ...owner
      })),
    [owner, unit.children, unit.key]
  )
  const count = unit.children.length

  return (
    <ToolGroupRoot
      variant="ghost"
      data-slot="image-view-activity"
      data-tool-group-kind="image-view"
      open={expanded}
      onOpenChange={setExpanded}
      {...renderUnitAttributes(unit)}
    >
      <ToolGroupTrigger count={count} label={`已查看 ${count} 张图片`} icon="image-view" />
      <ToolGroupContent>
        {expanded ? (
          <div data-slot="image-view-images" className="flex gap-2 overflow-x-auto py-1">
            {images.map((image, index) => (
              <div key={image.id} className="shrink-0">
                <ChatImage
                  image={image}
                  variant="thumbnail"
                  onPreview={(_, trigger) => preview.open(images, index, trigger)}
                />
                {imageViewError(unit.children[index]!) ? (
                  <p role="alert" className="mt-1 max-w-40 text-xs text-destructive">
                    {imageViewError(unit.children[index]!)}
                  </p>
                ) : null}
              </div>
            ))}
          </div>
        ) : null}
      </ToolGroupContent>
    </ToolGroupRoot>
  )
}
