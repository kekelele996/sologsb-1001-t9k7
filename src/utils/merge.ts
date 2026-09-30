import type { Cue, CueField, CueMergeConflict, EditorDocument, FieldConflict } from '../types'
import { CUE_FIELDS } from '../types'

const deepEqual = (a: unknown, b: unknown): boolean => {
  if (a === b) return true
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((value, index) => deepEqual(value, b[index]))
  }
  return false
}

const strip = (cue: Cue): Cue => {
  const { cueRev: _cueRev, ...rest } = cue
  void _cueRev
  return rest as Cue
}

/** 同一条台词、同一处（字段）是否被两边都改过 */
const changedFields = (base: Cue | undefined, side: Cue | undefined): CueField[] => {
  if (!side || !base) return []
  return CUE_FIELDS.filter((field) => !deepEqual(base[field], side[field]))
}

const buildFieldConflicts = (
  base: Cue | undefined,
  local: Cue | undefined,
  remote: Cue | undefined,
  fields: CueField[],
  defaultSide: 'local' | 'remote' = 'local',
): FieldConflict[] => fields.map((field) => ({
  field,
  baseValue: base ? base[field] : undefined,
  localValue: local ? local[field] : undefined,
  remoteValue: remote ? remote[field] : undefined,
  // 删除 vs 修改时，缺省保留"仍存在的一方"（修改方），删除必须由用户显式确认
  resolution: defaultSide,
}))

/** 以 base 顺序为锚的 id 序列三方对齐（diff3 的精简版，只关心 id） */
interface AlignedRow {
  id: string
  base?: Cue
  local?: Cue
  remote?: Cue
  localDeleted?: boolean
  remoteDeleted?: boolean
  /** 该 id 在本页列表中的下标，供冲突单条重试定位 */
  index: number
}

/** 两个 id 序列的最长公共子序列表 */
const lcsTable = (a: string[], b: string[]): number[][] => {
  const table = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0))
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      table[i][j] = a[i] === b[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1])
    }
  }
  return table
}

const alignCues = (
  base: Cue[],
  local: Cue[],
  remote: Cue[],
  localIds: string[],
  remoteIds: string[],
): AlignedRow[] => {
  const baseById = new Map(base.map((cue) => [cue.id, cue]))
  const localById = new Map(local.map((cue) => [cue.id, cue]))
  const remoteById = new Map(remote.map((cue) => [cue.id, cue]))
  const baseIds = base.map((cue) => cue.id)
  const table = lcsTable(localIds, remoteIds)
  const rows: AlignedRow[] = []
  const seen = new Set<string>()

  const push = (id: string, index: number) => {
    if (seen.has(id)) return
    seen.add(id)
    rows.push({
      id,
      base: baseById.get(id),
      local: localById.get(id),
      remote: remoteById.get(id),
      localDeleted: baseById.has(id) && !localById.has(id),
      remoteDeleted: baseById.has(id) && !remoteById.has(id),
      index,
    })
  }

  // 沿 LCS 回溯，把两边各自独有的片段按稳定位置交错插入
  let bi = 0
  let i = 0
  let j = 0
  let localIndex = 0
  const consumeLocal = (upTo: number) => {
    for (; localIndex < upTo; localIndex += 1) push(localIds[localIndex], localIndex)
  }
  const consumeBaseGaps = () => {
    // 基点里有、但当前 LCS 片段中两边都还没出现的 id（通常是被删的），按基点顺序补在锚点前
    while (bi < baseIds.length) {
      const id = baseIds[bi]
      if (localIds.includes(id) || remoteIds.includes(id)) break
      bi += 1
      push(id, Math.max(0, rows.length))
    }
  }
  while (i < localIds.length && j < remoteIds.length) {
    if (localIds[i] === remoteIds[j]) {
      consumeLocal(i)
      consumeBaseGaps()
      const id = localIds[i]
      bi = Math.max(bi, baseIds.indexOf(id) + 1)
      push(id, localIndex)
      localIndex = i + 1
      i += 1
      j += 1
      continue
    }
    if (table[i + 1][j] >= table[i][j + 1]) {
      i += 1
    } else {
      // 远端独有：插在当前本页位置处
      const id = remoteIds[j]
      if (!seen.has(id)) {
        consumeLocal(i)
        push(id, Math.min(i, localIds.length))
      }
      j += 1
    }
  }
  consumeLocal(localIds.length)
  for (; j < remoteIds.length; j += 1) push(remoteIds[j], localIds.length)
  // 基点末尾被删除的台词
  for (; bi < baseIds.length; bi += 1) push(baseIds[bi], rows.length)
  return rows
}

