import type { Cue, CueMergeConflict, EditorDocument } from '../types'
import { makeId } from './id'

/** Scalar cue fields that can collide independently. */
const SCALAR_FIELDS = ['start', 'end', 'source', 'target', 'actorId', 'speed', 'status', 'locked'] as const

/** Marker for a delete-vs-modify collision. */
export const DELETE_FIELD = '__delete__'

export const cloneCue = (cue: Cue): Cue => JSON.parse(JSON.stringify(cue)) as Cue

const setsEqual = (a: string[], b: string[]): boolean => {
  if (a.length !== b.length) return false
  const set = new Set(a)
  return b.every((id) => set.has(id))
}

/** Content equality (ignores the per-cue revision). */
export const cueEquals = (a: Cue | undefined, b: Cue | undefined): boolean => {
  if (!a || !b) return a === b
  if (a.id !== b.id) return false
  for (const field of SCALAR_FIELDS) {
    if (a[field] !== b[field]) return false
  }
  return setsEqual(a.termIds, b.termIds)
}

const arraysEqual = (a: string[], b: string[]): boolean =>
  a.length === b.length && a.every((value, index) => value === b[index])

/** Normalize a cue loaded from an old draft (missing fields / no per-cue revision). */
const migrateCue = (raw: Partial<Cue>): Cue => ({
  id: String(raw.id ?? makeId('cue')),
  start: Number(raw.start ?? 0),
  end: Number(raw.end ?? 0),
  source: String(raw.source ?? ''),
  target: String(raw.target ?? ''),
  actorId: String(raw.actorId ?? 'actor-narrator'),
  speed: Number(raw.speed ?? 1),
  termIds: Array.isArray(raw.termIds) ? raw.termIds.map(String) : [],
  status: (['draft', 'reviewed', 'issue'].includes(String(raw.status)) ? raw.status : 'draft') as Cue['status'],
  locked: Boolean(raw.locked),
  rev: typeof raw.rev === 'number' ? raw.rev : 1,
})

/**
 * Upgrade a document read from IndexedDB so old drafts (no per-cue records,
 * missing fields) can still take part in per-cue merging.
 */
export const migrateDocument = (raw: EditorDocument): EditorDocument => {
  const doc = JSON.parse(JSON.stringify(raw)) as EditorDocument
  if (!Array.isArray(doc.cues)) doc.cues = []
  if (!Array.isArray(doc.actors)) doc.actors = []
  if (!Array.isArray(doc.terms)) doc.terms = []
  if (!Array.isArray(doc.snapshots)) doc.snapshots = []
  if (typeof doc.title !== 'string') doc.title = ''
  if (typeof doc.language !== 'string') doc.language = 'zh-CN'
  if (typeof doc.revision !== 'number') doc.revision = 0
  if (typeof doc.updatedAt !== 'number') doc.updatedAt = Date.now()
  if (typeof doc.lastWriter !== 'string') doc.lastWriter = ''
  doc.cues = doc.cues.map((cue) => migrateCue(cue))
  return doc
}

type Outcome =
  | { kind: 'keep'; cue: Cue }
  | { kind: 'drop' }
  | { kind: 'conflict'; conflict: CueMergeConflict; serverCue: Cue | undefined }

