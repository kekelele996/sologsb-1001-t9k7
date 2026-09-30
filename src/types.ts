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
  /** Per-cue revision. Increments only when this cue's content changes in a save. Missing on old drafts. */
  rev?: number
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

/** A per-cue save conflict: the same cue was changed on both sides at the same field. */
export interface CueMergeConflict {
  cueId: string
  /** Field names that collided; '__delete__' means one side deleted while the other modified. */
  fields: string[]
  /** The last synced state both sides started from. */
  base: Cue
  /** This tab's version; undefined if this side deleted the cue. */
  local: Cue | undefined
  /** The version already stored by the other tab; undefined if that side deleted the cue. */
  remote: Cue | undefined
}

export interface HistoryEntry {
  label: string
  cues: Cue[]
  selectedCueId: string | null
}
