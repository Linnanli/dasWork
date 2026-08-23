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
  type InlineReferenceDescriptor
} from '@/lib/referenceInlineTarget'
import type { InlineReferenceAction } from '@/lib/referenceInlineAction'
import { cn } from '@/lib/utils'
import { ResourceFileIcon } from './resourceFileIcon'

export type InlineReferenceContext = {
  canOpenLocalPaths: boolean
  execute?(action: InlineReferenceAction): void
  resolve?(descriptor: InlineReferenceDescriptor): InlineReferenceAction
  /** @deprecated Compatibility fields for standalone renderers; production uses resolve/execute. */
  onOpenConversation?: (conversationId: string) => void
  /** @deprecated Compatibility fields for standalone renderers; production uses resolve/execute. */
  onOpenExternalUrl?: (url: string) => void
  /** @deprecated Compatibility fields for standalone renderers; production uses resolve/execute. */
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
  const action =
    context.resolve && context.execute
      ? context.resolve(descriptor)
      : ({ type: 'display-only', reason: 'unsupported' } as const)

  if (descriptor.kind === 'external-url' && action.type !== 'display-only') {
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
            if (
              event.metaKey ||
              event.ctrlKey ||
              event.shiftKey ||
              event.altKey ||
              event.button !== 0
            )
              return
            event.preventDefault()
            context.execute?.(action)
          }}
        >
          {content}
        </a>
      </ReferenceTooltip>
    )
  }

  if (action.type !== 'display-only') {
    return (
      <ReferenceTooltip descriptor={descriptor}>
        <button
          data-inline-reference-kind={descriptor.kind}
          data-interactive="true"
          type="button"
          className={cn(interactiveClassName, 'bg-transparent p-0 text-left')}
          onClick={() => context.execute?.(action)}
          onDoubleClick={
            action.type === 'workspace-file'
              ? () => context.execute?.({ ...action, mode: 'pinned' })
              : undefined
          }
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
