import { defineStore } from 'pinia'
import type { Cue, CueMergeConflict, EditorDocument, Locale, Snapshot } from '../types'
import { loadDocument, saveDocument, loadPendingMerge, savePendingMerge, deletePendingMerge } from '../utils/db'
import { makeId } from '../utils/id'
import { parseScript, parseSrt, toSrt } from '../utils/subtitle'
import { mergeDocuments, resolveCueConflict } from '../utils/merge'
import { translate, type MessageKey } from '../i18n'

const DOCUMENT_ID = 'subtitle-dubbing-document'
let saveTimer: ReturnType<typeof setTimeout> | undefined
let channel: BroadcastChannel | undefined
/** 当前进行中的保存 Promise（测试/调试时可 await 自动保存真正落库） */
let inflight: Promise<void> | undefined
export const pendingSave = () => inflight ?? Promise.resolve()

const cloneCues = (cues: Cue[]): Cue[] => JSON.parse(JSON.stringify(cues)) as Cue[]
const plainDocument = (document: EditorDocument): EditorDocument => JSON.parse(JSON.stringify(document)) as EditorDocument

/** 旧稿（没有分条记录）补全 cueRev，升级后仍可作为逐台词合并的基点 */
const ensureCueRevisions = (document: EditorDocument): EditorDocument => {
  let touched = false
  const cues = document.cues.map((cue) => {
    if (typeof cue.cueRev === 'number') return cue
    touched = true
    return { ...cue, cueRev: document.revision }
  })
  return touched ? { ...document, cues } : document
}

const createDefaultDocument = (): EditorDocument => ({
  id: DOCUMENT_ID,
  title: '纪录片《开源之路》中文配音',
  language: 'zh-CN',
  revision: 0,
  updatedAt: Date.now(),
  lastWriter: '',
  actors: [
    { id: 'actor-narrator', name: '旁白 / Narrator', color: '#2f6fed', localeHint: 'zh-CN' },
    { id: 'actor-lin', name: '林博士 / Dr. Lin', color: '#cf5a39', localeHint: 'zh-CN' },
    { id: 'actor-chen', name: '陈工 / Engineer Chen', color: '#14866d', localeHint: 'zh-CN' },
    { id: 'actor-host', name: '主持人 / Host', color: '#7d53b8', localeHint: 'zh-CN' },
  ],
  terms: [
    { id: 'term-01', source: 'open source', target: '开源', note: '产品语境' },
    { id: 'term-02', source: 'maintainer', target: '维护者', note: '不使用“管理者”' },
    { id: 'term-03', source: 'pull request', target: '拉取请求', note: '首次出现保留英文缩写 PR' },
    { id: 'term-04', source: 'community', target: '社区', note: '泛指开发者社区' },
  ],
  cues: [
    { id: 'cue-demo-01', start: 0, end: 4.2, source: '开源并不是一项孤立的技术，而是一种持续协作的方式。', target: '开源并不是一项孤立的技术，而是一种持续协作的方式。', actorId: 'actor-narrator', speed: 1.02, termIds: ['term-01'], status: 'reviewed', locked: true },
    { id: 'cue-demo-02', start: 4.3, end: 8.6, source: '今天，我们邀请林博士谈谈社区维护者每天面对的选择。', target: '今天，我们邀请林博士谈谈社区维护者每天面对的选择。', actorId: 'actor-host', speed: 1, termIds: ['term-04', 'term-02'], status: 'reviewed', locked: false },
    { id: 'cue-demo-03', start: 8.8, end: 13.5, source: '每个拉取请求背后，都有一段需要被理解的上下文。', target: '每个拉取请求背后，都有一段需要被理解的上下文。', actorId: 'actor-lin', speed: 0.96, termIds: ['term-03'], status: 'reviewed', locked: false },
    { id: 'cue-demo-04', start: 13.7, end: 18.8, source: '请您先介绍一次印象最深的代码评审。', target: '请您先介绍一次印象最深的代码评审。', actorId: 'actor-host', speed: 1.03, termIds: [], status: 'draft', locked: false },
    { id: 'cue-demo-05', start: 19, end: 25.1, source: '那次修改很小，却让新用户第一次能够顺利完成安装。', target: '那次修改很小，却让新用户第一次顺利完成安装。', actorId: 'actor-lin', speed: 0.98, termIds: [], status: 'issue', locked: false },
    { id: 'cue-demo-06', start: 25.4, end: 31.2, source: '所以我们决定把安装说明拆开，并为每个平台补上验证步骤。', target: '因此，我们拆分安装说明，并为每个平台补上验证步骤。', actorId: 'actor-chen', speed: 1.05, termIds: [], status: 'draft', locked: false },
  ],
  snapshots: [],
})

