import {
  BotIcon,
  BoxesIcon,
  LinkIcon,
  MessageSquareIcon,
  PackageIcon,
  PanelsTopLeftIcon,
  PuzzleIcon,
  SparklesIcon
} from 'lucide-react'
import {
  createContext,
  isValidElement,
  useContext,
  type ComponentProps,
  type ReactNode
} from 'react'

import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { inlineCodeReference } from '@/lib/referenceInlineCode'
import {
  classifyReferenceTarget,
  isAbsoluteLocalPath,
  isSafeRelativeReferencePath,
  type InlineReferenceDescriptor
} from '@/lib/referenceInlineTarget'
import { cn } from '@/lib/utils'
import { ResourceFileIcon } from './resourceFileIcon'

export type InlineReferenceContext = {
  canOpenLocalPaths: boolean
  onOpenConversation?: (conversationId: string) => void
  onOpenExternalUrl?: (url: string) => void
  workspaceCwd?: string
}

const inlineReferenceContext = createContext<InlineReferenceContext | undefined>(undefined)

export function InlineReferenceProvider({
  children,
  value
}: {
  children: ReactNode
  value: InlineReferenceContext
}): React.JSX.Element {
  return <inlineReferenceContext.Provider value={value}>{children}</inlineReferenceContext.Provider>
}

export function InlineReference({
  children,
  descriptor,
  context
}: {
  children?: ReactNode
  context: InlineReferenceContext
  descriptor: InlineReferenceDescriptor
}): React.JSX.Element {
  if (descriptor.kind === 'unsupported') {
    return <span data-inline-reference-kind="unsupported">{children ?? descriptor.label}</span>
  }

  const content = (
    <ReferenceToken descriptor={descriptor}>{children ?? descriptor.label}</ReferenceToken>
  )

  if (descriptor.kind === 'external-url') {
    return (
      <ReferenceTooltip descriptor={descriptor}>
        <a
          data-inline-reference-kind={descriptor.kind}
          data-interactive="true"
          href={descriptor.href}
          rel="noreferrer"
          target="_blank"
          className={interactiveClassName}
          onClick={(event) => {
            if (!context.onOpenExternalUrl) return
            event.preventDefault()
            context.onOpenExternalUrl(descriptor.href)
          }}
        >
          {content}
        </a>
      </ReferenceTooltip>
    )
  }

  const action = actionForReference(descriptor, context)

  if (action?.type === 'local-path') {
    return (
      <ReferenceTooltip descriptor={descriptor}>
        <button
          data-inline-reference-kind={descriptor.kind}
          data-interactive="true"
          type="button"
          className={cn(interactiveClassName, 'bg-transparent p-0 text-left')}
          onClick={action.open}
        >
          {content}
        </button>
      </ReferenceTooltip>
    )
  }

  if (action?.type === 'conversation') {
    return (
      <ReferenceTooltip descriptor={descriptor}>
        <button
          data-inline-reference-kind={descriptor.kind}
          data-interactive="true"
          type="button"
          className={cn(interactiveClassName, 'bg-transparent p-0 text-left')}
          onClick={action.open}
        >
          {content}
        </button>
      </ReferenceTooltip>
    )
  }

  return (
    <ReferenceTooltip descriptor={descriptor}>
      <span
        data-inline-reference-kind={descriptor.kind}
        data-interactive="false"
        className={tokenClassName}
      >
        {content}
      </span>
    </ReferenceTooltip>
  )
}

export function InlineReferenceAnchor({
  children,
  href,
  node,
  ...props
}: ComponentProps<'a'> & { node?: unknown }): React.JSX.Element {
  void node
  const context = useContext(inlineReferenceContext)
  const descriptor = classifyAnchorReference(href, children)
  if (!descriptor || !context)
    return (
      <a href={href} {...props}>
        {children}
      </a>
    )
  return (
    <InlineReference context={context} descriptor={descriptor}>
      {children}
    </InlineReference>
  )
}

export function InlineReferenceCodeToken({
  children
}: Record<string, unknown> & { children?: ReactNode; node?: unknown }): React.JSX.Element {
  const context = useContext(inlineReferenceContext)
  const content = textFromChildren(children)
  const descriptor = inlineCodeReference(content)
  if (!descriptor || !context) return <DefaultInlineCode>{children}</DefaultInlineCode>
  return (
    <InlineReference context={context} descriptor={descriptor}>
      {children}
    </InlineReference>
  )
}

function DefaultInlineCode({ children }: { children?: ReactNode }): React.JSX.Element {
  return (
    <code
      className="rounded bg-muted px-1.5 py-0.5 font-mono text-sm"
      data-streamdown="inline-code"
    >
      {children}
    </code>
  )
}