/** Three-way merge of a single cue. */
const mergeOne = (id: string, base: Cue | undefined, local: Cue | undefined, remote: Cue | undefined): Outcome => {
  if (local && remote) {
    if (!base) {
      // Both sides inserted the same id.
      if (cueEquals(local, remote)) return { kind: 'keep', cue: cloneCue(local) }
      return {
        kind: 'conflict',
        conflict: { cueId: id, fields: [...SCALAR_FIELDS, 'termIds'], base: cloneCue(local), local: cloneCue(local), remote: cloneCue(remote) },
        serverCue: cloneCue(remote),
      }
    }
    return mergeContent(id, base, local, remote)
  }
  if (local && !remote) {
    if (!base) return { kind: 'keep', cue: cloneCue(local) } // inserted locally
    // The other side deleted it.
    if (cueEquals(local, base)) return { kind: 'drop' } // local untouched → accept deletion
    // local modified vs remote deleted → conflict; server keeps the deletion until resolved.
    return {
      kind: 'conflict',
      conflict: { cueId: id, fields: [DELETE_FIELD], base: cloneCue(base), local: cloneCue(local), remote: undefined },
      serverCue: undefined,
    }
  }
  if (!local && remote) {
    if (!base) return { kind: 'keep', cue: cloneCue(remote) } // inserted remotely
    // We deleted it locally.
    if (cueEquals(remote, base)) return { kind: 'drop' } // remote untouched → accept deletion
    // remote modified vs local deleted → conflict; server keeps the remote version.
    return {
      kind: 'conflict',
      conflict: { cueId: id, fields: [DELETE_FIELD], base: cloneCue(base), local: undefined, remote: cloneCue(remote) },
      serverCue: cloneCue(remote),
    }
  }
  return { kind: 'drop' }
}

/** Field-level three-way merge for a cue present on both sides. */
const mergeContent = (id: string, base: Cue, local: Cue, remote: Cue): Outcome => {
  const localChanged = !cueEquals(local, base)
  const remoteChanged = !cueEquals(remote, base)
  if (!localChanged) return { kind: 'keep', cue: cloneCue(remote) }
  if (!remoteChanged) return { kind: 'keep', cue: cloneCue(local) }

  const merged = cloneCue(base)
  const target = merged as unknown as Record<string, unknown>
  const fields: string[] = []
  for (const field of SCALAR_FIELDS) {
    const localValue = local[field]
    const remoteValue = remote[field]
    const baseValue = base[field]
    if (localValue === baseValue) target[field] = remoteValue
    else if (remoteValue === baseValue) target[field] = localValue
    else if (localValue === remoteValue) target[field] = localValue
    else {
      fields.push(field)
      target[field] = remoteValue // default to the stored version until the user picks
    }
  }
  // termIds are an unordered set.
  const localTermsChanged = !setsEqual(local.termIds, base.termIds)
  const remoteTermsChanged = !setsEqual(remote.termIds, base.termIds)
  if (!localTermsChanged) merged.termIds = [...remote.termIds]
  else if (!remoteTermsChanged) merged.termIds = [...local.termIds]
  else if (setsEqual(local.termIds, remote.termIds)) merged.termIds = [...local.termIds]
  else {
    fields.push('termIds')
    merged.termIds = [...remote.termIds]
  }

  if (fields.length === 0) return { kind: 'keep', cue: merged }
  return {
    kind: 'conflict',
    conflict: { cueId: id, fields, base: cloneCue(base), local: cloneCue(local), remote: cloneCue(remote) },
    serverCue: cloneCue(remote),
  }
}

/** Longest common subsequence of two id lists, used as the ordering backbone. */
const lcsIds = (a: string[], b: string[]): string[] => {
  const m = a.length
  const n = b.length
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0))
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1] ? dp[i - 1][j - 1] + 1 : Math.max(dp[i - 1][j], dp[i][j - 1])
    }
  }
  const result: string[] = []
  let i = m
  let j = n
  while (i > 0 && j > 0) {
    if (a[i - 1] === b[j - 1]) {
      result.unshift(a[i - 1])
      i--
      j--
    } else if (dp[i - 1][j] >= dp[i][j - 1]) {
      i--
    } else {
      j--
    }
  }
  return result
}

