import { randomUUID } from 'node:crypto'

import {
  FOLLOW_UP_QUEUE_MAX_ITEMS_PER_CONVERSATION,
  FOLLOW_UP_QUEUE_STATE_VERSION,
  followUpEnqueuePayloadSchema,
  materializedMediaTypeForLocalAttachment,
  queuedUserMessageSnapshotInputSchema,
  type ConversationFollowUpState,
  type FollowUpEditableStatus,
  type FollowUpLocalImageInput,
  type FollowUpLocalAttachment,
  type FollowUpLocalAttachmentInput,
  type FollowUpMode,
  type FollowUpPauseKind,
  type FollowUpPersistedAsset,
  type FollowUpQueueChangeEvent,
  type FollowUpStatus,
  type MaterializedQueuedUserMessage,
  type PreparedFollowUpEdit,
  type QueuedFollowUpAttachment,
  type QueuedFollowUpItem,
  type QueuedUserMessageSnapshot,
  type QueuedUserMessageSnapshotInput
} from '../../shared/codexFollowUpApi'
import {
  type ConversationFollowUpQueueStoreState,
  type StoredConversationFollowUpQueue,
  ConversationFollowUpQueueStore
} from './ConversationFollowUpQueueStore'
import {
  FollowUpAssetStore,
  type FollowUpAssetToPersist,
  type PreparedFollowUpAssets
} from './FollowUpAssetStore'

export type FollowUpClaim = {
  conversationKey: string
  item: QueuedFollowUpItem
  leaseToken: string
}

export type FollowUpClaimFailure = {
  status?: 'queued' | 'paused-failed' | 'paused-recovery-uncertain'
  kind: Extract<
    FollowUpPauseKind,
    'send-failed' | 'steer-rejected' | 'turn-race' | 'attachment-unavailable' | 'recovery-uncertain'
  >
  userMessage: string
}

type FollowUpQueueLogger = (
  event: string,
  details: Record<string, string | number | boolean | undefined>
) => void

export type ConversationFollowUpQueueServiceOptions = {
  store: ConversationFollowUpQueueStore
  assetStore: FollowUpAssetStore
  now?: () => string
  createLeaseToken?: () => string
  logger?: FollowUpQueueLogger
  validateLocalAttachments?: (
    attachments: readonly (
      | FollowUpLocalAttachment
      | FollowUpLocalAttachmentInput
      | FollowUpLocalImageInput
    )[]
  ) => Promise<void>
  /**
   * Looks up the user-message identities that app-server has already stored
   * for a persisted thread. It runs only during startup recovery, before an
   * in-flight delivery is converted to an explicit uncertain state.
   */
  findAcceptedClientUserMessageIds?: (
    conversationKey: string,
    clientUserMessageIds: readonly string[]
  ) => Promise<readonly string[]>
}

export class ConversationFollowUpQueueService {
  private readonly listeners = new Set<(event: FollowUpQueueChangeEvent) => void>()
  private operationQueue = Promise.resolve()
  private readonly now: () => string
  private readonly createLeaseToken: () => string
  private initialization: Promise<void> | undefined

  constructor(private readonly options: ConversationFollowUpQueueServiceOptions) {
    this.now = options.now ?? (() => new Date().toISOString())
    this.createLeaseToken = options.createLeaseToken ?? randomUUID
  }

