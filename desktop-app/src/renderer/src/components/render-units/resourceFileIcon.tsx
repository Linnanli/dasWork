import {
  AtomIcon,
  BinaryIcon,
  BoxesIcon,
  BracesIcon,
  Code2Icon,
  CodeXmlIcon,
  FileCode2Icon,
  FileCogIcon,
  FileIcon,
  FileTextIcon,
  FileType2Icon,
  FolderArchiveIcon,
  HashIcon,
  ImageIcon,
  NotebookPenIcon,
  SquareTerminalIcon,
  type LucideIcon
} from 'lucide-react'
import { useId, type SVGProps } from 'react'
import { resourceFileIconKind, type ReferenceFileIconKind } from './resourceFileIconKind'

type BrandedFileIconKind = 'artifactDocument' | 'pdf' | 'presentation' | 'spreadsheet'
type NeutralFileIconKind = Exclude<ReferenceFileIconKind, BrandedFileIconKind>

type ResourceFileIconProps = SVGProps<SVGSVGElement> & {
  mimeType?: string
  path?: string
}

const neutralIcons: Readonly<Record<NeutralFileIconKind, LucideIcon>> = {
  build: FileCogIcon,
  code: Code2Icon,
  cplusplus: Code2Icon,
  css: HashIcon,
  document: FileTextIcon,
  file: FileIcon,
  folder: FolderArchiveIcon,
  hashes: HashIcon,
  html: CodeXmlIcon,
  image: ImageIcon,
  java: FileCode2Icon,
  javascript: FileCode2Icon,
  json: BracesIcon,
  notebook: NotebookPenIcon,
  php: FileCode2Icon,
  python: FileCode2Icon,
  react: AtomIcon,
  rust: BinaryIcon,
  shell: SquareTerminalIcon,
  skill: BoxesIcon,
  terminal: SquareTerminalIcon,
  toml: BracesIcon,
  typescript: FileType2Icon,
  yaml: FileIcon
}

/** Matches the file-type artwork used by the reference Codex resource cards. */
export function ResourceFileIcon({
  mimeType,
  path,
  ...props
}: ResourceFileIconProps): React.JSX.Element {
  const kind = resourceFileIconKind(path, mimeType)

  switch (kind) {
    case 'artifactDocument':
      return <OfficeFileIcon data-file-icon={kind} kind="document" {...props} />
    case 'pdf':
      return <OfficeFileIcon data-file-icon={kind} kind="pdf" {...props} />
    case 'presentation':
      return <PresentationFileIcon {...props} />
    case 'spreadsheet':
      return <OfficeFileIcon data-file-icon={kind} kind="spreadsheet" {...props} />
    default: {
      const Icon = neutralIcons[kind]
      return (
        <Icon data-file-icon={kind} data-slot="resource-file-icon" strokeWidth={1.6} {...props} />
      )
    }
  }
}

function OfficeFileIcon({
  kind,
  ...props
}: SVGProps<SVGSVGElement> & {
  kind: 'document' | 'pdf' | 'spreadsheet'
}): React.JSX.Element {
  const gradientId = useId()
  const colors = {
    document: { start: '#1293F1', end: '#043CCC', inner: '#0535AD', fold: '#56B5FE', label: 'W' },
    pdf: { start: '#F75858', end: '#C6323A', inner: '#A72731', fold: '#FF928C', label: 'PDF' },
    spreadsheet: { start: '#4AA647', end: '#13551B', inner: '#09442A', fold: '#B5E480', label: 'X' }
  }[kind]

  return (
    <svg
      data-file-icon={kind}
      data-slot="resource-file-icon"
      fill="none"
      viewBox="0 0 24 24"
      xmlns="http://www.w3.org/2000/svg"
      {...props}
    >
      <path
        d="M13 2.594c.267 0 .538.074.813.224.275.15.583.393.925.726l4.95 4.9c.542.541.813 1.091.813 1.65v7.45c0 .725-.179 1.396-.537 2.013a4.001 4.001 0 0 1-1.463 1.449 3.87 3.87 0 0 1-2 .538h-9c-.725 0-1.396-.18-2.013-.538a4.031 4.031 0 0 1-1.45-1.45 3.937 3.937 0 0 1-.537-2.012V6.594c0-.725.179-1.392.537-2a4.002 4.002 0 0 1 1.45-1.463A3.936 3.936 0 0 1 7.5 2.594H13Z"
        fill={`url(#${gradientId})`}
      />
      <path
        d="M14.676 8.594H9.332a1.828 1.828 0 0 0-1.828 1.828v5.344c0 1.01.818 1.828 1.828 1.828h5.344c1.01 0 1.828-.818 1.828-1.828v-5.344c0-1.01-.818-1.828-1.828-1.828Z"
        fill={colors.inner}
      />
      <path
        d="M13 2.594c.267 0 .537.075.813.225.274.15.583.391.925.725l4.95 4.9c.541.541.812 1.091.812 1.65h-4.787c-.834 0-1.496-.242-1.988-.725C13.242 8.877 13 8.215 13 7.38V2.594Z"
        fill={colors.fold}
      />
      <text
        fill="white"
        fontFamily="Arial, sans-serif"
        fontSize={kind === 'pdf' ? '4.1' : '6.3'}
        fontWeight="700"
        textAnchor="middle"
        x="12"
        y={kind === 'pdf' ? '14.55' : '14.9'}
      >
        {colors.label}
      </text>
      <defs>
        <linearGradient id={gradientId} x1="4.5" x2="16" y1="20.594" y2="7.094">
          <stop offset=".024" stopColor={colors.start} />
          <stop offset="1" stopColor={colors.end} />
        </linearGradient>
      </defs>
    </svg>
  )
}