export interface MergeResult {
  document: EditorDocument
  conflicts: CueMergeConflict[]
  /** 被本页删除、但远端同时修改，尚未确认前在文档中保留远端值的台词 id */
  keptByDeleteConflict: string[]
}

/**
 * 逐台词三方合并：
 * - 只有一边动过的台词直接写入；
 * - 同一条台词不同字段被两边修改，各写字段；
 * - 同一条同一处（字段）被两边都改成不同内容，列入冲突交用户挑选；
 * - 删除与修改同时发生也停下询问（保留修改 / 确认删除）。
 */
export const mergeDocuments = (
  localDocInput: EditorDocument,
  remoteDocInput: EditorDocument,
  baseDocInput: EditorDocument,
  revision: number,
): MergeResult => {
  // 入口纯净化：调用方可能传入 Vue reactive 对象，字段引用若原样落库会无法结构化克隆
  const localDoc = JSON.parse(JSON.stringify(localDocInput)) as EditorDocument
  const remoteDoc = JSON.parse(JSON.stringify(remoteDocInput)) as EditorDocument
  const baseDoc = JSON.parse(JSON.stringify(baseDocInput)) as EditorDocument
  const localIds = localDoc.cues.map((cue) => cue.id)
  const remoteIds = remoteDoc.cues.map((cue) => cue.id)
  const aligned = alignCues(baseDoc.cues, localDoc.cues, remoteDoc.cues, localIds, remoteIds)

  const mergedCues: Cue[] = []
  const conflicts: CueMergeConflict[] = []
  const keptByDeleteConflict: string[] = []

  for (const row of aligned) {
    const { base, local, remote } = row
    const localChanged = changedFields(base, local)
    const remoteChanged = changedFields(base, remote)
    const localTouched = base ? localChanged.length > 0 : !!local
    const remoteTouched = base ? remoteChanged.length > 0 : !!remote
    const bothEdited = !!local && !!remote && base
      ? localChanged.length > 0 && remoteChanged.length > 0
      : !!local && !!remote && !deepEqual(strip(local), strip(remote))

    // 两边都删除
    if (row.localDeleted && row.remoteDeleted) continue
    // 只有一边删除
    if (row.localDeleted !== row.remoteDeleted) {
      const editorSide = row.localDeleted ? remote : local
      const otherChangedFields = base && editorSide ? changedFields(base, editorSide) : []
      if (otherChangedFields.length > 0) {
        // 删除 vs 修改：停下来询问。未决前保留被修改的内容，避免静默丢失
        const cue = editorSide as Cue
        mergedCues.push({ ...cue, cueRev: revision })
        keptByDeleteConflict.push(cue.id)
        conflicts.push({
          cueId: cue.id,
          kind: 'delete',
          fields: buildFieldConflicts(base, local, remote, otherChangedFields, row.localDeleted ? 'remote' : 'local'),
          base,
          local,
          remote,
          index: row.index,
        })
        continue
      }
      // 另一边没动过内容：删除生效
      continue
    }

    if (!local && !remote) continue

    if (bothEdited) {
      if (!base) {
        // 同 id 新增但内容不同（无分条基点的罕见情况）
        const same = deepEqual(strip(local as Cue), strip(remote as Cue))
        if (!same) {
          const fields = CUE_FIELDS.filter((field) => !deepEqual((local as Cue)[field], (remote as Cue)[field]))
          conflicts.push({
            cueId: (local as Cue).id,
            kind: 'add',
            fields: buildFieldConflicts(undefined, local, remote, fields),
            base: undefined,
            local,
            remote,
            index: row.index,
          })
          // 未决前先放远端内容，本页内容保留在冲突记录里
          mergedCues.push({ ...(remote as Cue), cueRev: revision })
          continue
        }
        mergedCues.push({ ...(remote as Cue), cueRev: revision })
        continue
      }
      const clashing = localChanged.filter((field) => remoteChanged.includes(field) && !deepEqual((local as Cue)[field], (remote as Cue)[field]))
      if (clashing.length > 0) {
        conflicts.push({
          cueId: (local as Cue).id,
          kind: 'fields',
          fields: buildFieldConflicts(base, local, remote, clashing),
          base,
          local,
          remote,
          index: row.index,
        })
      }
      // 逐字段写入：本页独改取本页，对方独改取对方，同改一致任取，冲突字段暂取远端
      const merged = { ...(remote as Cue) } as Record<CueField, unknown>
      const localCue = local as Cue
      const remoteCue = remote as Cue
      const baseCue = base as Cue
      for (const field of CUE_FIELDS) {
        const localTouched = localChanged.includes(field)
        const remoteTouched = remoteChanged.includes(field)
        if (localTouched && remoteTouched) {
          merged[field] = deepEqual(localCue[field], remoteCue[field])
            ? localCue[field]
            : clashing.includes(field)
              ? remoteCue[field]
              : localCue[field]
        } else if (localTouched) {
          merged[field] = localCue[field]
        } else if (remoteTouched) {
          merged[field] = remoteCue[field]
        } else {
          merged[field] = baseCue[field]
        }
      }
      mergedCues.push({ ...(merged as unknown as Cue), cueRev: revision })
      continue
    }

    // 只有一边动过（含仅一边新增）：动的一方写入；两边都没动取任一边
    let winner: Cue | undefined
    if (localTouched && remoteTouched && deepEqual(strip(local as Cue), strip(remote as Cue))) {
      winner = local
    } else if (localTouched) {
      winner = local
    } else if (remoteTouched) {
      winner = remote
    } else {
      winner = local ?? remote
    }
    if (winner) mergedCues.push({ ...winner, cueRev: revision })
  }

  // 未参与冲突、且在基点中存在的台词，其分条修订号统一推进到新版本，
  // 表示该版本已成为下一轮合并的基点。
  const conflictIds = new Set(conflicts.map((item) => item.cueId))
  const finalCues = mergedCues.map((cue) => (conflictIds.has(cue.id) ? cue : { ...cue, cueRev: revision }))

  // 文档级元数据同样按基点三方合并（改的是同一属性时本页优先）
  const pickScalar = <T>(baseValue: T, localValue: T, remoteValue: T): T =>
    deepEqual(baseValue, localValue) ? remoteValue : localValue

  const actors = localDoc.actors.length === baseDoc.actors.length && deepEqual(localDoc.actors, baseDoc.actors)
    ? remoteDoc.actors
    : localDoc.actors
  const terms = localDoc.terms.length === baseDoc.terms.length && deepEqual(localDoc.terms, baseDoc.terms)
    ? remoteDoc.terms
    : localDoc.terms
  const snapshots = remoteDoc.snapshots.length >= localDoc.snapshots.length ? remoteDoc.snapshots : localDoc.snapshots

  const merged: EditorDocument = {
    ...remoteDoc,
    title: pickScalar(baseDoc.title, localDoc.title, remoteDoc.title),
    language: pickScalar(baseDoc.language, localDoc.language, remoteDoc.language),
    actors,
    terms,
    snapshots,
    cues: finalCues,
    revision,
    updatedAt: Date.now(),
    lastWriter: localDoc.lastWriter,
  }
  return { document: merged, conflicts, keptByDeleteConflict }
}

