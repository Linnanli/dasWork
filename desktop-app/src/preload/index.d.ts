import type {
  DesktopCodexApi,
  DesktopCodexChatApi,
  DesktopCodexFollowUpApi,
  DesktopComposerContextApi,
  DesktopConversationsApi,
  DesktopGitApi,
  DesktopProjectsApi
} from '../shared/codexIpcApi'
import type { DesktopRightWorkspaceApi } from '../shared/rightWorkspaceApi'
import type { DesktopNativeContextMenuApi } from '../shared/nativeContextMenuApi'
import type { DesktopPluginCenterApi } from '../shared/pluginCenterApi'

export type DesktopAppApi = {
  environment: {
    platform: NodeJS.Platform
  }
  codex: DesktopCodexApi
  chat: DesktopCodexChatApi
  composerContext: DesktopComposerContextApi
  plugins: DesktopPluginCenterApi
  projects: DesktopProjectsApi
  conversations: DesktopConversationsApi
  followUps: DesktopCodexFollowUpApi
  git: DesktopGitApi
  nativeContextMenu: DesktopNativeContextMenuApi
  workspace: DesktopRightWorkspaceApi
}

declare global {
  interface Window {
    desktopApp: DesktopAppApi
  }
}
