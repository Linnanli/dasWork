import {
  WorkspaceTabStrip,
  type WorkspaceJsonValue,
  type WorkspaceOpenTarget,
  type WorkspaceTabRecord
} from '../workspace-container'
import { useRightWorkspace } from './RightWorkspaceProvider'
import type { RightWorkspaceTab } from './workspaceState'

type RightWorkspaceTabBarProps = {
  className?: string
  onTabClosed?(tab: RightWorkspaceTab): void
  onMenuVisibilityChange?(visible: boolean): void
}

/**
 * Compatibility adapter for the original right-workspace public surface.
 * The actual tab UI is placement-neutral and lives in WorkspaceTabStrip.
 */
export function RightWorkspaceTabBar({
  className,
  onTabClosed,
  onMenuVisibilityChange
}: RightWorkspaceTabBarProps): React.JSX.Element {
  const workspace = useRightWorkspace()
  const tabs = workspace.state.tabs.map(toDescriptor)

  return (
    <WorkspaceTabStrip
      panelId="right"
      className={className}
      tabs={tabs}
      activeTabId={workspace.activeTab?.id}
      onActivate={workspace.activateTab}
      onClose={(tabId) => {
        const tab = workspace.state.tabs.find((candidate) => candidate.id === tabId)
        if (tab) onTabClosed?.(tab)
        workspace.closeTab(tabId)
      }}
      onOpen={(target) => openTarget(workspace, target)}
      onMenuVisibilityChange={onMenuVisibilityChange}
    />
  )
}

function openTarget(
  workspace: ReturnType<typeof useRightWorkspace>,
  target: WorkspaceOpenTarget
): void {
  switch (target.type) {
    case 'review':
      workspace.openReview(target.source)
      return
    case 'file':
      workspace.openFile(target.relativePath, target.title)
      return
    case 'terminal':
    case 'browser':
    case 'pull-request':
    case 'task-summary':
    case 'timeline':
    case 'outputs':
    case 'sources':
    case 'processes':
      workspace.openTab(target.type)
  }
}

function toDescriptor(tab: RightWorkspaceTab): WorkspaceTabRecord {
  switch (tab.type) {
    case 'review':
      return {
        id: tab.id,
        kind: tab.type,
        title: tab.title,
        props: tab.source ? { source: tab.source as unknown as WorkspaceJsonValue } : {},
        isPreview: false,
        isClosable: true
      }
    case 'pull-request':
      return {
        id: tab.id,
        kind: tab.type,
        title: tab.title,
        props: {},
        isPreview: false,
        isClosable: true
      }
    case 'file':
      return {
        id: tab.id,
        kind: tab.type,
        title: tab.title,
        props: { relativePath: tab.relativePath },
        isPreview: false,
        isClosable: true
      }
    case 'terminal':
    case 'browser':
    case 'task-summary':
    case 'timeline':
    case 'outputs':
    case 'sources':
    case 'processes':
      return {
        id: tab.id,
        kind: tab.type,
        title: tab.title,
        props: {},
        isPreview: false,
        isClosable: true
      }
  }
}
