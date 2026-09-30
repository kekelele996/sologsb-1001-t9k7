import 'fake-indexeddb/auto'
// Node 环境补齐浏览器 API（store 初始化时会访问）
;(globalThis as Record<string, unknown>).navigator ??= { onLine: true }
;(globalThis as Record<string, unknown>).window = globalThis
;(globalThis as Record<string, unknown>).BroadcastChannel = class {
  postMessage() {}
  set onmessage(_fn: unknown) {}
  close() {}
}
// 只 unref store 的防抖/重试长定时器，避免挂住 Node；短定时器（IndexedDB 事务）保持 ref
const originalSetTimeout = globalThis.setTimeout
globalThis.setTimeout = ((handler: TimerHandler, timeout?: number, ...args: unknown[]) => {
  const handle = originalSetTimeout(handler as never, timeout as number, ...args)
  if ((timeout ?? 0) >= 400 && typeof (handle as { unref?: () => void }).unref === 'function') {
    (handle as { unref: () => void }).unref()
  }
  return handle
}) as typeof setTimeout
import assert from 'node:assert'
import { createPinia, setActivePinia } from 'pinia'
import { reactive } from 'vue'
import { useEditorStore, pendingSave } from '../src/store/editor'
import type { EditorDocument } from '../src/types'
import { loadDocument, saveDocument, savePendingMerge, loadPendingMerge } from '../src/utils/db'

const DOCUMENT_ID = 'subtitle-dubbing-document'
// 等待防抖定时器触发 + 进行中的保存真正落库
const flush = async (ms = 550) => {
  await new Promise((r) => originalSetTimeout(r, ms))
  await pendingSave()
}

let passed = 0
const check = async (name: string, fn: () => Promise<void> | void) => {
  await fn()
  passed += 1
  console.log(`  ✓ ${name}`)
}

// 直接在库中准备一份"旧稿"：没有 cueRev 分条记录
const seedLegacyDoc = async () => {
  setActivePinia(createPinia())
  const anyStore = useEditorStore()
  const base: EditorDocument = JSON.parse(JSON.stringify(anyStore.document))
  base.cues.forEach((c) => delete c.cueRev) // 模拟旧稿
  base.revision = 5
  await saveDocument(base) // 落库 revision=6（saveDocument 自增）
  return base
}

const makeTab = () => {
  setActivePinia(createPinia())
  return useEditorStore()
}

await check('旧稿升级：读出后自动补全分条修订号，可继续合并', async () => {
  await seedLegacyDoc()
  const tab = makeTab()
  await tab.initialize()
  expectLegacy: {
    const stored = await loadDocument(DOCUMENT_ID)
    assert.ok(stored, '文档应存在')
    assert.ok(stored!.cues.every((c) => typeof c.cueRev === 'number'), '所有台词应补齐 cueRev')
  }
})

await check('两边改不同台词：后保存方不判整页冲突，自动合并落库', async () => {
  // tabA 改第1条；直接用 db 模拟 tabB 已先保存了第3条
  const tabA = makeTab()
  await tabA.initialize()
  const remoteBefore = JSON.parse(JSON.stringify(tabA.document)) as EditorDocument
  const cue3 = remoteBefore.cues[2]
  cue3.target = '对方（后段窗口）改的第三条'
  delete cue3.cueRev
  const remoteSaved = await saveDocument(remoteBefore, tabA.lastSeenRevision)

  tabA.updateCue(tabA.document.cues[1].id, { target: '本页（前段窗口）改的第二条' })
  await flush() // 等自动保存
  const stored = await loadDocument(DOCUMENT_ID)
  assert.equal(stored!.cues[1].target, '本页（前段窗口）改的第二条')
  assert.equal(stored!.cues[2].target, '对方（后段窗口）改的第三条')
  assert.equal(tabA.conflict, false)
  assert.equal(stored!.revision, remoteSaved.revision + 1)
})

await check('同一条同一字段双改：停下列出两边，其它台词已写入', async () => {
  const tab = makeTab()
  await tab.initialize()
  const rev = tab.lastSeenRevision

  // 对方先保存：第3条 target 改成"对方版"，第5条 target 改成"对方独改"
  const remote = JSON.parse(JSON.stringify(tab.document)) as EditorDocument
  remote.cues[2].target = '对方版第三条'
  remote.cues[4].target = '对方独改第五条'
  const remoteSaved = await saveDocument(remote, rev)

  // 本页：第3条改成"本页版"（撞车），第2条改成"本页独改"
  tab.updateCue(tab.document.cues[2].id, { target: '本页版第三条' })
  tab.updateCue(tab.document.cues[1].id, { target: '本页独改第二条' })
  await flush()

  assert.equal(tab.conflict, true)
  assert.equal(tab.mergeConflicts.length, 1)
  assert.equal(tab.mergeConflicts[0].cueId, tab.document.cues[2].id)
  assert.equal(tab.mergeConflicts[0].fields[0].field, 'target')
  const stored = await loadDocument(DOCUMENT_ID)
  assert.equal(stored!.revision, remoteSaved.revision + 1)
  assert.equal(stored!.cues[2].target, '对方版第三条', '冲突字段暂取对方')
  assert.equal(stored!.cues[4].target, '对方独改第五条')
  assert.equal(stored!.cues[1].target, '本页独改第二条', '本页独改的台词已写入')
})

