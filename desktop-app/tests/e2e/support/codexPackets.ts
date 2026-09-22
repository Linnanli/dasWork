type CodexPacket = {
  direction?: unknown
  message: {
    method: string
    params?: unknown
  }
}

const codexPacketMarker = '[codex packet] '

export function outboundCodexRequestParams(
  logs: readonly string[],
  method: string
): Array<Record<string, unknown>> {
  return logs.flatMap((line) => {
    const packet = codexPacketFromLog(line)
    if (
      packet?.direction !== 'outbound' ||
      packet.message.method !== method ||
      !isRecord(packet.message.params)
    ) {
      return []
    }
    return [packet.message.params]
  })
}

function codexPacketFromLog(line: string): CodexPacket | undefined {
  const markerIndex = line.indexOf(codexPacketMarker)
  if (markerIndex < 0) return undefined

  try {
    const packet = JSON.parse(line.slice(markerIndex + codexPacketMarker.length)) as unknown
    if (
      !isRecord(packet) ||
      !isRecord(packet.message) ||
      typeof packet.message.method !== 'string'
    ) {
      return undefined
    }
    return {
      direction: packet.direction,
      message: {
        method: packet.message.method,
        params: packet.message.params
      }
    }
  } catch {
    return undefined
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}
