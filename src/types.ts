export type CueStatus = 'draft' | 'reviewed' | 'issue'
export type Locale = 'zh-CN' | 'en-US' | 'ja-JP'

export interface Cue {
  id: string
  start: number
  end: number
  source: string
  target: string
  actorId: string
  speed: number
  termIds: string[]
  status: CueStatus
  locked: boolean
  /** 分条修订号：该条台词最后被写入时的文档版本，用于逐台词三方合并 */
  cueRev?: number
}

export interface Actor {
  id: string
  name: string
  color: string
  localeHint: string
}

export interface Term {
  id: string
  source: string
  target: string
  note: string
}

export interface Snapshot {
  id: string
  name: string
  createdAt: number
  cues: Cue[]
}

export interface EditorDocument {
  id: string
  title: string
  language: Locale
  cues: Cue[]
  actors: Actor[]
  terms: Term[]
  snapshots: Snapshot[]
  updatedAt: number
  revision: number
  lastWriter: string
}

export interface CueConflict {
  cueId: string
  type: 'actor' | 'tone' | 'address'
  message: string
}

export interface HistoryEntry {
  label: string
  cues: Cue[]
  selectedCueId: string | null
}

/** 台词上参与逐条合并的字段 */
export type CueField = 'start' | 'end' | 'source' | 'target' | 'actorId' | 'speed' | 'termIds' | 'status' | 'locked'

export const CUE_FIELDS: CueField[] = ['start', 'end', 'source', 'target', 'actorId', 'speed', 'termIds', 'status', 'locked']

/** 同一处被两边都改了、需要人工挑选的字段 */
export interface FieldConflict {
  field: CueField
  baseValue: unknown
  localValue: unknown
  remoteValue: unknown
  /** 用户当前选择：local / remote，默认本页 */
  resolution?: 'local' | 'remote'
}

/**
 * 一条台词的合并冲突：
 * kind = 'fields' 时同一条台词上至少一个字段被两边同时修改（删除 vs 修改也归入此项）；
 * kind = 'add' 表示两边用同一 id 新增了内容不同的台词（旧稿没有分条记录时的罕见情形）。
 */
export interface CueMergeConflict {
  cueId: string
  kind: 'fields' | 'add' | 'delete'
  fields: FieldConflict[]
  /** 合并基点（旧稿升级后可能为 undefined，等价于两边都没有） */
  base: Cue | undefined
  /** 本页的内容；删除 vs 修改冲突中本地删除时为 undefined */
  local: Cue | undefined
  /** 对方保存的内容；删除 vs 修改冲突中远端删除时为 undefined */
  remote: Cue | undefined
  /** 触发本次冲突时该条在本页列表中的位置，用于单条重试时重新插回 */
  index: number
  /** 删除 vs 修改冲突时用户的选择：保留修改后的内容 / 确认删除 */
  deleteChoice?: 'keep' | 'delete'
}

/** 待解决冲突的持久化记录（刷新后仍可继续挑选、单条重试） */
export interface PendingMergeState {
  id: string
  baseRevision: number
  conflicts: CueMergeConflict[]
  updatedAt: number
}