await check('冲突单条重试：选本页后只重试该条并成功', async () => {
  const tab = makeTab()
  await tab.initialize()
  // 当前库内已有一个冲突（上一步留下）
  assert.ok(tab.mergeConflicts.length >= 1)
  const conflict0 = tab.mergeConflicts[0]
  tab.setConflictResolution(conflict0.cueId, 'target', 'local')
  assert.equal(conflict0.fields[0].resolution, 'local')
  await tab.retryConflicts([conflict0.cueId])
  assert.equal(tab.mergeConflicts.length, 0)
  assert.equal(tab.conflict, false)
  const stored = await loadDocument(DOCUMENT_ID)
  assert.equal(stored!.cues.find((c) => c.id === conflict0.cueId)?.target, '本页版第三条')
})

await check('重试再失败也不退回已写入的其它台词', async () => {
  const tab = makeTab()
  await tab.initialize()
  const rev = tab.lastSeenRevision
  // 制造新冲突：对方改第6条（未锁定）
  const remote = JSON.parse(JSON.stringify(tab.document)) as EditorDocument
  remote.cues[5].target = '对方又改第六条'
  await saveDocument(remote, rev)
  tab.updateCue(tab.document.cues[5].id, { target: '本页再改第六条' })
  await flush()
  assert.equal(tab.mergeConflicts.length, 1)
  const id = tab.mergeConflicts[0].cueId

  // 重试期间"对方"再次抢先改同一处
  const stamp = async () => {
    const latest = await loadDocument(DOCUMENT_ID)
    const again = JSON.parse(JSON.stringify(latest)) as EditorDocument
    again.cues.find((c) => c.id === id)!.target = '对方第三次改第六条'
    await saveDocument(again, latest!.revision)
  }
  tab.setConflictResolution(id, 'target', 'local')
  await stamp()
  await tab.retryConflicts([id])
  assert.equal(tab.mergeConflicts.length, 1, '仍然冲突')
  // 之前已写入的台词仍在库里
  const stored = await loadDocument(DOCUMENT_ID)
  assert.equal(stored!.cues.find((c) => c.id === 'cue-demo-05')?.target, '对方独改第五条')
  assert.equal(stored!.cues.find((c) => c.id === 'cue-demo-02')?.target, '本页独改第二条')

  // 用户改选对方后重试成功
  tab.setConflictResolution(id, 'target', 'remote')
  await tab.retryConflicts([id])
  assert.equal(tab.mergeConflicts.length, 0)
  const finalStored = await loadDocument(DOCUMENT_ID)
  assert.equal(finalStored!.cues.find((c) => c.id === id)?.target, '对方第三次改第六条')
})

await check('刷新恢复：未解决冲突持久化，重新 initialize 后面板恢复', async () => {
  const tab = makeTab()
  await tab.initialize()
  const rev = tab.lastSeenRevision
  const remote = JSON.parse(JSON.stringify(tab.document)) as EditorDocument
  remote.cues[4].target = '刷新前对方改第五条'
  await saveDocument(remote, rev)
  tab.updateCue(tab.document.cues[4].id, { target: '刷新前本页改第五条' })
  await flush()
  assert.equal(tab.mergeConflicts.length, 1)
  const id = tab.mergeConflicts[0].cueId

  // 模拟刷新：新 pinia、新 store
  const tab2 = makeTab()
  await tab2.initialize()
  assert.equal(tab2.conflict, true)
  assert.equal(tab2.mergeConflicts.length, 1)
  assert.equal(tab2.mergeConflicts[0].cueId, id)
  assert.equal(tab2.mergeConflicts[0].fields[0].localValue, '刷新前本页改第五条')
  assert.equal(tab2.mergeConflicts[0].fields[0].remoteValue, '刷新前对方改第五条')
})

await check('待决冲突以 reactive 代理形式保存也不报错（真实浏览器 DataClone 兼容）', async () => {
  const state = reactive({
    id: DOCUMENT_ID,
    baseRevision: 1,
    updatedAt: Date.now(),
    conflicts: [{
      cueId: 'cue-demo-03', kind: 'fields', index: 2,
      base: undefined,
      local: undefined,
      remote: undefined,
      fields: [{ field: 'target', baseValue: 'A', localValue: ['深', '层'], remoteValue: ['x'], resolution: 'local' as const }],
    }],
  })
  await savePendingMerge(state) // 不应抛 DataCloneError
  const restored = await loadPendingMerge(DOCUMENT_ID)
  assert.deepEqual(restored?.conflicts[0].fields[0].localValue, ['深', '层'])
})

console.log(`\n${passed} checks passed.`)
