import { BlocksIcon, BookOpenTextIcon, FileIcon, SearchIcon, WrenchIcon } from 'lucide-react'

import {
  SourceReferenceCards,
  type SourceReference
} from '@/components/render-units/renderUnitDetails'

import type { WorkspaceSource } from './taskWorkspaceTypes'

type WorkspaceReferenceSource = WorkspaceSource & SourceReference

export function SourcesWorkspace({
  sources,
  onOpenMcpApp
}: {
  sources: readonly WorkspaceSource[]
  onOpenMcpApp?(source: WorkspaceSource): void
}): React.JSX.Element {
  const referenceSources = sources.filter(isReferenceSource)
  const activitySources = sources.filter((source) => !isReferenceSource(source))

  return (
    <section data-slot="workspace-sources" className="h-full overflow-y-auto p-4">
      <header className="flex items-center gap-2 text-sm font-medium">
        <BookOpenTextIcon aria-hidden className="size-4 text-muted-foreground" />
        <h2>Sources</h2>
      </header>
      {sources.length ? (
        <div className="mt-4 space-y-4">
          {referenceSources.length ? (
            <SourceReferenceCards
              sources={referenceSources}
              dataSlot="workspace-source-references"
            />
          ) : null}
          {activitySources.length ? (
            <div data-slot="workspace-source-activity" className="space-y-2">
              {activitySources.map((source) => {
                const canOpenApp = Boolean(
                  source.sourceType === 'app' &&
                    source.mcpServer &&
                    source.resourceUri?.startsWith('ui://') &&
                    onOpenMcpApp
                )
                return (
                  <article
                    key={source.id}
                    data-slot="workspace-source-activity-card"
                    className="flex items-start gap-3 rounded-lg border border-border/70 bg-card/50 p-3"
                  >
                    <SourceActivityIcon sourceType={source.sourceType} />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium">{source.title}</p>
                      <p className="mt-0.5 text-xs text-muted-foreground">
                        {source.detail ?? source.filename ?? source.mediaType ?? sourceActivityLabel(source.sourceType)}
                      </p>
                    </div>
                    {canOpenApp ? (
                      <button
                        type="button"
                        className="shrink-0 rounded-md border border-border px-2 py-1 text-xs hover:bg-accent"
                        onClick={() => onOpenMcpApp?.(source)}
                      >
                        打开
                      </button>
                    ) : null}
                    <span className="shrink-0 text-xs text-muted-foreground">
                      {source.usageCount} 次
                    </span>
                  </article>
                )
              })}
            </div>
          ) : null}
        </div>
      ) : (
        <p className="mt-4 text-sm text-muted-foreground">这个任务还没有可显示的来源。</p>
      )}
    </section>
  )
}

function isReferenceSource(source: WorkspaceSource): source is WorkspaceReferenceSource {
  return source.sourceType === 'url' || source.sourceType === 'document'
}

function SourceActivityIcon({ sourceType }: { sourceType: WorkspaceSource['sourceType'] }): React.JSX.Element {
  const className = 'mt-0.5 size-4 shrink-0 text-muted-foreground'
  if (sourceType === 'file') return <FileIcon aria-hidden className={className} />
  if (sourceType === 'web-search') return <SearchIcon aria-hidden className={className} />
  if (sourceType === 'app') return <BlocksIcon aria-hidden className={className} />
  return <WrenchIcon aria-hidden className={className} />
}

function sourceActivityLabel(sourceType: WorkspaceSource['sourceType']): string {
  if (sourceType === 'file') return '文件'
  if (sourceType === 'web-search') return 'Web 搜索'
  if (sourceType === 'app') return 'MCP App'
  return 'MCP 工具'
}