function ReferenceTooltip({
  children,
  descriptor
}: {
  children: React.JSX.Element
  descriptor: Exclude<InlineReferenceDescriptor, { kind: 'unsupported' }>
}): React.JSX.Element {
  const label = descriptor.label || descriptor.href

  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>{children}</TooltipTrigger>
        <TooltipContent
          side="top"
          sideOffset={6}
          className="max-w-sm break-all bg-muted text-muted-foreground [&>svg]:fill-muted"
        >
          {descriptor.tooltip || label}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}

function ReferenceToken({
  children,
  descriptor
}: {
  children: ReactNode
  descriptor: Exclude<InlineReferenceDescriptor, { kind: 'unsupported' }>
}): React.JSX.Element {
  return (
    <span
      className="inline-flex max-w-full items-center gap-1 align-baseline"
      data-slot="inline-reference-content"
    >
      {iconForDescriptor(descriptor)}
      <span className="min-w-0 break-all" data-slot="inline-reference-label">
        {children}
        {descriptor.kind === 'local-file' && descriptor.line ? (
          <span data-slot="inline-reference-line">{` (line ${descriptor.line})`}</span>
        ) : null}
      </span>
    </span>
  )
}

function iconForDescriptor(
  descriptor: Exclude<InlineReferenceDescriptor, { kind: 'unsupported' }>
): React.JSX.Element {
  if (descriptor.kind === 'local-file' || descriptor.kind === 'local-folder') {
    return (
      <ResourceFileIcon
        aria-hidden
        className="size-3.5 shrink-0"
        path={descriptor.kind === 'local-folder' ? `${descriptor.path}/` : descriptor.path}
      />
    )
  }
  return <ReferenceIcon kind={descriptor.kind} />
}

function ReferenceIcon({
  kind
}: {
  kind: Exclude<InlineReferenceDescriptor['kind'], 'local-file' | 'local-folder' | 'unsupported'>
}): React.JSX.Element {
  const iconProps = { 'aria-hidden': true, className: 'size-3.5 shrink-0', strokeWidth: 1.8 }
  switch (kind) {
    case 'agent':
      return <BotIcon {...iconProps} />
    case 'app':
      return <PackageIcon {...iconProps} />
    case 'conversation':
      return <MessageSquareIcon {...iconProps} />
    case 'external-url':
      return <LinkIcon {...iconProps} />
    case 'mcp-resource':
      return <BoxesIcon {...iconProps} />
    case 'plugin':
      return <PuzzleIcon {...iconProps} />
    case 'sites-project':
      return <PanelsTopLeftIcon {...iconProps} />
    case 'skill':
      return <SparklesIcon {...iconProps} />
  }
}

function classifyAnchorReference(
  href: string | undefined,
  children: ReactNode
): InlineReferenceDescriptor | undefined {
  const label = textFromChildren(children)
  return href ? classifyReferenceTarget({ href, label }) : undefined
}

function actionForReference(
  descriptor: Exclude<InlineReferenceDescriptor, { kind: 'unsupported' }>,
  context: InlineReferenceContext
):
  | { type: 'conversation'; open: () => void }
  | { type: 'local-path'; open: () => void }
  | undefined {
  if (descriptor.kind === 'conversation') {
    const targetId = descriptor.targetId
    const openConversation = context.onOpenConversation
    if (!targetId || !openConversation) return undefined
    return { type: 'conversation', open: () => openConversation(targetId) }
  }
  if (descriptor.kind !== 'local-file' && descriptor.kind !== 'local-folder') return undefined
  if (!context.canOpenLocalPaths) return undefined

  const payload = localOpenPayload(descriptor, context)
  if (!payload) return undefined
  return {
    type: 'local-path',
    open: () => {
      void window.desktopApp.codex.openLocalPath(payload).catch(() => undefined)
    }
  }
}

function localOpenPayload(
  descriptor: Extract<InlineReferenceDescriptor, { kind: 'local-file' | 'local-folder' }>,
  context: InlineReferenceContext
): { cwd?: string; line?: number; path: string } | undefined {
  if (isAbsoluteLocalPath(descriptor.path)) {
    return { path: descriptor.path, ...(descriptor.line ? { line: descriptor.line } : {}) }
  }
  if (!context.workspaceCwd || !isSafeRelativeReferencePath(descriptor.path)) return undefined
  return {
    path: descriptor.path,
    cwd: context.workspaceCwd,
    ...(descriptor.line ? { line: descriptor.line } : {})
  }
}

const tokenClassName = 'inline align-[-0.125em] text-sky-700 dark:text-sky-300'
const interactiveClassName = cn(
  tokenClassName,
  'cursor-pointer hover:underline hover:decoration-dotted hover:underline-offset-4 focus-visible:underline focus-visible:decoration-dotted focus-visible:underline-offset-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60'
)

function textFromChildren(children: ReactNode): string {
  if (typeof children === 'string' || typeof children === 'number') return String(children)
  if (Array.isArray(children)) return children.map(textFromChildren).join('')
  if (isValidElement<{ children?: ReactNode }>(children)) {
    return textFromChildren(children.props.children)
  }
  return ''
}
