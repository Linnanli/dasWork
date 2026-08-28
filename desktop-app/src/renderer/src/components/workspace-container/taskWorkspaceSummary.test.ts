import { describe, expect, it } from 'vitest'

import { taskAgentsFromRenderUnits } from './taskWorkspaceSummary'

describe('taskAgentsFromRenderUnits', () => {
  it('uses the latest activity record for each subagent across nested render groups', () => {
    const agents = taskAgentsFromRenderUnits([
      {
        type: 'reasoning-group',
        children: [
          {
            type: 'subagent-activity-group',
            agents: [
              {
                eventId: 'agent-a-started',
                threadId: 'agent-a',
                agentPath: '/root/review',
                displayName: 'Review',
                displayStatus: 'active',
                model: 'gpt-5.5'
              }
            ]
          }
        ]
      },
      {
        type: 'subagent-activity-group',
        agents: [
          {
            eventId: 'agent-a-finished',
            threadId: 'agent-a',
            agentPath: '/root/review',
            displayName: 'Review',
            displayStatus: 'finished'
          },
          {
            eventId: 'agent-b-active',
            threadId: 'agent-b',
            agentPath: '/root/architecture',
            displayName: 'Architecture',
            displayStatus: 'active'
          }
        ]
      }
    ] as never)

    expect(agents).toEqual([
      {
        eventId: 'agent-a-finished',
        threadId: 'agent-a',
        agentPath: '/root/review',
        displayName: 'Review',
        displayStatus: 'finished',
        model: 'gpt-5.5'
      },
      {
        eventId: 'agent-b-active',
        threadId: 'agent-b',
        agentPath: '/root/architecture',
        displayName: 'Architecture',
        displayStatus: 'active'
      }
    ])
  })
})