function PresentationFileIcon(props: SVGProps<SVGSVGElement>): React.JSX.Element {
  const outerGradientId = useId()
  const innerGradientId = useId()
  const highlightGradientId = useId()
  const foldGradientId = useId()

  return (
    <svg
      data-file-icon="presentation"
      data-slot="resource-file-icon"
      fill="none"
      viewBox="0 0 24 24"
      xmlns="http://www.w3.org/2000/svg"
      {...props}
    >
      <path
        d="M13.004 2.594c.267 0 .538.074.813.224.275.15.583.393.925.726l4.95 4.9c.542.541.813 1.091.813 1.65v7.45c0 .725-.179 1.396-.537 2.013a4.001 4.001 0 0 1-1.463 1.449 3.87 3.87 0 0 1-2 .538h-9c-.725 0-1.396-.18-2.013-.538a4.031 4.031 0 0 1-1.45-1.45 3.937 3.937 0 0 1-.537-2.012V6.594c0-.725.179-1.392.537-2a4.002 4.002 0 0 1 1.45-1.463 3.936 3.936 0 0 1 2.013-.537h5.5Z"
        fill={`url(#${outerGradientId})`}
      />
      <path
        d="M14.676 8.594H9.332a1.828 1.828 0 0 0-1.828 1.828v5.344c0 1.01.818 1.828 1.828 1.828h5.344c1.01 0 1.828-.818 1.828-1.828v-5.344c0-1.01-.818-1.828-1.828-1.828Z"
        fill={`url(#${innerGradientId})`}
      />
      <path
        d="M14.676 8.594H9.332a1.828 1.828 0 0 0-1.828 1.828v5.344c0 1.01.818 1.828 1.828 1.828h5.344c1.01 0 1.828-.818 1.828-1.828v-5.344c0-1.01-.818-1.828-1.828-1.828Z"
        fill={`url(#${highlightGradientId})`}
        fillOpacity=".3"
      />
      <path
        d="M11.566 13.99v1.674h-1.158v-5.142h1.789c.64 0 1.128.14 1.462.419.337.28.506.694.506 1.244 0 .567-.189 1.009-.566 1.327-.375.318-.88.477-1.513.477h-.52Zm0-2.579V13.1h.484c.287 0 .508-.075.663-.226.155-.15.233-.367.233-.649 0-.26-.077-.461-.23-.602-.15-.141-.367-.212-.649-.212h-.5Z"
        fill="#fff"
      />
      <path
        d="M13.004 2.594c.267 0 .537.075.813.225.274.15.583.391.925.725l4.95 4.9c.541.541.812 1.091.812 1.65h-4.787c-.834 0-1.496-.242-1.988-.725-.483-.492-.725-1.154-.725-1.989V2.594Z"
        fill={`url(#${foldGradientId})`}
      />
      <defs>
        <linearGradient id={outerGradientId} x1="4.504" x2="16.004" y1="20.594" y2="7.094">
          <stop offset=".024" stopColor="#F35AAA" />
          <stop offset=".529" stopColor="#E1473D" />
          <stop offset="1" stopColor="#B0212C" />
        </linearGradient>
        <radialGradient
          id={innerGradientId}
          cx="0"
          cy="0"
          gradientTransform="translate(7.503 8.594) rotate(45) scale(12.728)"
          gradientUnits="userSpaceOnUse"
          r="1"
        >
          <stop stopColor="#F8193E" />
          <stop offset=".939" stopColor="#920616" />
        </radialGradient>
        <radialGradient
          id={highlightGradientId}
          cx="0"
          cy="0"
          gradientTransform="translate(12.003 13.994) rotate(90) scale(6.3 7.172)"
          gradientUnits="userSpaceOnUse"
          r="1"
        >
          <stop offset=".576" stopColor="#FFB055" stopOpacity="0" />
          <stop offset=".974" stopColor="#FFF2BE" />
        </radialGradient>
        <linearGradient id={foldGradientId} x1="16.504" x2="13.504" y1="6.094" y2="9.594">
          <stop stopColor="#FF8F29" />
          <stop offset=".851" stopColor="#FE80AD" />
        </linearGradient>
      </defs>
    </svg>
  )
}
