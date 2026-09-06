#!/usr/bin/env node
/* eslint-disable @typescript-eslint/explicit-function-return-type -- Test-only JSON-RPC peer. */

import { appendFileSync } from 'node:fs'
import { createInterface } from 'node:readline'

if (process.argv.includes('--version')) {
  process.stdout.write('codex-cli 0.148.0-alpha.21\n')
  process.exit(0)
}

const scenario = process.env.DASCOWORK_E2E_APPROVAL_SCENARIO
const responsePath = process.env.DASCOWORK_E2E_APPROVAL_RESPONSE_PATH
const threadId = 'e2e-approval-thread'
const turnId = 'e2e-approval-turn'
const approvalRequestId = 9_001

if (!scenario || !responsePath) {
  throw new Error(
    'Approval-panel E2E app-server requires scenario and response-path environment values.'
  )
}

const isFileScenario = scenario === 'file' || scenario === 'file-cache-miss'
const fileChangeItemId = scenario === 'file' ? 'file-change-item' : 'file-cache-miss-item'
const input = createInterface({ input: process.stdin, crlfDelay: Infinity })

input.on('line', (line) => {
  const message = JSON.parse(line)

  if (message.method === 'initialize') {
    respond(message.id, { serverInfo: { name: 'e2e-approval-panel', version: '1.0.0' } })
    return
  }

  if (message.method === 'thread/start') {
    respond(message.id, { threadId })
    return
  }

  if (message.method === 'thread/resume') {
    respond(message.id, { thread: { id: threadId } })
    return
  }

  if (message.method === 'turn/start') {
    respond(message.id, { turnId })
    emit({ method: 'turn/started', params: { threadId, turn: { id: turnId } } })
    if (scenario === 'file') emitFileChangeStarted()
    emit(approvalRequest())
    return
  }

  if (message.id === approvalRequestId && 'result' in message) {
    appendFileSync(responsePath, `${JSON.stringify(message.result)}\n`, 'utf8')
    if (isFileScenario) {
      emit({
        method: 'item/completed',
        params: {
          threadId,
          turnId,
          item: {
            type: 'fileChange',
            id: fileChangeItemId,
            status: 'completed',
            changes: []
          }
        }
      })
    }
    emit({
      method: 'turn/completed',
      params: { threadId, turn: { id: turnId, status: 'completed' } }
    })
    return
  }

  if (message.id !== undefined && message.method) respond(message.id, {})
})

function respond(id, result) {
  emit({ id, result })
}

