import type { CodexApprovalRequest } from '../../shared/codexIpcApi'

/**
 * Keeps task-owned UI events in the Electron window that started the task.
 * The app-server stays process-global; this routing table is deliberately
 * limited to the desktop presentation boundary.
 */
export class ConversationWindowRouter {
  private readonly ownerByConversationId = new Map<string, number>()
  private readonly ownerByThreadId = new Map<string, number>()
  private readonly ownerByApprovalId = new Map<string, number>()

  bindConversation(conversationId: string, webContentsId: number): void {
    this.ownerByConversationId.set(conversationId, webContentsId)
  }

  bindThread(threadId: string, webContentsId: number): void {
    this.ownerByThreadId.set(threadId, webContentsId)
  }

  ownerForConversation(conversationId: string): number | undefined {
    return (
      this.ownerByConversationId.get(conversationId) ?? this.ownerByThreadId.get(conversationId)
    )
  }

  claimThreadIfUnowned(threadId: string, webContentsId: number): void {
    if (this.ownerForThread(threadId) === undefined) this.bindThread(threadId, webContentsId)
  }

  bindApproval(request: CodexApprovalRequest): number | undefined {
    const owner = this.ownerForThread(request.context?.threadId ?? request.params.threadId)
    if (owner !== undefined) this.ownerByApprovalId.set(request.id, owner)
    return owner
  }

  ownsApproval(webContentsId: number, requestId: string): boolean {
    return this.ownerByApprovalId.get(requestId) === webContentsId
  }

  ownerForApproval(requestId: string): number | undefined {
    return this.ownerByApprovalId.get(requestId)
  }

  assignApproval(requestId: string, webContentsId: number): void {
    this.ownerByApprovalId.set(requestId, webContentsId)
  }

  releaseApproval(requestId: string): void {
    this.ownerByApprovalId.delete(requestId)
  }

  releaseWindow(webContentsId: number): void {
    removeOwnedEntries(this.ownerByConversationId, webContentsId)
    removeOwnedEntries(this.ownerByThreadId, webContentsId)
    removeOwnedEntries(this.ownerByApprovalId, webContentsId)
  }

  private ownerForThread(threadId: string | undefined): number | undefined {
    if (!threadId) return undefined
    return this.ownerByThreadId.get(threadId) ?? this.ownerByConversationId.get(threadId)
  }
}

function removeOwnedEntries(entries: Map<string, number>, webContentsId: number): void {
  for (const [key, owner] of entries) {
    if (owner === webContentsId) entries.delete(key)
  }
}
