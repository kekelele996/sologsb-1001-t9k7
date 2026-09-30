import type { Cue } from '../types'
import { makeId } from './id'

export const formatTime = (seconds: number, separator = ','): string => {
  const safe = Math.max(0, seconds)
  const h = Math.floor(safe / 3600)
  const m = Math.floor((safe % 3600) / 60)
  const s = Math.floor(safe % 60)
  const ms = Math.round((safe - Math.floor(safe)) * 1000)
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}${separator}${String(ms).padStart(3, '0')}`
}

export const parseTime = (value: string): number => {
  const normalized = value.trim().replace(',', '.')
  const parts = normalized.split(':').map(Number)
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2]
  if (parts.length === 2) return parts[0] * 60 + parts[1]
  return Number(normalized) || 0
}

export const parseSrt = (text: string, actorId = 'actor-narrator'): Cue[] => {
  const blocks = text.replace(/\r/g, '').split(/\n{2,}/)
  const parsed: Cue[] = []
  for (const block of blocks) {
    const lines = block.split('\n').filter(Boolean)
    const timeLineIndex = lines.findIndex((line) => line.includes('-->'))
    if (timeLineIndex < 0) continue
    const [from, to] = lines[timeLineIndex].split('-->').map((part) => part.trim().split(' ')[0])
    const content = lines.slice(timeLineIndex + 1).join('\n').trim()
    if (!content) continue
    parsed.push({
      id: makeId('cue'),
      start: parseTime(from),
      end: parseTime(to),
      source: content,
      target: '',
      actorId,
      speed: 1,
      termIds: [],
      status: 'draft',
      locked: false,
    })
  }
  return parsed
}

export const parseScript = (text: string, actors: { id: string; name: string }[]): Cue[] => {
  const lines = text.replace(/\r/g, '').split('\n').map((line) => line.trim()).filter(Boolean)
  const result: Cue[] = []
  lines.forEach((line, index) => {
    const match = line.match(/^([^：:]{1,18})[：:]\s*(.+)$/)
    const actorName = match?.[1]?.trim()
    const content = match?.[2]?.trim() || line
    const actor = actors.find((item) => item.name === actorName) ?? actors[0]
    result.push({
      id: makeId('cue'),
      start: index * 4,
      end: index * 4 + 3.5,
      source: content,
      target: '',
      actorId: actor?.id ?? 'actor-narrator',
      speed: 1,
      termIds: [],
      status: 'draft',
      locked: false,
    })
  })
  return result
}

export const toSrt = (cues: Cue[]): string =>
  [...cues]
    .sort((a, b) => a.start - b.start)
    .map((cue, index) => `${index + 1}\n${formatTime(cue.start)} --> ${formatTime(cue.end)}\n${cue.target || cue.source}`)
    .join('\n\n') + '\n'