/** 用用户对冲突字段的选择生成该条台词的最终内容；deleteChoice='delete' 时返回 null 表示删除 */
export const resolveCueConflict = (conflict: CueMergeConflict): Cue | null => {
  if (conflict.kind === 'delete' && conflict.deleteChoice === 'delete') return null
  const base = conflict.base
  const local = conflict.local
  const remote = conflict.remote
  if (conflict.kind === 'add' || !base || !local || !remote) {
    // 无基点：按字段选择拼出结果，未冲突字段两边一致
    const chosen = { ...(remote ?? local) } as unknown as Record<CueField, unknown>
    for (const fieldConflict of conflict.fields) {
      chosen[fieldConflict.field] = fieldConflict.resolution === 'remote' ? fieldConflict.remoteValue : fieldConflict.localValue
    }
    return chosen as unknown as Cue
  }
  const localChanged = changedFields(base, local)
  const remoteChanged = changedFields(base, remote)
  const resolved = { ...remote } as unknown as Record<CueField, unknown>
  for (const field of CUE_FIELDS) {
    const fieldConflict = conflict.fields.find((item) => item.field === field)
    if (fieldConflict) {
      resolved[field] = fieldConflict.resolution === 'remote' ? fieldConflict.remoteValue : fieldConflict.localValue
    } else if (localChanged.includes(field)) {
      resolved[field] = local[field]
    } else if (remoteChanged.includes(field)) {
      resolved[field] = remote[field]
    } else {
      resolved[field] = base[field]
    }
  }
  return resolved as unknown as Cue
}