function emit(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`)
}

function emitFileChangeStarted() {
  emit({
    method: 'item/started',
    params: {
      threadId,
      turnId,
      startedAtMs: 1,
      item: {
        type: 'fileChange',
        id: 'file-change-item',
        status: 'inProgress',
        changes: [
          {
            path: '/private/tmp/p0-06-approval.e2e.ts',
            kind: { type: 'update', move_path: null },
            diff: '@@ -1 +1 @@\n-before\n+after'
          }
        ]
      }
    }
  })
}

function approvalRequest() {
  if (isFileScenario) {
    return {
      id: approvalRequestId,
      method: 'item/fileChange/requestApproval',
      params: {
        threadId,
        turnId,
        itemId: fileChangeItemId,
        startedAtMs: 2,
        reason: 'Update the E2E fixture',
        grantRoot: '/private/tmp'
      }
    }
  }

  if (
    scenario === 'command-decisions-missing' ||
    scenario === 'command-decisions-empty-auto-cancel' ||
    scenario === 'command-decline-versus-cancel'
  ) {
    return {
      id: approvalRequestId,
      method: 'item/commandExecution/requestApproval',
      params: {
        threadId,
        turnId,
        itemId: `command-${scenario}`,
        command: 'node scripts/approval-semantics.mjs',
        reason: 'Verify command approval semantics',
        ...(scenario === 'command-decisions-empty-auto-cancel'
          ? { availableDecisions: [] }
          : scenario === 'command-decline-versus-cancel'
            ? { availableDecisions: ['accept', 'decline', 'cancel'] }
            : {})
      }
    }
  }

  if (scenario === 'network') {
    return {
      id: approvalRequestId,
      method: 'item/commandExecution/requestApproval',
      params: {
        threadId,
        turnId,
        itemId: 'network-command-item',
        command: 'git push origin main',
        reason: 'Push the approved branch',
        networkApprovalContext: { host: 'github.com', protocol: 'https' },
        proposedNetworkPolicyAmendments: [{ host: 'github.com', action: 'allow' }],
        availableDecisions: [
          'accept',
          'decline',
          {
            applyNetworkPolicyAmendment: {
              network_policy_amendment: { host: 'github.com', action: 'allow' }
            }
          }
        ]
      }
    }
  }

  if (scenario === 'tool') {
    return {
      id: approvalRequestId,
      method: 'item/tool/requestUserInput',
      params: {
        threadId,
        turnId,
        itemId: 'tool-input-item',
        questions: [
          {
            id: 'environment',
            header: 'Environment',
            question: 'Choose an environment',
            isOther: true,
            isSecret: false,
            options: [
              { label: 'staging', description: 'Pre-production' },
              { label: 'production', description: 'Production' }
            ]
          },
          {
            id: 'token',
            header: 'Token',
            question: 'Enter a deployment token',
            isOther: false,
            isSecret: true,
            options: null
          }
        ]
      }
    }
  }

  if (
    scenario === 'permission-network-turn' ||
    scenario === 'permission-filesystem-session' ||
    scenario === 'permission-mixed-decline'
  ) {
    const permissions =
      scenario === 'permission-network-turn'
        ? { network: { enabled: true }, fileSystem: null }
        : scenario === 'permission-filesystem-session'
          ? {
              network: null,
              fileSystem: {
                entries: [
                  { path: { type: 'path', path: '/private/tmp/e2e-approval' }, access: 'read' },
                  {
                    path: { type: 'glob_pattern', pattern: '/private/tmp/**/*.ts' },
                    access: 'write'
                  }
                ],
                globScanMaxDepth: 3
              }
            }
          : {
              network: { enabled: true },
              fileSystem: {
                entries: [{ path: { type: 'special', value: { kind: 'tmpdir' } }, access: 'read' }]
              }
            }
    return {
      id: approvalRequestId,
      method: 'item/permissions/requestApproval',
      params: {
        threadId,
        turnId,
        itemId: 'permission-item',
        environmentId: null,
        startedAtMs: Date.now(),
        cwd: '/private/tmp/e2e-approval',
        reason: 'The test tool needs these permissions',
        permissions
      }
    }
  }

  if (scenario === 'tool-auto-resolve') {
    return {
      id: approvalRequestId,
      method: 'item/tool/requestUserInput',
      params: {
        threadId,
        turnId,
        itemId: 'tool-auto-item',
        autoResolutionMs: 500,
        questions: [
          {
            id: 'target',
            header: 'Target',
            question: 'Choose a target',
            isOther: false,
            isSecret: false,
            options: null
          }
        ]
      }
    }
  }

  if (scenario === 'command-additional-permissions') {
    return {
      id: approvalRequestId,
      method: 'item/commandExecution/requestApproval',
      params: {
        threadId,
        turnId,
        itemId: 'permissioned-command-item',
        command: 'node scripts/permissioned-task.mjs',
        reason: 'The E2E command requires the listed access',
        additionalPermissions: {
          network: { enabled: true },
          fileSystem: {
            entries: [{ path: { type: 'path', path: '/private/tmp/e2e-command' }, access: 'write' }]
          }
        },
        availableDecisions: ['accept', 'decline']
      }
    }
  }

  if (scenario === 'tool-auto-resolve-snooze') {
    return {
      id: approvalRequestId,
      method: 'item/tool/requestUserInput',
      params: {
        threadId,
        turnId,
        itemId: 'tool-auto-snooze-item',
        autoResolutionMs: 3_000,
        questions: [
          {
            id: 'target',
            header: 'Target',
            question: 'Where should this run?',
            isOther: false,
            isSecret: false,
            options: null
          }
        ]
      }
    }
  }

  if (scenario === 'tool-option-terminal-timer-race') {
    return {
      id: approvalRequestId,
      method: 'item/tool/requestUserInput',
      params: {
        threadId,
        turnId,
        itemId: 'tool-terminal-timer-item',
        questions: [
          {
            id: 'environment',
            header: 'Environment',
            question: 'Choose an environment',
            isOther: false,
            isSecret: false,
            options: [{ label: 'staging', description: 'Pre-production' }]
          },
          {
            id: 'token',
            header: 'Token',
            question: 'Enter a token',
            isOther: false,
            isSecret: true,
            options: null
          }
        ]
      }
    }
  }

  if (scenario === 'mcp-typed-cancel') {
    return mcpFormRequest({
      mode: 'form',
      message: 'Typed cancellation',
      requestedSchema: {
        type: 'object',
        properties: { region: { type: 'string' } },
        required: ['region']
      }
    })
  }

  if (scenario === 'mcp-optional-number-empty') {
    return mcpFormRequest({
      mode: 'form',
      message: 'Optional numeric input',
      requestedSchema: {
        type: 'object',
        properties: {
          replicas: {
            type: 'integer',
            title: 'Replicas',
            minimum: 1,
            maximum: 10,
            default: 2
          }
        }
      }
    })
  }

  if (scenario === 'mcp-openai-supported') {
    return mcpFormRequest({
      mode: 'openai/form',
      message: 'OpenAI deployment',
      requestedSchema: {
        type: 'object',
        properties: {
          email: { type: 'string', title: 'Email', format: 'email' },
          replicas: { type: 'integer', title: 'Replicas', minimum: 1, maximum: 4, default: 2 },
          theme: {
            type: 'openai/imagePicker',
            title: 'Theme',
            items: [
              { id: 'light', title: 'Light', image: 'data:image/png;base64,AA==' },
              { id: 'dark', title: 'Dark', image: 'data:image/png;base64,AA==' }
            ]
          }
        },
        required: ['email', 'theme']
      }
    })
  }

  if (scenario === 'mcp-openai-unsupported-skip' || scenario === 'mcp-openai-unsupported-dismiss') {
    return mcpFormRequest({
      mode: 'openai/form',
      message: 'Unsupported OpenAI deployment',
      requestedSchema: {
        type: 'object',
        properties: { unsafe: { type: 'object', properties: { nested: { type: 'string' } } } }
      }
    })
  }

  if (
    scenario === 'mcp-url-open-continue' ||
    scenario === 'mcp-url-invalid' ||
    scenario === 'mcp-url-decline'
  ) {
    return {
      id: approvalRequestId,
      method: 'mcpServer/elicitation/request',
      params: {
        threadId,
        turnId,
        serverName: 'browser',
        mode: 'url',
        message: 'Complete browser sign in',
        url:
          scenario === 'mcp-url-invalid'
            ? 'file:///private/tmp/unsafe'
            : 'http://127.0.0.1:9/e2e-auth',
        elicitationId: 'url-elicit-1'
      }
    }
  }

  if (scenario === 'mcp') {
    return {
      id: approvalRequestId,
      method: 'mcpServer/elicitation/request',
      params: {
        threadId,
        turnId,
        serverName: 'deployments',
        mode: 'form',
        message: 'Choose deployment settings',
        requestedSchema: {
          type: 'object',
          properties: {
            features: {
              type: 'array',
              items: { type: 'string', enum: ['logs', 'metrics'] },
              minItems: 1
            },
            replicas: { type: 'integer', minimum: 1, maximum: 10, default: 2 },
            dryRun: { type: 'boolean', default: true }
          },
          required: ['features']
        }
      }
    }
  }

  throw new Error(`Unsupported approval scenario: ${scenario}`)
}

function mcpFormRequest({ mode, message, requestedSchema }) {
  return {
    id: approvalRequestId,
    method: 'mcpServer/elicitation/request',
    params: {
      threadId,
      turnId,
      serverName: 'deployments',
      mode,
      message,
      requestedSchema
    }
  }
}
