import { useEffect, useMemo, useState } from 'react'
import { LoaderIcon, PauseIcon, PlayIcon, Trash2Icon } from 'lucide-react'
import { toast } from 'sonner'

import type { AutomationSchedule, ScheduledAutomation } from '../../../shared/automationApi'
import { Button } from '../components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '../components/ui/dialog'
import { Input } from '../components/ui/input'
import { Textarea } from '../components/ui/textarea'

type ScheduleKind = AutomationSchedule['kind']

export function AutomationDialog({
  open,
  sourceConversationId,
  sourceThreadId,
  sourceTitle,
  onOpenChange
}: {
  open: boolean
  sourceConversationId: string
  sourceThreadId?: string
  sourceTitle: string
  onOpenChange: (open: boolean) => void
}): React.JSX.Element {
  const [automations, setAutomations] = useState<ScheduledAutomation[]>([])
  const [pending, setPending] = useState(false)
  const [editingId, setEditingId] = useState<string | undefined>()
  const [title, setTitle] = useState(() => defaultTitle(sourceTitle))
  const [prompt, setPrompt] = useState(() => defaultPrompt(sourceTitle))
  const [scheduleKind, setScheduleKind] = useState<ScheduleKind>('daily')
  const [onceAt, setOnceAt] = useState(defaultOnceAt())
  const [time, setTime] = useState('09:00')
  const [weekday, setWeekday] = useState('1')

  const scopedAutomations = useMemo(
    () =>
      automations.filter(
        (automation) =>
          automation.sourceConversationId === sourceConversationId ||
          (sourceThreadId !== undefined && automation.sourceThreadId === sourceThreadId)
      ),
    [automations, sourceConversationId, sourceThreadId]
  )

  const load = async (): Promise<void> => {
    const api = window.desktopApp.automations
    setAutomations(await api.list())
  }

  useEffect(() => {
    let active = true
    window.desktopApp.automations
      .list()
      .then((result) => {
        if (active) setAutomations(result)
      })
      .catch((error) => {
        if (active) toast.error(errorMessage(error))
      })
    return () => {
      active = false
    }
  }, [])

  const resetForm = (): void => {
    setEditingId(undefined)
    setTitle(defaultTitle(sourceTitle))
    setPrompt(defaultPrompt(sourceTitle))
    setScheduleKind('daily')
    setOnceAt(defaultOnceAt())
    setTime('09:00')
    setWeekday('1')
  }

  const submit = async (): Promise<void> => {
    const trimmedTitle = title.trim()
    const trimmedPrompt = prompt.trim()
    if (!trimmedTitle || !trimmedPrompt) {
      toast.error('请填写任务名称和执行内容')
      return
    }
    const schedule = scheduleFromForm({ scheduleKind, onceAt, time, weekday })
    if (!schedule) {
      toast.error('请填写有效的执行时间')
      return
    }
    setPending(true)
    try {
      if (editingId) {
        await window.desktopApp.automations.update({
          id: editingId,
          title: trimmedTitle,
          prompt: trimmedPrompt,
          schedule
        })
        toast.success('定时任务已更新')
      } else {
        await window.desktopApp.automations.create({
          sourceConversationId,
          ...(sourceThreadId ? { sourceThreadId } : {}),
          title: trimmedTitle,
          prompt: trimmedPrompt,
          schedule
        })
        toast.success('定时任务已创建')
      }
      await load()
      resetForm()
    } catch (error) {
      toast.error(errorMessage(error))
    } finally {
      setPending(false)
    }
  }

  const edit = (automation: ScheduledAutomation): void => {
    setEditingId(automation.id)
    setTitle(automation.title)
    setPrompt(automation.prompt)
    setScheduleKind(automation.schedule.kind)
    if (automation.schedule.kind === 'once') {
      setOnceAt(toLocalDateTime(automation.schedule.at))
    } else {
      setTime(automation.schedule.time)
      if (automation.schedule.kind === 'weekly') setWeekday(String(automation.schedule.weekday))
    }
  }

  const perform = async (work: () => Promise<void>): Promise<void> => {
    setPending(true)
    try {
      await work()
      await load()
    } catch (error) {
      toast.error(errorMessage(error))
    } finally {
      setPending(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[min(760px,calc(100vh-2rem))] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{editingId ? '编辑定时任务' : '为此对话创建定时任务'}</DialogTitle>
          <DialogDescription>
            定时任务仅在本应用运行期间在此设备上执行。每次运行会创建可追踪的新任务，并沿用当前对话的项目环境。
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3 py-2">
          <label className="grid gap-1.5 text-sm font-medium">
            任务名称
            <Input
              aria-label="定时任务名称"
              disabled={pending}
              value={title}
              onChange={(event) => setTitle(event.target.value)}
            />
          </label>
          <label className="grid gap-1.5 text-sm font-medium">
            每次执行的内容
            <Textarea
              aria-label="定时任务内容"
              disabled={pending}
              rows={3}
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
            />
          </label>
          <label className="grid gap-1.5 text-sm font-medium">
            执行频率
            <select
              aria-label="定时任务频率"
              className="h-9 rounded-md border bg-background px-3 text-sm"
              disabled={pending}
              value={scheduleKind}
              onChange={(event) => setScheduleKind(event.target.value as ScheduleKind)}
            >
              <option value="once">只执行一次</option>
              <option value="daily">每天</option>
              <option value="weekly">每周</option>
            </select>
          </label>
          {scheduleKind === 'once' ? (
            <label className="grid gap-1.5 text-sm font-medium">
              执行时间
              <Input
                aria-label="定时任务执行时间"
                disabled={pending}
                type="datetime-local"
                value={onceAt}
                onChange={(event) => setOnceAt(event.target.value)}
              />
            </label>
          ) : (
            <div className="grid grid-cols-2 gap-3">
              {scheduleKind === 'weekly' ? (
                <label className="grid gap-1.5 text-sm font-medium">
                  星期
                  <select
                    aria-label="定时任务星期"
                    className="h-9 rounded-md border bg-background px-3 text-sm"
                    disabled={pending}
                    value={weekday}
                    onChange={(event) => setWeekday(event.target.value)}
                  >
                    <option value="0">周日</option>
                    <option value="1">周一</option>
                    <option value="2">周二</option>
                    <option value="3">周三</option>
                    <option value="4">周四</option>
                    <option value="5">周五</option>
                    <option value="6">周六</option>
                  </select>
                </label>
              ) : null}
              <label className="grid gap-1.5 text-sm font-medium">
                执行时间
                <Input
                  aria-label="定时任务每日时间"
                  disabled={pending}
                  type="time"
                  value={time}
                  onChange={(event) => setTime(event.target.value)}
                />
              </label>
            </div>
          )}
        </div>
        <DialogFooter className="sm:justify-between">
          {editingId ? (
            <Button disabled={pending} type="button" variant="ghost" onClick={resetForm}>
              取消编辑
            </Button>
          ) : (
            <span />
          )}
          <Button disabled={pending} type="button" onClick={() => void submit()}>
            {pending ? <LoaderIcon className="animate-spin" /> : null}
            {editingId ? '保存修改' : '创建定时任务'}
          </Button>
        </DialogFooter>
        <div className="border-t pt-4">
          <h3 className="text-sm font-semibold">此对话的定时任务</h3>
          {scopedAutomations.length === 0 ? (
            <p className="mt-2 text-sm text-muted-foreground">尚未创建定时任务。</p>
          ) : (
            <ul className="mt-3 grid gap-2" data-slot="scheduled-automation-list">
              {scopedAutomations.map((automation) => {
                const latestRun = automation.runs[0]
                return (
                  <li className="rounded-md border p-3" key={automation.id}>
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <p className="font-medium">{automation.title}</p>
                        <p className="mt-1 text-xs text-muted-foreground">
                          {scheduleLabel(automation.schedule)} ·{' '}
                          {automation.status === 'active'
                            ? `下次：${dateLabel(automation.nextRunAt)}`
                            : '已暂停'}
                        </p>
                        {latestRun ? (
                          <p className="mt-1 text-xs text-muted-foreground">
                            最近运行：{runLabel(latestRun)}
                          </p>
                        ) : null}
                      </div>
                      <div className="flex shrink-0 gap-1">
                        <Button
                          aria-label={`编辑 ${automation.title}`}
                          disabled={pending}
                          size="icon-xs"
                          type="button"
                          variant="ghost"
                          onClick={() => edit(automation)}
                        >
                          编辑
                        </Button>
                        <Button
                          aria-label={
                            automation.status === 'active'
                              ? `暂停 ${automation.title}`
                              : `恢复 ${automation.title}`
                          }
                          disabled={pending}
                          size="icon-xs"
                          type="button"
                          variant="ghost"
                          onClick={() =>
                            void perform(() =>
                              window.desktopApp.automations.setStatus({
                                id: automation.id,
                                status: automation.status === 'active' ? 'paused' : 'active'
                              })
                            )
                          }
                        >
                          {automation.status === 'active' ? <PauseIcon /> : <PlayIcon />}
                        </Button>
                        <Button
                          aria-label={`立即运行 ${automation.title}`}
                          disabled={pending}
                          size="icon-xs"
                          type="button"
                          variant="ghost"
                          onClick={() =>
                            void perform(() =>
                              window.desktopApp.automations.runNow({ id: automation.id })
                            )
                          }
                        >
                          <PlayIcon />
                        </Button>
                        <Button
                          aria-label={`删除 ${automation.title}`}
                          disabled={pending}
                          size="icon-xs"
                          type="button"
                          variant="ghost"
                          onClick={() =>
                            void perform(() =>
                              window.desktopApp.automations.remove({ id: automation.id })
                            )
                          }
                        >
                          <Trash2Icon />
                        </Button>
                      </div>
                    </div>
                  </li>
                )
              })}
            </ul>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}

function scheduleFromForm(input: {
  scheduleKind: ScheduleKind
  onceAt: string
  time: string
  weekday: string
}): AutomationSchedule | undefined {
  if (input.scheduleKind === 'once') {
    const at = new Date(input.onceAt)
    return Number.isFinite(at.getTime()) && at.getTime() > Date.now()
      ? { kind: 'once', at: at.toISOString() }
      : undefined
  }
  if (!/^([01]\d|2[0-3]):[0-5]\d$/u.test(input.time)) return undefined
  if (input.scheduleKind === 'daily') return { kind: 'daily', time: input.time }
  const weekday = Number(input.weekday)
  return Number.isInteger(weekday) && weekday >= 0 && weekday <= 6
    ? { kind: 'weekly', weekday, time: input.time }
    : undefined
}

function defaultTitle(sourceTitle: string): string {
  return `${sourceTitle} 定时任务`
}
function defaultPrompt(sourceTitle: string): string {
  return `继续处理“${sourceTitle}”中的工作，并汇报最新进展。`
}
function defaultOnceAt(): string {
  const value = new Date(Date.now() + 60 * 60 * 1_000)
  value.setSeconds(0, 0)
  return toLocalDateTime(value.toISOString())
}
function toLocalDateTime(value: string): string {
  const date = new Date(value)
  const offset = date.getTimezoneOffset() * 60_000
  return new Date(date.getTime() - offset).toISOString().slice(0, 16)
}
function dateLabel(value: string | undefined): string {
  return value ? new Date(value).toLocaleString() : '未安排'
}
function scheduleLabel(schedule: AutomationSchedule): string {
  if (schedule.kind === 'once') return `一次：${dateLabel(schedule.at)}`
  if (schedule.kind === 'daily') return `每天 ${schedule.time}`
  return `每周${['日', '一', '二', '三', '四', '五', '六'][schedule.weekday]} ${schedule.time}`
}
function runLabel(run: ScheduledAutomation['runs'][number]): string {
  const state = run.status === 'completed' ? '已完成' : run.status === 'failed' ? '失败' : '进行中'
  return `${state} · ${new Date(run.startedAt).toLocaleString()}`
}
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : '无法更新定时任务'
}