/** Three-way merge of the cue ordering. */
const mergeOrder = (baseIds: string[], localIds: string[], remoteIds: string[]): string[] => {
  if (arraysEqual(localIds, baseIds)) return [...remoteIds]
  if (arraysEqual(remoteIds, baseIds)) return [...localIds]
  const lcs = lcsIds(localIds, remoteIds)
  const result: string[] = []
  const used = new Set<string>()
  let li = 0
  let ri = 0
  const push = (id: string) => {
    if (!used.has(id)) {
      used.add(id)
      result.push(id)
    }
  }
  for (const id of lcs) {
    while (li < localIds.length && localIds[li] !== id) {
      push(localIds[li])
      li++
    }
    while (ri < remoteIds.length && remoteIds[ri] !== id) {
      push(remoteIds[ri])
      ri++
    }
    push(id)
    li++
    ri++
  }
  while (li < localIds.length) {
    push(localIds[li])
    li++
  }
  while (ri < remoteIds.length) {
    push(remoteIds[ri])
    ri++
  }
  return result
}

export interface MergeResult {
  cues: Cue[]
  conflicts: CueMergeConflict[]
}

/**
 * Merge local edits into the latest stored document. Cues touched by only one
 * side are written through; cues touched by both sides at the same field are
 * reported as conflicts and left for the user to resolve.
 */
export const mergeCues = (base: Cue[], local: Cue[], remote: Cue[]): MergeResult => {
  const baseMap = new Map(base.map((cue) => [cue.id, cue]))
  const localMap = new Map(local.map((cue) => [cue.id, cue]))
  const remoteMap = new Map(remote.map((cue) => [cue.id, cue]))
  const mergedMap = new Map<string, Cue>()
  const conflicts: CueMergeConflict[] = []
  const allIds = new Set<string>([...baseMap.keys(), ...localMap.keys(), ...remoteMap.keys()])

  for (const id of allIds) {
    const outcome = mergeOne(id, baseMap.get(id), localMap.get(id), remoteMap.get(id))
    if (outcome.kind === 'keep') {
      mergedMap.set(id, outcome.cue)
    } else if (outcome.kind === 'conflict') {
      conflicts.push(outcome.conflict)
      if (outcome.serverCue) mergedMap.set(id, outcome.serverCue)
    }
  }

  const order = mergeOrder(base.map((cue) => cue.id), local.map((cue) => cue.id), remote.map((cue) => cue.id))
  const cues: Cue[] = []
  const seen = new Set<string>()
  for (const id of order) {
    const cue = mergedMap.get(id)
    if (cue && !seen.has(id)) {
      cues.push(cue)
      seen.add(id)
    }
  }
  for (const [id, cue] of mergedMap) {
    if (!seen.has(id)) {
      cues.push(cue)
      seen.add(id)
    }
  }
  return { cues, conflicts }
}

/** Assign per-cue revisions: unchanged cues keep theirs, changed cues bump. */
export const withRevisions = (merged: Cue[], remote: Cue[]): Cue[] => {
  const remoteMap = new Map(remote.map((cue) => [cue.id, cue]))
  return merged.map((cue) => {
    const previous = remoteMap.get(cue.id)
    if (previous && cueEquals(cue, previous)) return { ...cue, rev: previous.rev ?? 1 }
    return { ...cue, rev: (previous?.rev ?? 0) + 1 }
  })
}

/** Whether the merged cues differ from what is already stored (content or order). */
export const cuesChanged = (merged: Cue[], remote: Cue[]): boolean => {
  if (merged.length !== remote.length) return true
  const remoteMap = new Map(remote.map((cue) => [cue.id, cue]))
  if (merged.some((cue) => !remoteMap.has(cue.id))) return true
  for (const cue of merged) {
    const previous = remoteMap.get(cue.id)
    if (!previous || !cueEquals(cue, previous)) return true
  }
  return !arraysEqual(merged.map((cue) => cue.id), remote.map((cue) => cue.id))
}

/** Re-merge a single cue for a forced retry; reused by the store. */
export const mergeOneCue = (base: Cue | undefined, local: Cue | undefined, remote: Cue | undefined): Outcome =>
  mergeOne(local?.id ?? remote?.id ?? base?.id ?? 'unknown', base, local, remote)
