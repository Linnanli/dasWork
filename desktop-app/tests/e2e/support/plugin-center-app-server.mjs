#!/usr/bin/env node
/* eslint-disable @typescript-eslint/explicit-function-return-type -- Test-only JSON-RPC peer. */

import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { createInterface } from 'node:readline'

const statePath = process.env.DASCOWORK_E2E_PLUGIN_CENTER_STATE_PATH
const rpcLogPath = process.env.DASCOWORK_E2E_PLUGIN_CENTER_RPC_LOG_PATH
const pluginListDelayMs = nonNegativeInteger(process.env.DASCOWORK_E2E_PLUGIN_CENTER_LIST_DELAY_MS)
const appReadUnsupported = process.env.DASCOWORK_E2E_PLUGIN_CENTER_APP_READ_UNSUPPORTED === '1'
const extraPluginCount = nonNegativeInteger(
  process.env.DASCOWORK_E2E_PLUGIN_CENTER_EXTRA_PLUGIN_COUNT
)

if (!statePath || !rpcLogPath) {
  throw new Error('Plugin Center E2E app-server requires state and RPC log paths.')
}

const input = createInterface({ input: process.stdin, crlfDelay: Infinity })

input.on('line', (line) => {
  const message = JSON.parse(line)
  if (message.method) logRpc(message)

  if (message.method === 'initialize') {
    respond(message.id, { serverInfo: { name: 'e2e-plugin-center', version: '1.0.0' } })
    return
  }

  try {
    switch (message.method) {
      case 'plugin/list':
        respondDelayed(message.id, pluginList(loadState()), pluginListDelayMs)
        return
      case 'plugin/installed':
        respond(message.id, installedPlugins(loadState()))
        return
      case 'plugin/read':
        respond(message.id, { plugin: pluginDetail(message.params?.pluginName) })
        return
      case 'plugin/install':
        respond(message.id, installPlugin(message.params))
        return
      case 'skills/list':
        respond(message.id, skillsList())
        return
      case 'skills/config/write':
        respond(message.id, { status: 'ok' })
        return
      case 'app/list':
        respond(message.id, appsList())
        return
      case 'app/read':
        if (appReadUnsupported) {
          emit({
            id: message.id,
            error: { code: -32_600, message: 'Invalid request: unknown variant `app/read`' }
          })
          return
        }
        respond(message.id, appsRead(message.params))
        return
      case 'mcpServerStatus/list':
        respond(message.id, mcpServerStatus(loadState()))
        return
      case 'config/read':
        respond(message.id, configRead(loadState()))
        return
      case 'config/batchWrite':
        respond(message.id, applyConfigWrite(message.params))
        return
      case 'config/mcpServer/reload':
        respond(message.id, {})
        return
      case 'marketplace/add':
        respond(message.id, addMarketplace(message.params))
        return
      case 'thread/start':
        respond(message.id, { threadId: 'e2e-plugin-center-thread' })
        return
      case 'thread/resume':
        respond(message.id, { thread: { id: 'e2e-plugin-center-thread' } })
        return
      case 'turn/start':
        respond(message.id, { turnId: 'e2e-plugin-center-turn' })
        emit({
          method: 'turn/completed',
          params: {
            threadId: 'e2e-plugin-center-thread',
            turn: { id: 'e2e-plugin-center-turn', status: 'completed' }
          }
        })
        return
      default:
        if (message.id !== undefined) respond(message.id, {})
    }
  } catch (error) {
    emit({
      id: message.id,
      error: {
        code: -32_000,
        message: error instanceof Error ? error.message : String(error)
      }
    })
  }
})

function respond(id, result) {
  emit({ id, result })
}

function respondDelayed(id, result, delayMs) {
  if (delayMs <= 0) {
    respond(id, result)
    return
  }
  setTimeout(() => respond(id, result), delayMs)
}

