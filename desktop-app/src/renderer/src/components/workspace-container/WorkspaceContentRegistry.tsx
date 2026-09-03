/* eslint-disable react-refresh/only-export-components -- registry exports are intentionally colocated. */
import type { ReactNode } from 'react'

import type { GitConversationTarget, LocalGitReviewSource } from '../../../../shared/localGitApi'
import { BrowserWorkspace } from '../right-workspace/browser/BrowserWorkspace'
import { repositionBrowserWorkspaceView } from '../right-workspace/browser/browserWorkspaceMove'
import { FileWorkspace } from '../right-workspace/files/FileWorkspace'
import { ReviewWorkspace } from '../right-workspace/review/ReviewWorkspace'
import { TerminalWorkspace } from '../right-workspace/terminal/TerminalWorkspace'
import { ArtifactTabContent } from '../artifacts/ArtifactTabContent'
import { artifactTabDescriptor } from '../artifacts/artifactTabDescriptor'
import {
  closeTerminalSession,
  terminalSessionIdFromTabId
} from '../right-workspace/terminal/terminalSessionStore'
import { refitTerminalWorkspace } from '../right-workspace/terminal/terminalWorkspaceMove'
import type { RightWorkspaceTab } from '../right-workspace/workspaceState'
import type {
  WorkspaceOpenMode,
  WorkspaceOpenOptions,
  WorkspaceOpenTarget
} from './workspaceOpenTargets'
import { isPptxArtifactPath } from './workspaceOpenTargets'
import type {
  WorkspacePanelId,
  WorkspacePanelState,
  WorkspaceTabRecord,
  WorkspaceTabRuntime
} from './workspaceTypes'

export type WorkspaceContentRenderContext = {
  panelId: WorkspacePanelId
  panel: WorkspacePanelState
  workspaceId: string
  target?: GitConversationTarget
  runtime: WorkspaceTabRuntime | undefined
  openTarget(target: WorkspaceOpenTarget, options?: WorkspaceOpenOptions): void
  setTabTitle(tabId: string, title: string): void
  setRuntime(tabId: string, runtime: WorkspaceTabRuntime): void
}

export type WorkspaceContentLifecycleContext = Pick<
  WorkspaceContentRenderContext,
  'panelId' | 'workspaceId' | 'runtime'
>

export type WorkspaceContentAdapter = {
  kind: string
  render(tab: WorkspaceTabRecord, context: WorkspaceContentRenderContext): ReactNode
  onBeforeClose?(
    tab: WorkspaceTabRecord,
    context: WorkspaceContentLifecycleContext
  ): Promise<boolean | void> | boolean | void
  onActivate?(
    tab: WorkspaceTabRecord,
    context: WorkspaceContentLifecycleContext
  ): Promise<void> | void
  onDeactivate?(
    tab: WorkspaceTabRecord,
    context: WorkspaceContentLifecycleContext
  ): Promise<void> | void
  onClose?(tab: WorkspaceTabRecord, context: WorkspaceContentLifecycleContext): Promise<void> | void
  onMove?(tab: WorkspaceTabRecord, context: WorkspaceContentLifecycleContext): Promise<void> | void
}

export class WorkspaceContentRegistry {
  private readonly adapters = new Map<string, WorkspaceContentAdapter>()

  register(adapter: WorkspaceContentAdapter): this {
    this.adapters.set(adapter.kind, adapter)
    return this
  }

  adapterFor(tab: WorkspaceTabRecord): WorkspaceContentAdapter | undefined {
    return this.adapters.get(tab.kind)
  }

  render(tab: WorkspaceTabRecord, context: WorkspaceContentRenderContext): ReactNode {
    const adapter = this.adapterFor(tab)
    if (!adapter) return <WorkspaceRestoreFailure title={tab.title} />
    return adapter.render(tab, context)
  }

  async close(tab: WorkspaceTabRecord, context: WorkspaceContentLifecycleContext): Promise<void> {
    await this.adapterFor(tab)?.onClose?.(tab, context)
  }

  async beforeClose(
    tab: WorkspaceTabRecord,
    context: WorkspaceContentLifecycleContext
  ): Promise<boolean> {
    return (await this.adapterFor(tab)?.onBeforeClose?.(tab, context)) !== false
  }

  async activate(
    tab: WorkspaceTabRecord,
    context: WorkspaceContentLifecycleContext
  ): Promise<void> {
    await this.adapterFor(tab)?.onActivate?.(tab, context)
  }

  async deactivate(
    tab: WorkspaceTabRecord,
    context: WorkspaceContentLifecycleContext
  ): Promise<void> {
    await this.adapterFor(tab)?.onDeactivate?.(tab, context)
  }

  async move(tab: WorkspaceTabRecord, context: WorkspaceContentLifecycleContext): Promise<void> {
    await this.adapterFor(tab)?.onMove?.(tab, context)
  }
}

