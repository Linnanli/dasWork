/* eslint-disable react-refresh/only-export-components -- the context provider and hook form one state boundary. */
import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode
} from 'react'

import type { ArtifactAnnotation } from './annotations/artifactAnnotationTypes'
import type { ArtifactConversationReference } from './artifactConversationText'

type BridgeActions = {
  conversationId: string
  addToComposer(
    reference: ArtifactConversationReference,
    annotation?: ArtifactAnnotation
  ): Promise<void>
  directSubmit(
    reference: ArtifactConversationReference,
    annotation: ArtifactAnnotation
  ): Promise<void>
}

type ArtifactConversationBridgeValue = {
  available: boolean
  register(actions: BridgeActions): () => void
  addToComposer(
    reference: ArtifactConversationReference,
    annotation?: ArtifactAnnotation
  ): Promise<void>
  directSubmit(
    reference: ArtifactConversationReference,
    annotation: ArtifactAnnotation
  ): Promise<void>
}

const ArtifactConversationBridgeContext = createContext<ArtifactConversationBridgeValue | null>(
  null
)

export function ArtifactConversationBridgeProvider({
  children
}: {
  children: ReactNode
}): React.JSX.Element {
  const [actions, setActions] = useState<BridgeActions>()
  const submitted = useRef(new Set<string>())
  const register = useCallback((nextActions: BridgeActions): (() => void) => {
    setActions(nextActions)
    return () => setActions((current) => (current === nextActions ? undefined : current))
  }, [])
  const value = useMemo<ArtifactConversationBridgeValue>(
    () => ({
      available: Boolean(actions),
      register,
      addToComposer: async (reference, annotation) => {
        if (!actions) throw new Error('当前会话不可用，无法添加 Artifact。')
        await actions.addToComposer(reference, annotation)
      },
      directSubmit: async (reference, annotation) => {
        if (!actions) throw new Error('当前会话不可用，无法提交批注。')
        if (submitted.current.has(annotation.id)) return
        submitted.current.add(annotation.id)
        try {
          await actions.directSubmit(reference, annotation)
        } catch (error) {
          submitted.current.delete(annotation.id)
          throw error
        }
      }
    }),
    [actions, register]
  )
  return (
    <ArtifactConversationBridgeContext.Provider value={value}>
      {children}
    </ArtifactConversationBridgeContext.Provider>
  )
}

export function useArtifactConversationBridge(): ArtifactConversationBridgeValue {
  const context = useContext(ArtifactConversationBridgeContext)
  if (!context) throw new Error('Artifact conversation bridge is unavailable.')
  return context
}
