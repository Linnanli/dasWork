import { BoxIcon } from 'lucide-react'

import { EndResourceCards } from '@/components/render-units/renderUnitDetails'
import { Button } from '@/components/ui/button'

import type { WorkspaceOutputCreationKind, WorkspaceOutputResource } from './taskWorkspaceTypes'

const outputCreationOptions: readonly {
  kind: WorkspaceOutputCreationKind
  label: string
}[] = [
  { kind: 'document', label: '文档' },
  { kind: 'presentation', label: '演示文稿' },
  { kind: 'spreadsheet', label: '电子表格' },
  { kind: 'website', label: '网站' }
]

export function OutputsWorkspace({
  resources,
  canOpenLocalPaths,
  onCreateOutput
}: {
  resources: readonly WorkspaceOutputResource[]
  canOpenLocalPaths: boolean
  onCreateOutput: (kind: WorkspaceOutputCreationKind) => void
}): React.JSX.Element {
  return (
    <section data-slot="workspace-outputs" className="h-full overflow-y-auto p-4">
      <header className="flex items-center gap-2 text-sm font-medium">
        <BoxIcon aria-hidden className="size-4 text-muted-foreground" />
        <h2>Outputs</h2>
      </header>
      <div
        data-slot="workspace-output-creation"
        className="mt-4 rounded-lg border border-border/70 bg-muted/30 p-3"
      >
        <p className="text-sm font-medium">创建新的产物</p>
        <p className="mt-1 text-xs text-muted-foreground">
          将在新任务中预填生成请求，发送前可以修改。
        </p>
        <div className="mt-3 flex flex-wrap gap-2">
          {outputCreationOptions.map(({ kind, label }) => (
            <Button
              key={kind}
              variant="outline"
              size="sm"
              aria-label={`创建${label}任务`}
              onClick={() => onCreateOutput(kind)}
            >
              创建{label}
            </Button>
          ))}
        </div>
      </div>
      {resources.length ? (
        <EndResourceCards
          resources={resources}
          canOpenLocalPaths={canOpenLocalPaths}
          dataSlot="workspace-output-resources"
        />
      ) : (
        <p className="mt-4 text-sm text-muted-foreground">这个任务还没有生成可打开的产物。</p>
      )}
    </section>
  )
}
