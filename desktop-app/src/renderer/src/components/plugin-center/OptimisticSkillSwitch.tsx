import * as React from 'react'

import { Switch } from '@/components/ui/switch'

export function OptimisticSkillSwitch({
  enabled,
  disabled,
  getAriaLabel,
  title,
  onToggle
}: {
  enabled: boolean
  disabled: boolean
  getAriaLabel: (enabled: boolean) => string
  title?: string
  onToggle: (enabled: boolean) => Promise<boolean>
}): React.JSX.Element {
  const [optimisticEnabled, setOptimisticEnabled] = React.useState<boolean | null>(null)
  const [isPending, setIsPending] = React.useState(false)
  const checked =
    optimisticEnabled !== null && (isPending || enabled !== optimisticEnabled)
      ? optimisticEnabled
      : enabled

  const handleCheckedChange = (nextEnabled: boolean): void => {
    setOptimisticEnabled(nextEnabled)
    setIsPending(true)
    void onToggle(nextEnabled)
      .then((succeeded) => {
        if (!succeeded) setOptimisticEnabled(null)
      })
      .catch(() => setOptimisticEnabled(null))
      .finally(() => setIsPending(false))
  }

  return (
    <Switch
      checked={checked}
      disabled={disabled || isPending}
      aria-label={getAriaLabel(checked)}
      title={title}
      onCheckedChange={handleCheckedChange}
    />
  )
}