function emit(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`)
}

function logRpc(message) {
  appendFileSync(
    rpcLogPath,
    `${JSON.stringify({
      method: message.method,
      params: message.params ?? null
    })}\n`,
    'utf8'
  )
}

function defaultState() {
  return {
    availableInstalled: false,
    installedEnabled: true,
    marketplaces: ['e2e-market'],
    mcpServers: {
      local_tools: {
        command: 'node',
        args: ['tools-server.js'],
        env: { EXISTING_TOKEN: 'secret' },
        env_vars: ['PATH'],
        enabled: true
      }
    },
    configVersion: '1'
  }
}

function loadState() {
  if (!existsSync(statePath)) {
    const state = defaultState()
    saveState(state)
    return state
  }
  return JSON.parse(readFileSync(statePath, 'utf8'))
}

function saveState(state) {
  writeFileSync(statePath, JSON.stringify(state, null, 2), 'utf8')
}

function pluginList(state) {
  return {
    featuredPluginIds: ['available-plugin'],
    marketplaceLoadErrors: [],
    marketplaces: state.marketplaces.map((name) => ({
      name,
      path: '',
      plugins: pluginsForState(state)
    }))
  }
}

function installedPlugins(state) {
  return {
    marketplaces: [
      {
        name: 'e2e-market',
        path: '',
        plugins: pluginsForState(state).filter((plugin) => plugin.installed)
      }
    ]
  }
}

function pluginsForState(state) {
  const plugins = [
    {
      id: 'available-plugin',
      name: 'available-plugin',
      version: '1.0.0',
      installed: state.availableInstalled,
      enabled: state.availableInstalled,
      availability: 'AVAILABLE',
      installPolicy: 'AVAILABLE',
      source: { type: 'remote' },
      keywords: ['e2e'],
      interface: {
        displayName: 'E2E Installable Plugin',
        shortDescription: 'Install target from the app-server fixture.',
        longDescription: 'Use the E2E fixture to inspect a repository.',
        category: 'Developer',
        developerName: 'DasCowork E2E',
        capabilities: ['Repository access', 'Pull request review'],
        defaultPrompt: ['Review this repository'],
        websiteUrl: 'https://example.test/e2e-plugin',
        privacyPolicyUrl: 'https://example.test/privacy',
        termsOfServiceUrl: 'https://example.test/terms',
        brandColor: '#2463eb'
      }
    },
    {
      id: 'installed-plugin',
      name: 'installed-plugin',
      version: '2.0.0',
      installed: true,
      enabled: state.installedEnabled,
      availability: 'AVAILABLE',
      installPolicy: 'AVAILABLE',
      source: { type: 'remote' },
      keywords: ['manage'],
      interface: {
        displayName: 'E2E Installed Plugin',
        shortDescription: 'Manage target from the app-server fixture.',
        longDescription: 'Manage the installed E2E fixture plugin.',
        category: 'Developer',
        developerName: 'DasCowork E2E',
        capabilities: ['Repository access'],
        defaultPrompt: ['Inspect the installed plugin'],
        websiteUrl: 'https://example.test/e2e-plugin',
        brandColor: '#2463eb'
      }
    }
  ]
  for (let index = 0; index < extraPluginCount; index += 1) {
    plugins.push({
      id: `bulk-plugin-${index}`,
      name: `bulk-plugin-${index}`,
      version: '1.0.0',
      installed: false,
      enabled: false,
      availability: 'AVAILABLE',
      installPolicy: 'AVAILABLE',
      source: { type: 'remote' },
      keywords: ['bulk'],
      interface: {
        displayName: `Bulk Plugin ${index}`,
        shortDescription: 'Bulk plugin for performance fixtures.',
        category: index % 2 === 0 ? 'Developer' : 'Productivity'
      }
    })
  }
  return plugins
}

function nonNegativeInteger(value) {
  const parsed = Number(value ?? 0)
  if (!Number.isFinite(parsed) || parsed < 0) return 0
  return Math.floor(parsed)
}

function pluginDetail(pluginName) {
  const state = loadState()
  const name = pluginName || 'installed-plugin'
  const summary = pluginsForState(state).find((plugin) => plugin.name === name)
  if (!summary) throw new Error(`Unknown fixture plugin: ${name}`)
  return {
    summary,
    description: 'Use the E2E fixture to inspect a repository.',
    apps: [
      {
        id: 'e2e-app',
        name: 'Fixture App',
        description: 'Find and reference emails from your inbox.',
        category: 'Developer',
        installUrl: 'https://example.test/fixture-app'
      }
    ],
    skills: [
      {
        name: `${name}:review`,
        path: `/plugins/${name}/skills/review/SKILL.md`,
        description: 'Review with the installed plugin.',
        enabled: true,
        interface: { displayName: `${name} review` }
      }
    ],
    mcpServers: [`${name}-mcp`]
  }
}

function installPlugin(params) {
  const state = loadState()
  if (params?.pluginName === 'available-plugin') state.availableInstalled = true
  saveState(state)
  return { status: 'installed' }
}

function skillsList() {
  return {
    data: [
      {
        cwd: '/tmp/e2e-plugin-center',
        skills: [
          {
            name: 'workspace-skill',
            path: '/tmp/e2e-plugin-center/.codex/skills/workspace-skill/SKILL.md',
            shortDescription: 'Workspace Skill',
            description: 'Skill returned by skills/list.',
            scope: 'repo',
            enabled: true
          }
        ]
      }
    ]
  }
}

function appsList() {
  return {
    data: [
      {
        id: 'e2e-app',
        name: 'E2E App',
        description: 'App returned by app/list.',
        installUrl: 'https://example.test/fixture-app',
        isEnabled: true,
        isAccessible: false,
        pluginDisplayNames: ['E2E Installed Plugin'],
        logoUrl: null,
        logoUrlDark: null
      }
    ],
    nextCursor: null
  }
}

function appsRead(params) {
  const requestedIds = new Set(params?.appIds ?? [])
  return {
    apps: appsList()
      .data.filter((app) => requestedIds.has(app.id))
      .map((app) => ({
        ...app,
        name: 'E2E App from app/read',
        description: 'Short description returned by app/read.'
      }))
  }
}

function mcpServerStatus(state) {
  return {
    data: Object.keys(state.mcpServers).map((name) => ({
      name,
      serverInfo: { name, version: '1.0.0' },
      authStatus: 'unsupported',
      tools: { ping: { name: 'ping' } }
    })),
    nextCursor: null
  }
}

function configRead(state) {
  return {
    config: { mcp_servers: state.mcpServers },
    layers: [
      {
        name: { type: 'user' },
        version: state.configVersion,
        config: { mcp_servers: state.mcpServers }
      }
    ]
  }
}

function applyConfigWrite(params) {
  const state = loadState()
  for (const edit of params?.edits ?? []) {
    applyEdit(state, edit)
  }
  state.configVersion = String(Number(state.configVersion) + 1)
  saveState(state)
  return { status: 'ok' }
}

function applyEdit(state, edit) {
  const value = edit.value
  const enabledMatch = /^mcp_servers\.(".*"|[^.]+)\.enabled$/.exec(edit.keyPath)
  if (enabledMatch) {
    const serverName = unquoteKeySegment(enabledMatch[1])
    state.mcpServers[serverName].enabled = value
    return
  }
  const serverMatch = /^mcp_servers\.(.+)$/.exec(edit.keyPath)
  if (serverMatch) {
    const serverName = unquoteKeySegment(serverMatch[1])
    if (value === null) delete state.mcpServers[serverName]
    else state.mcpServers[serverName] = value
    return
  }
  if (edit.keyPath === 'plugins.installed-plugin.enabled') {
    state.installedEnabled = value
  }
}

function unquoteKeySegment(value) {
  if (!value.startsWith('"')) return value
  return JSON.parse(value)
}

function addMarketplace(params) {
  const state = loadState()
  const source = params?.source || 'unknown-marketplace'
  const marketplaceName = source.replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-|-$/g, '')
  const alreadyAdded = state.marketplaces.includes(marketplaceName)
  if (!alreadyAdded) state.marketplaces.push(marketplaceName)
  saveState(state)
  return { marketplaceName, alreadyAdded }
}
