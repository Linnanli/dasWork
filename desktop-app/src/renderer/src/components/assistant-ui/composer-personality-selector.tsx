import { CheckIcon, ChevronDownIcon, SparklesIcon } from 'lucide-react'

import type { Personality } from '../../../../shared/codexIpcApi'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'

type PersonalityOption = {
  id: Personality
  label: string
  description: string
}

const personalityOptions: readonly PersonalityOption[] = [
  { id: 'none', label: '默认', description: '保持模型的默认表达方式' },
  { id: 'friendly', label: '友好', description: '语气更温和、鼓励且易于沟通' },
  { id: 'pragmatic', label: '务实', description: '优先给出简洁、直接的行动建议' }
]

export type ComposerPersonalitySelectorProps = {
  personality: Personality
  disabled?: boolean
  onPersonalityChange: (personality: Personality) => void
}

export function ComposerPersonalitySelector({
  personality,
  disabled = false,
  onPersonalityChange
}: ComposerPersonalitySelectorProps): React.JSX.Element {
  const selectedOption = personalityOptions.find((option) => option.id === personality)

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild disabled={disabled}>
        <Button
          type="button"
          size="xs"
          variant="ghost"
          aria-label={`个性：${selectedOption?.label ?? '默认'}`}
          data-slot="composer-personality-selector"
          data-personality={personality}
          disabled={disabled}
          className="h-7 rounded-full px-2 text-muted-foreground hover:bg-foreground/5 hover:text-foreground dark:hover:bg-foreground/8"
        >
          <SparklesIcon className="size-4 stroke-[1.75px]" />
          <span className="hidden max-w-20 truncate sm:inline">{selectedOption?.label ?? '默认'}</span>
          <ChevronDownIcon className="hidden size-3 opacity-70 sm:block" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        className="w-[min(20rem,calc(100vw-2rem))] p-2"
        data-slot="composer-personality-menu"
      >
        <DropdownMenuLabel className="px-2.5 py-2 text-sm font-medium text-foreground">
          回复个性
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        {personalityOptions.map((option) => (
          <DropdownMenuItem
            key={option.id}
            className="items-start gap-3 px-2.5 py-2.5"
            data-personality={option.id}
            onSelect={() => onPersonalityChange(option.id)}
          >
            <SparklesIcon className="mt-0.5 size-4 shrink-0 stroke-[1.75px]" />
            <span className="min-w-0 flex-1">
              <span className="block text-sm leading-5">{option.label}</span>
              <span className="block text-xs leading-4 text-muted-foreground">
                {option.description}
              </span>
            </span>
            {option.id === personality ? <CheckIcon aria-label="已选择" className="mt-0.5 size-4" /> : null}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