  subscribe(listener: (event: FollowUpQueueChangeEvent) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  async getState(conversationKey: string): Promise<ConversationFollowUpState> {
    return this.serialize(async () => {
      const state = await this.options.store.getState()
      return toConversationState(state, conversationKey)
    })
  }

  async enqueue(
    conversationKey: string,
    snapshot: QueuedUserMessageSnapshotInput,
    preferredMode: FollowUpMode
  ): Promise<ConversationFollowUpState> {
    const input = followUpEnqueuePayloadSchema.parse({
      conversationKey,
      snapshot,
      preferredMode
    })
    assertSnapshotRoutingMatchesQueue(conversationKey, input.snapshot)

    return this.serialize(async () => {
      const state = await this.options.store.getState()
      const queue = getOrCreateQueue(state, conversationKey)
      if (queue.items.length >= FOLLOW_UP_QUEUE_MAX_ITEMS_PER_CONVERSATION) {
        throw new Error(
          `A conversation may have at most ${FOLLOW_UP_QUEUE_MAX_ITEMS_PER_CONVERSATION} queued follow-ups.`
        )
      }
      if (queue.items.some((item) => item.id === input.snapshot.id)) {
        throw new Error(`Follow-up item already exists: ${input.snapshot.id}`)
      }

      const persisted = await this.persistSnapshot(conversationKey, input.snapshot)
      const timestamp = this.now()
      const item: QueuedFollowUpItem = {
        id: persisted.snapshot.id,
        conversationKey,
        createdAt: timestamp,
        updatedAt: timestamp,
        preferredMode,
        message: persisted.snapshot,
        status: queue.interrupted ? 'paused-interrupted' : 'queued',
        ...(queue.interrupted ? { pause: interruptedPause() } : {})
      }

      let result: ConversationFollowUpState
      try {
        await persisted.transaction.commit()
        queue.items.push(item)
        result = await this.commitState(state, conversationKey, 'enqueue', item)
      } catch (error) {
        await persisted.transaction
          .rollback()
          .catch((rollbackError) =>
            this.logCleanupFailure('enqueue-rollback', item.id, rollbackError)
          )
        throw error
      }
      await this.finalizeAssetsBestEffort(persisted.transaction, item.id, 'enqueue-finalize')
      return result
    })
  }

  async edit(
    conversationKey: string,
    itemId: string,
    replacementSnapshot: QueuedUserMessageSnapshotInput
  ): Promise<ConversationFollowUpState> {
    const snapshot = queuedUserMessageSnapshotInputSchema.parse(replacementSnapshot)
    if (snapshot.id !== itemId) {
      throw new Error('Editing a follow-up must preserve its stable message id.')
    }
    assertSnapshotRoutingMatchesQueue(conversationKey, snapshot)

    return this.serialize(async () => {
      const state = await this.options.store.getState()
      const queue = requireQueue(state, conversationKey)
      const item = requireItem(queue, itemId)
      assertMutable(item)
      if (item.status === 'editing') {
        throw new Error('Use commitEdit to update a follow-up that is being edited.')
      }
      const previousMessage = item.message
      const persisted = await this.persistSnapshot(conversationKey, snapshot, previousMessage)

      let result: ConversationFollowUpState
      try {
        await persisted.transaction.commit()
        item.message = persisted.snapshot
        item.updatedAt = this.now()
        item.status = queue.interrupted ? 'paused-interrupted' : 'queued'
        item.pause = queue.interrupted ? interruptedPause() : undefined
        item.lease = undefined
        result = await this.commitState(state, conversationKey, 'edit', item)
      } catch (error) {
        item.message = previousMessage
        await persisted.transaction
          .rollback()
          .catch((rollbackError) => this.logCleanupFailure('edit-rollback', item.id, rollbackError))
        throw error
      }
      await this.finalizeAssetsBestEffort(persisted.transaction, item.id, 'edit-finalize')
      await this.deleteSupersededAssetsBestEffort(
        previousMessage,
        persisted.snapshot,
        item.id,
        'edit-old-assets'
      )
      return result
    })
  }

  async beginEdit(conversationKey: string, itemId: string): Promise<PreparedFollowUpEdit> {
    return this.serialize(async () => {
      const state = await this.options.store.getState()
      const queue = requireQueue(state, conversationKey)
      const item = requireItem(queue, itemId)
      const existingEditingItem = queue.items.find(
        (candidate) => candidate.status === 'editing' && candidate.id !== itemId
      )
      if (existingEditingItem) {
        throw new Error('Finish or cancel the current follow-up edit before editing another item.')
      }
      if (item.status === 'editing' && item.edit) {
        await this.validateSnapshotAttachments(item.message)
        return {
          state: toConversationState(state, conversationKey),
          message: await this.materializeSnapshot(item.message)
        }
      }
      assertEditable(item)
      await this.validateSnapshotAttachments(item.message)
      const message = await this.materializeSnapshot(item.message)
      const previousStatus = item.status as FollowUpEditableStatus
      const previousPause = item.pause

      item.status = 'editing'
      item.pause = undefined
      item.lease = undefined
      item.edit = {
        previousStatus,
        previousPause,
        begunAt: this.now()
      }
      item.updatedAt = this.now()

      return {
        state: await this.commitState(state, conversationKey, 'edit-begun', item),
        message
      }
    })
  }

  async commitEdit(
    conversationKey: string,
    itemId: string,
    replacementSnapshot: QueuedUserMessageSnapshotInput
  ): Promise<ConversationFollowUpState> {
    const snapshot = queuedUserMessageSnapshotInputSchema.parse(replacementSnapshot)
    if (snapshot.id !== itemId) {
      throw new Error('Editing a follow-up must preserve its stable message id.')
    }
    assertSnapshotRoutingMatchesQueue(conversationKey, snapshot)

    return this.serialize(async () => {
      const state = await this.options.store.getState()
      const queue = requireQueue(state, conversationKey)
      const item = requireItem(queue, itemId)
      requireEditReservation(item)
      const previousMessage = item.message
      const persisted = await this.persistSnapshot(conversationKey, snapshot, previousMessage)

      let result: ConversationFollowUpState
      try {
        await persisted.transaction.commit()
        item.message = persisted.snapshot
        item.updatedAt = this.now()
        item.status = queue.interrupted ? 'paused-interrupted' : 'queued'
        item.pause = queue.interrupted ? interruptedPause() : undefined
        item.edit = undefined
        item.lease = undefined
        result = await this.commitState(state, conversationKey, 'edit-committed', item)
      } catch (error) {
        item.message = previousMessage
        await persisted.transaction
          .rollback()
          .catch((rollbackError) =>
            this.logCleanupFailure('commit-edit-rollback', item.id, rollbackError)
          )
        throw error
      }
      await this.finalizeAssetsBestEffort(persisted.transaction, item.id, 'commit-edit-finalize')
      await this.deleteSupersededAssetsBestEffort(
        previousMessage,
        persisted.snapshot,
        item.id,
        'commit-edit-old-assets'
      )
      return result
    })
  }

  async cancelEdit(conversationKey: string, itemId: string): Promise<ConversationFollowUpState> {
    return this.serialize(async () => {
      const state = await this.options.store.getState()
      const queue = requireQueue(state, conversationKey)
      const item = requireItem(queue, itemId)
      const edit = requireEditReservation(item)

      item.status = edit.previousStatus
      item.pause = edit.previousPause
      item.edit = undefined
      item.lease = undefined
      item.updatedAt = this.now()
      return this.commitState(state, conversationKey, 'edit-cancelled', item)
    })
  }

  async delete(conversationKey: string, itemId: string): Promise<ConversationFollowUpState> {
    return this.serialize(async () => {
      const state = await this.options.store.getState()
      const queue = requireQueue(state, conversationKey)
      const index = requireItemIndex(queue, itemId)
      assertMutable(queue.items[index])
      const [removed] = queue.items.splice(index, 1)
      const result = await this.commitState(state, conversationKey, 'delete', removed)
      await this.deleteSnapshotAssetsBestEffort(removed.message, itemId, 'delete-assets')
      return result
    })
  }

  async reorder(
    conversationKey: string,
    itemId: string,
    position: { beforeId: string } | { afterId: string }
  ): Promise<ConversationFollowUpState> {
    return this.serialize(async () => {
      const state = await this.options.store.getState()
      const queue = requireQueue(state, conversationKey)
      const itemIndex = requireItemIndex(queue, itemId)
      assertNoDeliveryInFlight(queue)
      const targetId = 'beforeId' in position ? position.beforeId : position.afterId
      if (targetId === itemId) return toConversationState(state, conversationKey)
      const item = queue.items[itemIndex]
      const target = requireItem(queue, targetId)
      if (item.status === 'editing' || target.status === 'editing') {
        throw new Error('A follow-up being edited cannot be reordered.')
      }
      assertReorderDoesNotMoveBlockedHead(queue, itemId, position)

      queue.items.splice(itemIndex, 1)
      const targetIndex = requireItemIndex(queue, targetId)
      const insertionIndex = 'beforeId' in position ? targetIndex : targetIndex + 1
      queue.items.splice(insertionIndex, 0, item)
      item.updatedAt = this.now()
      return this.commitState(state, conversationKey, 'reorder', item)
    })
  }

  async requestSendNow(
    conversationKey: string,
    itemId: string
  ): Promise<ConversationFollowUpState> {
    return this.serialize(async () => {
      const state = await this.options.store.getState()
      const queue = requireQueue(state, conversationKey)
      assertNoDeliveryInFlight(queue)
      const index = requireItemIndex(queue, itemId)
      if (queue.items[index].status === 'editing') {
        throw new Error('A follow-up being edited cannot be sent.')
      }
      const head = queue.items[0]
      if (head && isBlockingStatus(head.status) && head.id !== itemId) {
        throw new Error('A paused queue item must be resolved before later items can be sent.')
      }
      const [item] = queue.items.splice(index, 1)
      queue.items.unshift(item)
      item.updatedAt = this.now()
      return this.commitState(state, conversationKey, 'send-now-requested', item)
    })
  }

  async retry(conversationKey: string, itemId: string): Promise<ConversationFollowUpState> {
    return this.serialize(async () => {
      const state = await this.options.store.getState()
      const queue = requireQueue(state, conversationKey)
      const item = requireItem(queue, itemId)
      if (item.status !== 'paused-failed' && item.status !== 'paused-recovery-uncertain') {
        throw new Error('Only a failed or recovery-uncertain queue item can be retried.')
      }
      item.status = 'queued'
      item.pause = undefined
      item.lease = undefined
      item.updatedAt = this.now()
      return this.commitState(state, conversationKey, 'retry', item)
    })
  }

  async resume(conversationKey: string): Promise<ConversationFollowUpState> {
    return this.serialize(async () => {
      const state = await this.options.store.getState()
      const queue = requireQueue(state, conversationKey)
      let changed = Boolean(queue.interrupted)
      queue.interrupted = false
      for (const item of queue.items) {
        if (item.status !== 'paused-interrupted') continue
        item.status = 'queued'
        item.pause = undefined
        item.lease = undefined
        item.updatedAt = this.now()
        changed = true
      }
      return changed
        ? this.commitState(state, conversationKey, 'resume')
        : toConversationState(state, conversationKey)
    })
  }

  async clear(conversationKey: string): Promise<ConversationFollowUpState> {
    return this.serialize(async () => {
      const state = await this.options.store.getState()
      const queue = requireQueue(state, conversationKey)
      if (queue.items.some((item) => item.status === 'sending' || item.status === 'steering')) {
        throw new Error('Cannot clear a queue while a delivery is being confirmed.')
      }
      const removedItems = queue.items
      queue.items = []
      queue.interrupted = false
      const result = await this.commitState(state, conversationKey, 'clear')
      await Promise.all(
        removedItems.map((item) =>
          this.deleteSnapshotAssetsBestEffort(item.message, item.id, 'clear-assets')
        )
      )
      return result
    })
  }

  async deleteConversation(conversationKey: string): Promise<void> {
    await this.serialize(async () => {
      const state = await this.options.store.getState()
      const queue = state.conversations[conversationKey]
      if (!queue) return
      assertConversationCanBeDeleted(queue)

      const removedItems = queue.items
      delete state.conversations[conversationKey]
      state.revision += 1
      await this.options.store.setState(state)
      this.options.logger?.('delete-conversation', {
        conversationKey,
        revision: state.revision
      })
      this.broadcast(toConversationState(state, conversationKey))
      await Promise.all(
        removedItems.map((item) =>
          this.deleteSnapshotAssetsBestEffort(item.message, item.id, 'delete-conversation-assets')
        )
      )
    })
  }

  async assertConversationCanBeDeleted(conversationKey: string): Promise<void> {
    await this.serialize(async () => {
      const state = await this.options.store.getState()
      const queue = state.conversations[conversationKey]
      if (queue) assertConversationCanBeDeleted(queue)
    })
  }

  async setDefaultMode(mode: FollowUpMode): Promise<void> {
    return this.serialize(async () => {
      const state = await this.options.store.getState()
      if (state.defaultMode === mode) return
      state.defaultMode = mode
      state.revision += 1
      await this.options.store.setState(state)
      for (const conversationKey of Object.keys(state.conversations)) {
        this.broadcast(toConversationState(state, conversationKey))
      }
    })
  }

  async setArchived(
    conversationKey: string,
    archived: boolean
  ): Promise<ConversationFollowUpState> {
    return this.serialize(async () => {
      const state = await this.options.store.getState()
      const queue = getOrCreateQueue(state, conversationKey)
      if (queue.archived === archived) return toConversationState(state, conversationKey)
      queue.archived = archived
      return this.commitState(state, conversationKey, archived ? 'archive' : 'unarchive')
    })
  }

  async migrateConversationKey(
    sourceConversationKey: string,
    targetConversationKey: string
  ): Promise<ConversationFollowUpState> {
    if (sourceConversationKey === targetConversationKey) {
      return this.getState(targetConversationKey)
    }

    return this.serialize(async () => {
      const state = await this.options.store.getState()
      const source = state.conversations[sourceConversationKey]
      if (!source) return toConversationState(state, targetConversationKey)
      const target = getOrCreateQueue(state, targetConversationKey)
      const existingIds = new Set(target.items.map((item) => item.id))
      const discardedItems: QueuedFollowUpItem[] = []

      for (const item of source.items) {
        if (existingIds.has(item.id)) {
          discardedItems.push(item)
          continue
        }
        target.items.push({
          ...item,
          conversationKey: targetConversationKey,
          updatedAt: this.now(),
          message: {
            ...item.message,
            trustedContext: {
              ...item.message.trustedContext,
              threadId: targetConversationKey
            }
          }
        })
        existingIds.add(item.id)
      }
      target.archived = target.archived || source.archived
      target.interrupted = Boolean(target.interrupted || source.interrupted)
      delete state.conversations[sourceConversationKey]
      const result = await this.commitState(state, targetConversationKey, 'migrate')
      await Promise.all(
        discardedItems.map((item) =>
          this.deleteSnapshotAssetsBestEffort(item.message, item.id, 'migrate-duplicate-assets')
        )
      )
      return result
    })
  }

  async claimHead(
    conversationKey: string,
    operation: 'turn-start' | 'turn-steer',
    expectedItemId?: string,
    owner = 'main'
  ): Promise<FollowUpClaim> {
    return this.serialize(async () => {
      const state = await this.options.store.getState()
      const queue = requireQueue(state, conversationKey)
      if (queue.archived) {
        throw new Error('Archived conversations cannot automatically send queued follow-ups.')
      }
      assertNoDeliveryInFlight(queue)
      const item = requireHead(queue, expectedItemId)
      if (item.status !== 'queued') {
        throw new Error(`Queue head is not claimable while it is ${item.status}.`)
      }

      await this.validateSnapshotAttachments(item.message)
      const token = this.createLeaseToken()
      item.status = operation === 'turn-start' ? 'sending' : 'steering'
      item.pause = undefined
      item.lease = { token, operation, claimedAt: this.now(), owner }
      item.updatedAt = this.now()
      await this.commitState(state, conversationKey, 'claim', item)
      return {
        conversationKey,
        item: cloneItem(item),
        leaseToken: token
      }
    })
  }

  async claimItemForSteer(
    conversationKey: string,
    itemId: string,
    owner = 'main'
  ): Promise<FollowUpClaim> {
    return this.serialize(async () => {
      const state = await this.options.store.getState()
      const queue = requireQueue(state, conversationKey)
      if (queue.archived) {
        throw new Error('Archived conversations cannot steer queued follow-ups.')
      }
      assertNoDeliveryInFlight(queue)
      assertOnlyQueuedItemsBefore(queue, itemId)
      const item = requireItem(queue, itemId)
      if (item.status !== 'queued') {
        throw new Error(`Queue item is not steerable while it is ${item.status}.`)
      }

      await this.validateSnapshotAttachments(item.message)
      const token = this.createLeaseToken()
      item.status = 'steering'
      item.pause = undefined
      item.lease = {
        token,
        operation: 'turn-steer',
        claimedAt: this.now(),
        owner
      }
      item.updatedAt = this.now()
      await this.commitState(state, conversationKey, 'steer-item-claimed', item)
      return {
        conversationKey,
        item: cloneItem(item),
        leaseToken: token
      }
    })
  }

  async commitClaim(
    conversationKey: string,
    itemId: string,
    leaseToken: string
  ): Promise<ConversationFollowUpState> {
    return this.serialize(async () => {
      const state = await this.options.store.getState()
      const queue = requireQueue(state, conversationKey)
      const index = requireItemIndex(queue, itemId)
      const item = queue.items[index]
      requireLease(item, leaseToken)
      queue.items.splice(index, 1)
      const result = await this.commitState(state, conversationKey, 'claim-accepted', item)
      await this.deleteSnapshotAssetsBestEffort(item.message, itemId, 'accepted-assets')
      return result
    })
  }

  /**
   * Records that app-server accepted the follow-up before best-effort queue
   * cleanup removes it. This closes the crash window between canonical
   * acceptance and `commitClaim`.
   */
  async acknowledgeClaim(
    conversationKey: string,
    itemId: string,
    leaseToken: string
  ): Promise<ConversationFollowUpState> {
    return this.serialize(async () => {
      const state = await this.options.store.getState()
      const queue = requireQueue(state, conversationKey)
      const item = requireItem(queue, itemId)
      requireLease(item, leaseToken)
      item.status = 'accepted'
      item.pause = undefined
      item.updatedAt = this.now()
      return this.commitState(state, conversationKey, 'claim-acknowledged', item)
    })
  }

  async materializeClaimMessage(claim: FollowUpClaim): Promise<MaterializedQueuedUserMessage> {
    return this.serialize(async () => {
      const state = await this.options.store.getState()
      const queue = requireQueue(state, claim.conversationKey)
      const item = requireItem(queue, claim.item.id)
      requireLease(item, claim.leaseToken)
      return this.materializeSnapshot(
        item.message,
        followUpHistoryOwnerKey(claim.conversationKey, item.id)
      )
    })
  }

  async materializeQueuedMessage(
    conversationKey: string,
    expectedItemId?: string
  ): Promise<MaterializedQueuedUserMessage> {
    return this.serialize(async () => {
      const state = await this.options.store.getState()
      const queue = requireQueue(state, conversationKey)
      const item = requireHead(queue, expectedItemId)
      if (item.status !== 'queued') {
        throw new Error(`Queue head cannot be prepared while it is ${item.status}.`)
      }
      try {
        await this.validateSnapshotAttachments(item.message)
        return await this.materializeSnapshot(item.message)
      } catch (error) {
        item.status = 'paused-failed'
        item.updatedAt = this.now()
        item.pause = {
          kind: 'attachment-unavailable',
          userMessage: followUpUserMessage(error)
        }
        await this.commitState(state, conversationKey, 'prepare-failed', item)
        throw error
      }
    })
  }

  async materializeItem(
    conversationKey: string,
    itemId: string
  ): Promise<MaterializedQueuedUserMessage> {
    return this.serialize(async () => {
      const state = await this.options.store.getState()
      const queue = requireQueue(state, conversationKey)
      const item = requireItem(queue, itemId)
      if (item.status !== 'queued') {
        throw new Error(`Queue item cannot be materialized while it is ${item.status}.`)
      }
      await this.validateSnapshotAttachments(item.message)
      return this.materializeSnapshot(item.message)
    })
  }

  private async materializeSnapshot(
    snapshot: QueuedUserMessageSnapshot,
    historyOwnerKey?: string
  ): Promise<MaterializedQueuedUserMessage> {
    const persistedAssets = snapshot.attachments.filter(
      (attachment): attachment is FollowUpPersistedAsset => attachment.kind === 'persisted-asset'
    )
    const materializedAssets = historyOwnerKey
      ? await this.options.assetStore.materializeForHistory(historyOwnerKey, persistedAssets)
      : await this.options.assetStore.materialize(persistedAssets)
    if (this.options.validateLocalAttachments) {
      const localAttachments = snapshot.attachments.filter(
        (
          attachment
        ): attachment is Extract<QueuedFollowUpAttachment, { kind: 'file' | 'folder' }> =>
          attachment.kind === 'file' || attachment.kind === 'folder'
      )
      await this.options.validateLocalAttachments(localAttachments)
    }

    return {
      id: snapshot.id,
      parts: [
        { type: 'text', text: snapshot.text },
        ...snapshot.attachments.flatMap((attachment) => {
          if (attachment.kind === 'persisted-asset') {
            const asset = materializedAssets.find((candidate) => candidate.id === attachment.id)
            if (!asset) {
              throw new Error(`Queued attachment could not be materialized: ${attachment.id}`)
            }
            return [
              {
                type: 'file' as const,
                filename: asset.displayName,
                mediaType: asset.mediaType,
                url: 'fileUrl' in asset ? asset.fileUrl : asset.dataUrl
              }
            ]
          }
          return [
            {
              type: 'file' as const,
              filename: attachment.label,
              mediaType: materializedMediaTypeForLocalAttachment(attachment.kind),
              url: attachment.fileUrl
            }
          ]
        })
      ],
      contextReferences: snapshot.contextReferences,
      trustedContext: snapshot.trustedContext
    }
  }

  async failClaim(
    conversationKey: string,
    itemId: string,
    leaseToken: string,
    failure: FollowUpClaimFailure
  ): Promise<ConversationFollowUpState> {
    return this.serialize(async () => {
      const state = await this.options.store.getState()
      const queue = requireQueue(state, conversationKey)
      const item = requireItem(queue, itemId)
      requireLease(item, leaseToken)
      const requestedStatus = failure.status ?? 'paused-failed'
      item.status =
        queue.interrupted && requestedStatus !== 'paused-recovery-uncertain'
          ? 'paused-interrupted'
          : requestedStatus
      item.lease = undefined
      item.updatedAt = this.now()
      item.pause =
        item.status === 'paused-interrupted'
          ? interruptedPause()
          : item.status === 'queued'
            ? undefined
            : { kind: failure.kind, userMessage: followUpUserMessage(failure.userMessage) }
      return this.commitState(state, conversationKey, 'claim-failed', item)
    })
  }

  async interrupt(conversationKey: string): Promise<ConversationFollowUpState> {
    return this.serialize(async () => {
      const state = await this.options.store.getState()
      const queue = state.conversations[conversationKey]
      if (!queue) return toConversationState(state, conversationKey)
      if (queue.items.length === 0) {
        return toConversationState(state, conversationKey)
      }
      let changed = !queue.interrupted
      queue.interrupted = true
      for (const item of queue.items) {
        if (item.status === 'editing' && item.edit) {
          item.edit = {
            previousStatus: 'paused-interrupted',
            previousPause: interruptedPause(),
            begunAt: item.edit.begunAt
          }
          item.updatedAt = this.now()
          changed = true
          continue
        }
        if (item.status !== 'queued') continue
        item.status = 'paused-interrupted'
        item.lease = undefined
        item.updatedAt = this.now()
        item.pause = interruptedPause()
        changed = true
      }
      return changed
        ? this.commitState(state, conversationKey, 'interrupt', queue.items[0])
        : toConversationState(state, conversationKey)
    })
  }

  private async persistSnapshot(
    conversationKey: string,
    snapshot: QueuedUserMessageSnapshotInput,
    previousSnapshot?: QueuedUserMessageSnapshot
  ): Promise<{
    snapshot: QueuedUserMessageSnapshot
    transaction: Awaited<ReturnType<FollowUpAssetStore['prepare']>>
  }> {
    const assets: FollowUpAssetToPersist[] = []
    for (const attachment of snapshot.attachments) {
      if (attachment.kind === 'inline-asset') {
        assets.push({
          id: attachment.id,
          displayName: attachment.displayName,
          mediaType: attachment.mediaType,
          encoding: attachment.encoding,
          data: attachment.data
        })
      } else if (attachment.kind === 'persisted-asset') {
        assets.push(attachment)
      } else if (attachment.kind === 'local-image') {
        assets.push(attachment)
      }
    }
    const localInputs = snapshot.attachments.filter(
      (attachment): attachment is FollowUpLocalAttachmentInput | FollowUpLocalImageInput =>
        attachment.kind === 'file' ||
        attachment.kind === 'folder' ||
        attachment.kind === 'local-image'
    )
    if (this.options.validateLocalAttachments) {
      await this.options.validateLocalAttachments(localInputs)
    }
    const allowedExistingRelativePaths = persistedAssetsFromSnapshot(previousSnapshot).map(
      (asset) => asset.relativePath
    )
    const transaction = await this.options.assetStore.prepare(
      followUpQueueAssetOwnerKey(conversationKey, snapshot.id),
      assets,
      { allowedExistingRelativePaths }
    )
    const localAttachments = snapshot.attachments.filter(
      (attachment): attachment is Extract<QueuedFollowUpAttachment, { kind: 'file' | 'folder' }> =>
        attachment.kind === 'file' || attachment.kind === 'folder'
    )

    return {
      transaction,
      snapshot: {
        ...snapshot,
        attachments: [...localAttachments, ...transaction.assets]
      }
    }
  }

  private async validateSnapshotAttachments(snapshot: QueuedUserMessageSnapshot): Promise<void> {
    const persistedAssets = snapshot.attachments.filter(
      (attachment): attachment is FollowUpPersistedAsset => attachment.kind === 'persisted-asset'
    )
    await this.options.assetStore.validate(persistedAssets)
    if (this.options.validateLocalAttachments) {
      const localAttachments = snapshot.attachments.filter(
        (
          attachment
        ): attachment is Extract<QueuedFollowUpAttachment, { kind: 'file' | 'folder' }> =>
          attachment.kind === 'file' || attachment.kind === 'folder'
      )
      await this.options.validateLocalAttachments(localAttachments)
    }
  }

  private async deleteSnapshotAssetsBestEffort(
    snapshot: QueuedUserMessageSnapshot,
    itemId: string,
    event: string
  ): Promise<void> {
    const assets = persistedAssetsFromSnapshot(snapshot)
    if (assets.length === 0) return
    await this.options.assetStore
      .deleteAssets(assets)
      .catch((error) => this.logCleanupFailure(event, itemId, error))
  }

  private async deleteSupersededAssetsBestEffort(
    previousSnapshot: QueuedUserMessageSnapshot,
    currentSnapshot: QueuedUserMessageSnapshot,
    itemId: string,
    event: string
  ): Promise<void> {
    const currentPaths = new Set(
      persistedAssetsFromSnapshot(currentSnapshot).map((asset) => asset.relativePath)
    )
    const supersededAssets = persistedAssetsFromSnapshot(previousSnapshot).filter(
      (asset) => !currentPaths.has(asset.relativePath)
    )
    if (supersededAssets.length === 0) return
    await this.options.assetStore
      .deleteAssets(supersededAssets)
      .catch((error) => this.logCleanupFailure(event, itemId, error))
  }

  private async finalizeAssetsBestEffort(
    transaction: PreparedFollowUpAssets,
    itemId: string,
    event: string
  ): Promise<void> {
    await transaction.finalize().catch((error) => this.logCleanupFailure(event, itemId, error))
  }

  private logCleanupFailure(event: string, itemId: string, error: unknown): void {
    this.options.logger?.(event, {
      itemId,
      error: error instanceof Error ? error.message : String(error)
    })
  }

  private async commitState(
    state: ConversationFollowUpQueueStoreState,
    conversationKey: string,
    event: string,
    item?: QueuedFollowUpItem
  ): Promise<ConversationFollowUpState> {
    state.revision += 1
    await this.options.store.setState(state)
    const conversationState = toConversationState(state, conversationKey)
    this.options.logger?.(event, {
      conversationKey,
      itemId: item?.id,
      status: item?.status,
      revision: state.revision
    })
    this.broadcast(conversationState)
    return conversationState
  }

  private broadcast(state: ConversationFollowUpState): void {
    const event = { revision: state.revision, state }
    for (const listener of this.listeners) {
      listener(event)
    }
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const run = async (): Promise<T> => {
      await this.ensureInitialized()
      return operation()
    }
    const queued = this.operationQueue.then(run, run)
    this.operationQueue = queued.then(
      () => undefined,
      () => undefined
    )
    return queued
  }

  private ensureInitialized(): Promise<void> {
    return (this.initialization ??= this.reconcilePersistedAssets())
  }

  private async reconcilePersistedAssets(): Promise<void> {
    const state = await this.options.store.getState()
    const discardedItems = await this.reconcileInterruptedDeliveries(state)
    const relativePaths = Object.values(state.conversations).flatMap((queue) =>
      queue.items.flatMap((item) =>
        item.message.attachments.flatMap((attachment) =>
          attachment.kind === 'persisted-asset' ? [attachment.relativePath] : []
        )
      )
    )
    await this.options.assetStore.reconcileReferencedAssets(relativePaths)
    await Promise.all(
      discardedItems.map((item) =>
        this.deleteSnapshotAssetsBestEffort(
          item.message,
          item.id,
          'recovery-accepted-delivery-assets'
        )
      )
    )
  }

  private async reconcileInterruptedDeliveries(
    state: ConversationFollowUpQueueStoreState
  ): Promise<QueuedFollowUpItem[]> {
    const discardedItems: QueuedFollowUpItem[] = []
    let changed = false
    for (const queue of Object.values(state.conversations)) {
      const acceptedItems = queue.items.filter((item) => item.status === 'accepted')
      if (acceptedItems.length === 0) continue
      changed = true
      discardedItems.push(...acceptedItems)
      queue.items = queue.items.filter((item) => item.status !== 'accepted')
    }

    const inFlightByConversation = new Map<string, QueuedFollowUpItem[]>()
    for (const [conversationKey, queue] of Object.entries(state.conversations)) {
      const inFlight = queue.items.filter(
        (item) => item.status === 'sending' || item.status === 'steering'
      )
      if (inFlight.length > 0) inFlightByConversation.set(conversationKey, inFlight)
    }
    if (inFlightByConversation.size === 0) {
      if (changed) {
        state.revision += 1
        await this.options.store.setState(state)
      }
      return discardedItems
    }

    const acceptedByConversation = new Map<string, Set<string>>()
    for (const [conversationKey, items] of inFlightByConversation) {
      const candidateIds = items.map((item) => item.id)
      let acceptedIds: readonly string[] = []
      try {
        acceptedIds =
          (await this.options.findAcceptedClientUserMessageIds?.(conversationKey, candidateIds)) ??
          []
      } catch (error) {
        this.options.logger?.('recovery-history-read-failed', {
          conversationKey,
          candidateCount: items.length,
          errorKind: error instanceof Error ? error.name : 'unknown'
        })
      }
      const candidates = new Set(candidateIds)
      acceptedByConversation.set(
        conversationKey,
        new Set(acceptedIds.filter((id) => candidates.has(id)))
      )
    }

    for (const [conversationKey, queue] of Object.entries(state.conversations)) {
      const acceptedIds = acceptedByConversation.get(conversationKey)
      if (!acceptedIds) continue
      queue.items = queue.items.flatMap((item) => {
        if (item.status !== 'sending' && item.status !== 'steering') return [item]
        changed = true
        if (acceptedIds.has(item.id)) {
          discardedItems.push(item)
          return []
        }
        return [
          {
            ...item,
            status: 'paused-recovery-uncertain',
            updatedAt: this.now(),
            pause: {
              kind: 'recovery-uncertain',
              userMessage:
                'The app closed before delivery could be confirmed. Retry or delete this item.'
            },
            lease: undefined
          }
        ]
      })
    }
    if (!changed) return discardedItems

    state.revision += 1
    await this.options.store.setState(state)
    return discardedItems
  }
}

function getOrCreateQueue(
  state: ConversationFollowUpQueueStoreState,
  conversationKey: string
): StoredConversationFollowUpQueue {
  return (state.conversations[conversationKey] ??= {
    archived: false,
    interrupted: false,
    items: []
  })
}

function requireQueue(
  state: ConversationFollowUpQueueStoreState,
  conversationKey: string
): StoredConversationFollowUpQueue {
  const queue = state.conversations[conversationKey]
  if (!queue) throw new Error(`Follow-up queue not found: ${conversationKey}`)
  return queue
}

function requireItem(queue: StoredConversationFollowUpQueue, itemId: string): QueuedFollowUpItem {
  return queue.items[requireItemIndex(queue, itemId)]
}

function requireItemIndex(queue: StoredConversationFollowUpQueue, itemId: string): number {
  const index = queue.items.findIndex((item) => item.id === itemId)
  if (index < 0) throw new Error(`Follow-up item not found: ${itemId}`)
  return index
}

function requireHead(
  queue: StoredConversationFollowUpQueue,
  expectedItemId?: string
): QueuedFollowUpItem {
  const item = queue.items[0]
  if (!item) throw new Error('Follow-up queue is empty.')
  if (expectedItemId && item.id !== expectedItemId) {
    throw new Error(`Only the queue head can be sent; expected ${item.id}.`)
  }
  return item
}

function requireLease(item: QueuedFollowUpItem, leaseToken: string): void {
  if (!item.lease || item.lease.token !== leaseToken) {
    throw new Error('Follow-up delivery lease is missing or stale.')
  }
}

function assertMutable(item: QueuedFollowUpItem): void {
  if (item.status === 'sending' || item.status === 'steering') {
    throw new Error('Cannot change a follow-up while delivery is being confirmed.')
  }
}

function assertEditable(item: QueuedFollowUpItem): void {
  if (
    item.status !== 'queued' &&
    item.status !== 'paused-interrupted' &&
    item.status !== 'paused-failed' &&
    item.status !== 'paused-recovery-uncertain'
  ) {
    throw new Error(`Cannot edit a follow-up while it is ${item.status}.`)
  }
}

function requireEditReservation(item: QueuedFollowUpItem): NonNullable<QueuedFollowUpItem['edit']> {
  if (item.status !== 'editing' || !item.edit) {
    throw new Error('Follow-up item is not being edited.')
  }
  return item.edit
}

function assertReorderDoesNotMoveBlockedHead(
  queue: StoredConversationFollowUpQueue,
  itemId: string,
  position: { beforeId: string } | { afterId: string }
): void {
  const head = queue.items[0]
  if (!head || !isBlockingStatus(head.status)) return
  if (head.id === itemId || ('beforeId' in position && position.beforeId === head.id)) {
    throw new Error('The paused queue head must remain in place until it is resolved.')
  }
}

function assertNoDeliveryInFlight(queue: StoredConversationFollowUpQueue): void {
  if (queue.items.some((item) => item.status === 'sending' || item.status === 'steering')) {
    throw new Error('Cannot change queue order while a delivery is being confirmed.')
  }
}

function assertOnlyQueuedItemsBefore(queue: StoredConversationFollowUpQueue, itemId: string): void {
  const itemIndex = requireItemIndex(queue, itemId)
  if (queue.items.slice(0, itemIndex).some((item) => item.status !== 'queued')) {
    throw new Error('Resolve paused or failed queue items before steering a later message.')
  }
}

function assertSnapshotRoutingMatchesQueue(
  conversationKey: string,
  snapshot: QueuedUserMessageSnapshotInput
): void {
  const snapshotKey = snapshot.trustedContext.threadId ?? snapshot.trustedContext.conversationId
  if (snapshotKey !== conversationKey) {
    throw new Error('Follow-up snapshot does not belong to the target conversation.')
  }
}

function isBlockingStatus(status: FollowUpStatus): boolean {
  return (
    status === 'paused-failed' ||
    status === 'paused-interrupted' ||
    status === 'paused-recovery-uncertain'
  )
}

function interruptedPause(): QueuedFollowUpItem['pause'] {
  return {
    kind: 'interrupted',
    userMessage: 'The follow-up queue is paused because the running task was interrupted.'
  }
}

function persistedAssetsFromSnapshot(
  snapshot: QueuedUserMessageSnapshot | undefined
): FollowUpPersistedAsset[] {
  return (
    snapshot?.attachments.filter(
      (attachment): attachment is FollowUpPersistedAsset => attachment.kind === 'persisted-asset'
    ) ?? []
  )
}

function followUpQueueAssetOwnerKey(conversationKey: string, itemId: string): string {
  return JSON.stringify(['queue', conversationKey, itemId])
}

function followUpHistoryOwnerKey(conversationKey: string, itemId: string): string {
  return JSON.stringify(['history', conversationKey, itemId])
}

function followUpUserMessage(error: unknown): string {
  const message = (error instanceof Error ? error.message : String(error)).trim()
  if (!message) return 'The follow-up operation failed.'
  if (message.length <= 2_000) return message
  return `${message.slice(0, 1_999)}…`
}

function assertConversationCanBeDeleted(queue: StoredConversationFollowUpQueue): void {
  if (queue.items.some((item) => item.status === 'sending' || item.status === 'steering')) {
    throw new Error('Cannot delete a task while a delivery is being confirmed.')
  }
}

function toConversationState(
  state: ConversationFollowUpQueueStoreState,
  conversationKey: string
): ConversationFollowUpState {
  const queue = state.conversations[conversationKey] ?? {
    archived: false,
    interrupted: false,
    items: []
  }
  return {
    version: FOLLOW_UP_QUEUE_STATE_VERSION,
    revision: state.revision,
    conversationKey,
    defaultMode: state.defaultMode,
    archived: queue.archived,
    items: queue.items.map(cloneItem)
  }
}

function cloneItem(item: QueuedFollowUpItem): QueuedFollowUpItem {
  return JSON.parse(JSON.stringify(item)) as QueuedFollowUpItem
}