export function createWorkspaceContentRegistry(): WorkspaceContentRegistry {
  return new WorkspaceContentRegistry()
    .register({
      kind: 'review',
      render: () => <ReviewWorkspace />
    })
    .register({
      kind: 'file',
      render: (tab, context) => (
        <FileWorkspace
          tab={asFileTab(tab)}
          workspaceId={context.workspaceId}
          target={context.target}
          onOpenFile={(relativePath, title, mode = 'preview') =>
            context.openTarget(
              isPptxArtifactPath(relativePath)
                ? {
                    type: 'artifact',
                    artifactType: 'slides',
                    importKind: 'pptx',
                    source: { kind: 'workspace-file', relativePath },
                    title: title ?? relativePath,
                    openSource: 'file-workspace'
                  }
                : { type: 'file', relativePath, title },
              fileOpenOptions(tab, context.panelId, mode)
            )
          }
        />
      )
    })
    .register({
      kind: 'artifact',
      render: (tab, context) => {
        const artifact = artifactTabDescriptor(tab)
        return artifact ? (
          <ArtifactTabContent
            artifact={artifact}
            workspaceId={context.workspaceId}
            target={context.target}
            runtime={context.runtime}
            onRuntimeChange={(runtime) => context.setRuntime(tab.id, runtime)}
          />
        ) : (
          <WorkspaceRestoreFailure title={tab.title} />
        )
      },
      onClose: (_tab, context) => {
        const sourceId = context.runtime?.artifactSourceId
        if (typeof sourceId !== 'string') return
        return window.desktopApp.workspace.artifacts
          .release({ version: 1, sourceId })
          .then(() => undefined)
          .catch(() => undefined)
      }
    })
    .register({
      kind: 'terminal',
      render: (tab, context) => (
        <TerminalWorkspace
          tab={asTerminalTab(tab)}
          workspaceId={context.workspaceId}
          target={context.target}
          onTitleChange={(title) => context.setTabTitle(tab.id, title)}
          onOpenTerminal={() =>
            context.openTarget({ type: 'terminal' }, { panelId: context.panelId })
          }
        />
      ),
      onClose: (tab) => {
        const sessionId = terminalSessionIdFromTabId(tab.id)
        if (!sessionId) return
        return closeTerminalSession(sessionId)
      },
      onMove: (tab) => refitTerminalWorkspace(tab.id)
    })
    .register({
      kind: 'browser',
      render: (tab, context) => (
        <BrowserWorkspace
          tab={asBrowserTab(tab, context.runtime)}
          workspaceId={context.workspaceId}
          onRuntimeChange={(runtime) => context.setRuntime(tab.id, runtime)}
        />
      ),
      onActivate: (_tab, context) => showBrowserView(context.runtime?.browserViewId),
      onDeactivate: (_tab, context) => hideBrowserView(context.runtime?.browserViewId),
      onClose: (_tab, context) => {
        const viewId = context.runtime?.browserViewId
        if (typeof viewId !== 'string') return
        return window.desktopApp.workspace.browser
          .destroy({ version: 1, viewId })
          .then(() => undefined)
      },
      onMove: (tab, context) => {
        const viewId = context.runtime?.browserViewId
        return typeof viewId === 'string'
          ? repositionBrowserWorkspaceView(tab.id, viewId)
          : undefined
      }
    })
}

export function WorkspaceRestoreFailure({ title }: { title: string }): React.JSX.Element {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
      <p className="text-sm text-muted-foreground">无法恢复“{title}”工作区内容。</p>
      <p className="text-xs text-muted-foreground">可以关闭此标签后重新打开。</p>
    </div>
  )
}

function asFileTab(tab: WorkspaceTabRecord): Extract<RightWorkspaceTab, { type: 'file' }> {
  const line = positiveInteger(tab.props.line)
  const column = positiveInteger(tab.props.column)
  const endLine = positiveInteger(tab.props.endLine)
  return {
    id: tab.id,
    type: 'file',
    title: tab.title,
    relativePath: typeof tab.props.relativePath === 'string' ? tab.props.relativePath : '',
    revealPath: typeof tab.props.revealPath === 'string' ? tab.props.revealPath : undefined,
    location:
      line || column || endLine
        ? {
            ...(line ? { line } : {}),
            ...(column ? { column } : {}),
            ...(endLine ? { endLine } : {})
          }
        : undefined
  }
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined
}

function fileOpenOptions(
  tab: WorkspaceTabRecord,
  panelId: WorkspacePanelId,
  mode: WorkspaceOpenMode
): WorkspaceOpenOptions {
  if (typeof tab.props.relativePath === 'string' && tab.props.relativePath) {
    return { panelId, mode }
  }
  return { panelId, mode: 'pinned', replaceTabId: tab.id }
}

function asTerminalTab(tab: WorkspaceTabRecord): Extract<RightWorkspaceTab, { type: 'terminal' }> {
  return {
    id: tab.id,
    type: 'terminal',
    title: tab.title
  }
}

function asBrowserTab(
  tab: WorkspaceTabRecord,
  runtime: WorkspaceTabRuntime | undefined
): Extract<RightWorkspaceTab, { type: 'browser' }> {
  return {
    id: tab.id,
    type: 'browser',
    title: tab.title,
    initialUrl: typeof tab.props.url === 'string' ? tab.props.url : undefined,
    browserViewId: typeof runtime?.browserViewId === 'string' ? runtime.browserViewId : undefined
  }
}

function showBrowserView(viewId: unknown): Promise<void> | void {
  if (typeof viewId !== 'string') return
  return window.desktopApp.workspace.browser
    .show({ version: 1, viewId })
    .then(() => undefined)
    .catch(() => undefined)
}

function hideBrowserView(viewId: unknown): Promise<void> | void {
  if (typeof viewId !== 'string') return
  return window.desktopApp.workspace.browser
    .hide({ version: 1, viewId })
    .then(() => undefined)
    .catch(() => undefined)
}

export function reviewSource(tab: WorkspaceTabRecord): LocalGitReviewSource | undefined {
  return tab.kind === 'review' ? (tab.props.source as LocalGitReviewSource | undefined) : undefined
}