type SaveState = 'saved' | 'dirty' | 'saving' | 'conflict'

export const useEditorStore = defineStore('subtitle-editor', {
  state: () => ({
    document: createDefaultDocument(),
    selectedCueId: 'cue-demo-03' as string | null,
    actorFilter: 'all',
    timelineZoom: 1,
    saveState: 'saved' as SaveState,
    saving: false,
    initialized: false,
    conflict: false,
    conflictDialog: false,
    mergeConflicts: [] as CueMergeConflict[],
    online: navigator.onLine,
    tabId: makeId('tab'),
    lastSeenRevision: 0,
    mutationSerial: 0,
    /** 本页已确认的文档版本，作为逐台词三方合并的基点 */
    baseDocument: null as EditorDocument | null,
    /** 已收到其它标签页的更新通知、等待下次保存时合并 */
    remoteAhead: false,
    past: [] as { label: string; cues: Cue[]; selectedCueId: string | null }[],
    future: [] as { label: string; cues: Cue[]; selectedCueId: string | null }[],
  }),
  getters: {
    t: (state) => (key: MessageKey, values?: Record<string, string | number>) => translate(state.document.language, key, values),
    selectedCue(state): Cue | undefined {
      return state.document.cues.find((cue) => cue.id === state.selectedCueId)
    },
    visibleCues(state): Cue[] {
      return state.actorFilter === 'all'
        ? state.document.cues
        : state.document.cues.filter((cue) => cue.actorId === state.actorFilter)
    },
    totalDuration(state): number {
      return Math.max(10, ...state.document.cues.map((cue) => cue.end)) * 1.04
    },
  },
  actions: {
    async initialize() {
      if (this.initialized) return
      this.online = navigator.onLine
      const stored = await loadDocument(DOCUMENT_ID)
      if (stored) {
        // 旧稿没有分条修订记录：读出来时补全，之后即可参与逐台词合并
        const migrated = ensureCueRevisions(stored)
        if (migrated !== stored) {
          const next = await saveDocument(migrated, stored.revision)
          this.document = next
          this.lastSeenRevision = next.revision
        } else {
          this.document = migrated
          this.lastSeenRevision = migrated.revision
        }
      } else {
        const initial = ensureCueRevisions(plainDocument(this.document))
        const saved = await saveDocument(initial)
        this.document = saved
        this.lastSeenRevision = saved.revision
      }
      // 刷新后仍有未解决的冲突：恢复冲突面板，已写入的台词不退回
      const pending = await loadPendingMerge(DOCUMENT_ID)
      if (pending?.conflicts.length) {
        this.mergeConflicts = pending.conflicts
        this.conflict = true
        this.conflictDialog = true
        this.saveState = 'conflict'
      }
      this.baseDocument = plainDocument(this.document)
      this.initialized = true
      if ('BroadcastChannel' in window) {
        channel = new BroadcastChannel('sologsb-1001-document')
        channel.onmessage = async (event) => {
          const message = event.data as { type: string; tabId: string; revision: number; documentId: string }
          if (message.type !== 'document-updated' || message.tabId === this.tabId || message.documentId !== DOCUMENT_ID) return
          if (message.revision <= this.lastSeenRevision) return
          // 不整页判冲突：有未保存修改时由下次保存做逐台词合并；无修改时静默更新
          this.remoteAhead = true
          if (this.saveState !== 'dirty' && this.saveState !== 'saving' && !this.conflict) {
            const latest = await loadDocument(DOCUMENT_ID)
            if (latest && latest.revision > this.lastSeenRevision) {
              this.document = ensureCueRevisions(latest)
              this.lastSeenRevision = latest.revision
              this.baseDocument = plainDocument(latest)
              this.remoteAhead = false
              this.saveState = 'saved'
            }
          }
        }
      }
    },
    setOnline(value: boolean) {
      this.online = value
    },
    selectCue(id: string | null) {
      this.selectedCueId = id
    },
    setLocale(locale: Locale) {
      this.document.language = locale
      this.markChanged('language', true)
    },
    commit(label: string, mutate: (cues: Cue[]) => void, nextSelection?: string | null) {
      const before = cloneCues(this.document.cues)
      const working = cloneCues(this.document.cues)
      mutate(working)
      this.past.push({ label, cues: before, selectedCueId: this.selectedCueId })
      if (this.past.length > 60) this.past.shift()
      this.future = []
      this.document.cues = working
      if (nextSelection !== undefined) this.selectedCueId = nextSelection
      this.markChanged(label)
    },
    markChanged(label: string, persist = true) {
      this.document.updatedAt = Date.now()
      if (persist) {
        this.saveState = 'dirty'
        this.mutationSerial += 1
        if (saveTimer) clearTimeout(saveTimer)
        saveTimer = setTimeout(() => void this.persist(label), 500)
      }
    },
    async persist(label = 'autosave') {
      if (!this.initialized || this.saveState === 'saving') return
      const run = this.runPersist(label)
      inflight = run
      try {
        await run
      } finally {
        if (inflight === run) inflight = undefined
      }
    },
    async runPersist(label: string) {
      const serial = this.mutationSerial
      this.saveState = 'saving'
      this.saving = true
      try {
        // 未挑选的冲突条目维持对方内容，不会被本次保存静默提交；
        // 只保存用户另外修改的台词，冲突清单继续保留。
        const draft = this.buildLocalDraft()
        const result = await this.syncToRemote(draft)
        if (result) {
          this.document = ensureCueRevisions(result.document)
          const newIds = new Set(result.conflicts.map((item) => item.cueId))
          const preserved = this.conflict
            ? this.mergeConflicts.filter((item) => !newIds.has(item.cueId))
            : []
          this.applySyncResult({ document: result.document, conflicts: [...result.conflicts, ...preserved] }, serial)
        }
      } catch (error) {
        this.saveState = 'dirty'
        console.error(label, error)
      } finally {
        this.saving = false
        if (this.saveState === 'dirty') {
          if (saveTimer) clearTimeout(saveTimer)
          saveTimer = setTimeout(() => void this.persist(label), 1200)
        }
      }
    },
    /**
     * 保存的核心：乐观锁提交；若对方先保存，则读最新版做逐台词三方合并后重试。
     * 不同台词的修改各自写入，只有同一条同一处两边都改了才产生冲突。
     * 冲突不阻断其它台词的写入——合并结果（冲突字段暂取远端值）整体落库，
     * 冲突清单单独保存，用户挑完后只重试冲突条目。
     */
    async syncToRemote(localDraft: EditorDocument): Promise<{ document: EditorDocument; conflicts: CueMergeConflict[] } | null> {
      const attempt = async (doc: EditorDocument, expected: number) => {
        // 本次写入成功后，每条分条记录推进到新版本；JSON 拷贝确保不含 Vue 代理（IndexedDB 要求可结构化克隆）
        const clean = JSON.parse(JSON.stringify(doc)) as EditorDocument
        const stamped: EditorDocument = {
          ...clean,
          cues: clean.cues.map((cue) => ({ ...cue, cueRev: expected + 1 })),
        }
        return saveDocument({ ...stamped, lastWriter: this.tabId }, expected)
      }
      try {
        const next = await attempt(localDraft, this.lastSeenRevision)
        this.baseDocument = plainDocument(next)
        return { document: next, conflicts: [] }
      } catch (error) {
        if (!(error instanceof Error && error.message === 'REVISION_CONFLICT')) throw error
      }
      // 对方先写：逐台词合并（最多重试两轮，避免极端并发下死循环）
      for (let round = 0; round < 2; round += 1) {
        const remote = await loadDocument(DOCUMENT_ID)
        if (!remote) throw new Error('DOCUMENT_MISSING')
        const base = (this.baseDocument ?? this.document) as EditorDocument
        const merged = mergeDocuments(localDraft, ensureCueRevisions(remote), base, remote.revision + 1)
        try {
          const saved = await attempt(merged.document, remote.revision)
          this.baseDocument = plainDocument(saved)
          return { document: saved, conflicts: merged.conflicts }
        } catch (error) {
          if (!(error instanceof Error && error.message === 'REVISION_CONFLICT')) throw error
          // 又有人写入：以刚读到的远端为新基点再合并一次
          this.baseDocument = plainDocument(remote)
        }
      }
      // 持续并发：退回待保存，稍后由定时器重试，已落库的内容不受影响
      throw new Error('REVISION_CONFLICT')
    },
    /** 把本页视图与待解决冲突清单应用一次同步结果 */
    applySyncResult(result: { document: EditorDocument; conflicts: CueMergeConflict[] }, serial?: number) {
      const fresh = serial === undefined || serial === this.mutationSerial
      const wasConflict = this.conflict
      if (result.conflicts.length) {
        this.mergeConflicts = result.conflicts
        this.conflict = true
        this.saveState = 'conflict'
        // 仅在首次发现冲突时自动弹出面板；用户关掉后不再被自动保存打断
        this.conflictDialog = this.conflictDialog || !wasConflict
        void savePendingMerge({ id: DOCUMENT_ID, baseRevision: this.lastSeenRevision, conflicts: result.conflicts, updatedAt: Date.now() })
      } else {
        this.mergeConflicts = []
        this.conflict = false
        this.conflictDialog = false
        void deletePendingMerge(DOCUMENT_ID)
        this.saveState = fresh ? 'saved' : 'dirty'
      }
      this.lastSeenRevision = result.document.revision
      this.remoteAhead = false
      channel?.postMessage({ type: 'document-updated', tabId: this.tabId, revision: result.document.revision, documentId: DOCUMENT_ID })
    },
    /**
     * 用冲突记录里的本页内容（含用户选择）叠加出待保存草稿。
     * retryCueIds 给出本次要重试保存的冲突条目；不传则一条都不叠加，
     * 保证普通自动保存不会替用户对未挑选的冲突做决定。
     */
    buildLocalDraft(retryCueIds?: Set<string>): EditorDocument {
      const relevant = retryCueIds
        ? this.mergeConflicts.filter((item) => retryCueIds.has(item.cueId))
        : []
      if (!relevant.length) return ensureCueRevisions(plainDocument(this.document))
      const draft = ensureCueRevisions(plainDocument(this.document))
      const byId = new Map(draft.cues.map((cue) => [cue.id, cue]))
      for (const conflict of relevant) {
        const resolved = resolveCueConflict(conflict)
        const current = byId.get(conflict.cueId)
        if (resolved === null) {
          if (current) draft.cues.splice(draft.cues.indexOf(current), 1)
        } else if (current) {
          Object.assign(current, resolved)
        } else {
          // 删除 vs 修改冲突中本页已删掉该条：按基点位置插回
          const insertAt = Math.min(conflict.index, draft.cues.length)
          draft.cues.splice(insertAt, 0, resolved)
          byId.set(resolved.id, resolved)
        }
      }
      return draft
    },
    /** 冲突字段选择：两边内容逐条挑 */
    setConflictResolution(cueId: string, field: CueMergeConflict['fields'][number]['field'], side: 'local' | 'remote') {
      const conflict = this.mergeConflicts.find((item) => item.cueId === cueId)
      const fieldConflict = conflict?.fields.find((item) => item.field === field)
      if (fieldConflict) fieldConflict.resolution = side
    },
    setDeleteChoice(cueId: string, choice: 'keep' | 'delete') {
      const conflict = this.mergeConflicts.find((item) => item.cueId === cueId)
      if (conflict && conflict.kind === 'delete') conflict.deleteChoice = choice
    },
    /**
     * 冲突条目保存失败后单独重试：只把这一条（或一批）的选择重新合并。
     * 重试再失败，也不退回已经写入的其它台词——它们已经在库里。
     */
    async retryConflicts(cueIds?: string[]) {
      if (!this.mergeConflicts.length || this.saving) return
      const targets = cueIds ? new Set(cueIds) : new Set(this.mergeConflicts.map((item) => item.cueId))
      const draft = this.buildLocalDraft(targets)
      this.saving = true
      const serial = this.mutationSerial
      try {
        const result = await this.syncToRemote(draft)
        if (!result) return
        // 合并以整份文档为单位；仍未解决（远端又改了同一处）的条目继续保留
        const remaining = result.conflicts.filter((item) => targets.has(item.cueId))
        const untouched = this.mergeConflicts.filter((item) => !targets.has(item.cueId))
        const allRemaining = [...untouched, ...remaining]
        this.document = ensureCueRevisions(result.document)
        const hadDialog = this.conflictDialog
        this.applySyncResult({ document: result.document, conflicts: allRemaining }, serial)
        this.conflictDialog = allRemaining.length > 0 ? hadDialog : false
      } catch (error) {
        // 重试再失败：已写入的台词不回滚，只保留这些冲突条目稍后再试
        console.error('retry-conflict', error)
      } finally {
        this.saving = false
      }
    },
    /** 放弃本页对冲突条目的修改，直接采用对方保存的版本（不清动其它已写入台词） */
    async takeRemoteConflicts(cueIds?: string[]) {
      const targets = cueIds ? new Set(cueIds) : new Set(this.mergeConflicts.map((item) => item.cueId))
      const remaining = this.mergeConflicts.filter((item) => !targets.has(item.cueId))
      this.mergeConflicts = remaining
      this.conflict = remaining.length > 0
      this.saveState = remaining.length ? 'conflict' : 'saved'
      this.conflictDialog = remaining.length > 0
      if (remaining.length) {
        await savePendingMerge({ id: DOCUMENT_ID, baseRevision: this.lastSeenRevision, conflicts: remaining, updatedAt: Date.now() })
      } else {
        await deletePendingMerge(DOCUMENT_ID)
      }
    },
    async loadLatest() {
      const latest = await loadDocument(DOCUMENT_ID)
      if (!latest) return
      this.document = ensureCueRevisions(latest)
      this.baseDocument = plainDocument(latest)
      this.lastSeenRevision = latest.revision
      this.mergeConflicts = []
      this.conflict = false
      this.conflictDialog = false
      await deletePendingMerge(DOCUMENT_ID)
      this.saveState = 'saved'
      this.selectedCueId = latest.cues[0]?.id ?? null
    },
    undo() {
      const entry = this.past.pop()
      if (!entry) return
      this.future.push({ label: entry.label, cues: cloneCues(this.document.cues), selectedCueId: this.selectedCueId })
      this.document.cues = cloneCues(entry.cues)
      this.selectedCueId = entry.selectedCueId
      this.markChanged(`undo:${entry.label}`)
    },
    redo() {
      const entry = this.future.pop()
      if (!entry) return
      this.past.push({ label: entry.label, cues: cloneCues(this.document.cues), selectedCueId: this.selectedCueId })
      this.document.cues = cloneCues(entry.cues)
      this.selectedCueId = entry.selectedCueId
      this.markChanged(`redo:${entry.label}`)
    },
    updateCue(id: string, patch: Partial<Cue>, historyLabel = 'update-cue') {
      this.commit(historyLabel, (cues) => {
        const cue = cues.find((item) => item.id === id)
        if (!cue || cue.locked) return
        Object.assign(cue, patch)
      })
    },
    markStatus(id: string, status: Cue['status']) {
      this.updateCue(id, { status }, `status:${status}`)
    },
    toggleLock(id: string) {
      this.updateCue(id, { locked: !this.document.cues.find((cue) => cue.id === id)?.locked }, 'toggle-lock')
    },
    splitCue(id: string) {
      const source = this.document.cues.find((cue) => cue.id === id)
      if (!source || source.locked) return
      const ratio = Math.max(0.25, Math.min(0.75, source.source.length ? 0.5 : 0.5))
      const middle = Number((source.start + (source.end - source.start) * ratio).toFixed(2))
      const sourceMid = Math.max(1, Math.round(source.source.length * ratio))
      const targetMid = Math.max(1, Math.round(source.target.length * ratio))
      const secondId = makeId('cue')
      this.commit('split', (cues) => {
        const index = cues.findIndex((cue) => cue.id === id)
        const cue = cues[index]
        const second: Cue = {
          ...cue,
          id: secondId,
          start: middle,
          source: cue.source.slice(sourceMid).trim(),
          target: cue.target.slice(targetMid).trim(),
          status: 'draft',
          locked: false,
        }
        cue.end = middle
        cue.source = cue.source.slice(0, sourceMid).trim()
        cue.target = cue.target.slice(0, targetMid).trim()
        cue.status = 'draft'
        cues.splice(index + 1, 0, second)
      }, secondId)
    },
    mergeNext(id: string) {
      const index = this.document.cues.findIndex((cue) => cue.id === id)
      const current = this.document.cues[index]
      const next = this.document.cues[index + 1]
      if (!current || !next || current.locked || next.locked) return
      this.commit('merge', (cues) => {
        const item = cues[index]
        const following = cues[index + 1]
        item.end = following.end
        item.source = `${item.source} ${following.source}`.trim()
        item.target = `${item.target} ${following.target}`.trim()
        item.termIds = [...new Set([...item.termIds, ...following.termIds])]
        item.status = 'draft'
        cues.splice(index + 1, 1)
      }, id)
    },
    moveCue(id: string, direction: -1 | 1) {
      const index = this.document.cues.findIndex((cue) => cue.id === id)
      const target = index + direction
      if (index < 0 || target < 0 || target >= this.document.cues.length) return
      this.commit('move', (cues) => {
        const [item] = cues.splice(index, 1)
        cues.splice(target, 0, item)
      }, id)
    },
    deleteCue(id: string) {
      const cue = this.document.cues.find((item) => item.id === id)
      if (!cue || cue.locked) return
      this.commit('delete', (cues) => {
        const index = cues.findIndex((item) => item.id === id)
        if (index >= 0) cues.splice(index, 1)
      }, this.document.cues[Math.max(0, this.document.cues.findIndex((item) => item.id === id) - 1)]?.id ?? null)
    },
    createSnapshot(name: string) {
      const snapshot: Snapshot = { id: makeId('snapshot'), name: name.trim() || `v${this.document.snapshots.length + 1}`, createdAt: Date.now(), cues: cloneCues(this.document.cues) }
      this.document.snapshots.unshift(snapshot)
      this.markChanged('snapshot', true)
    },
    restoreSnapshot(id: string) {
      const snapshot = this.document.snapshots.find((item) => item.id === id)
      if (!snapshot) return
      this.past.push({ label: 'restore-snapshot', cues: cloneCues(this.document.cues), selectedCueId: this.selectedCueId })
      this.future = []
      this.document.cues = cloneCues(snapshot.cues)
      this.selectedCueId = this.document.cues[0]?.id ?? null
      this.markChanged('restore-snapshot')
    },
    importText(text: string, filename: string) {
      const lower = filename.toLowerCase()
      const cues = lower.endsWith('.srt') ? parseSrt(text) : parseScript(text, this.document.actors)
      if (!cues.length) throw new Error('EMPTY_IMPORT')
      this.commit('import', (current) => {
        current.splice(0, current.length, ...cues)
      }, cues[0].id)
      return cues.length
    },
    exportSrt() {
      const blob = new Blob([toSrt(this.document.cues)], { type: 'text/plain;charset=utf-8' })
      const url = URL.createObjectURL(blob)
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = `${this.document.title || 'subtitle'}.srt`
      anchor.click()
      URL.revokeObjectURL(url)
    },
  },
})
