import assert from 'node:assert'
import type { Cue, EditorDocument, Locale } from '../src/types'
import { mergeDocuments, resolveCueConflict } from '../src/utils/merge'

const locale: Locale = 'zh-CN'
const cue = (id: string, over: Partial<Cue> = {}): Cue => ({
  id, start: 0, end: 2, source: `${id}-src`, target: `${id}-tgt`,
  actorId: 'a', speed: 1, termIds: [], status: 'draft', locked: false, ...over,
})
const doc = (revision: number, cues: Cue[]): EditorDocument => ({
  id: 'd', title: 'T', language: locale, cues, actors: [], terms: [], snapshots: [],
  updatedAt: 0, revision, lastWriter: '',
})
const ids = (d: EditorDocument) => d.cues.map((c) => c.id)

let passed = 0
const check = (name: string, fn: () => void) => {
  fn()
  passed += 1
  console.log(`  ✓ ${name}`)
}

// 场景1：两人各改不同台词、一人新增、一人删除 —— 全部自动写入，零冲突
check('不同台词的修改各自写入（含新增、删除），无冲突', () => {
  const base = doc(1, [cue('c1', { target: '旧1' }), cue('c2'), cue('c3'), cue('c4')])
  const local = doc(1, [cue('c1', { target: '本页改1' }), cue('c2'), cue('c3'), cue('c4'), cue('c5', { target: '新增' })])
  const remote = doc(2, [cue('c1', { target: '旧1' }), cue('c2', { target: '对方改2' }), cue('c4')]) // 删了 c3
  const r = mergeDocuments(local, remote, base, 3)
  assert.equal(r.conflicts.length, 0)
  assert.deepEqual(ids(r.document), ['c1', 'c2', 'c4', 'c5'])
  assert.equal(r.document.cues.find((c) => c.id === 'c1')?.target, '本页改1')
  assert.equal(r.document.cues.find((c) => c.id === 'c2')?.target, '对方改2')
  assert.ok(!r.document.cues.some((c) => c.id === 'c3'))
})

// 场景2：同一条台词不同字段两边各改 —— 字段级自动合并
check('同一条台词不同字段被两边修改：各写字段，无冲突', () => {
  const base = doc(1, [cue('c1', { target: 'T', speed: 1, status: 'draft' })])
  const local = doc(1, [cue('c1', { target: '本页译文', speed: 1, status: 'draft' })])
  const remote = doc(2, [cue('c1', { target: 'T', speed: 1.3, status: 'reviewed' })])
  const r = mergeDocuments(local, remote, base, 3)
  assert.equal(r.conflicts.length, 0)
  const merged = r.document.cues[0]
  assert.equal(merged.target, '本页译文')
  assert.equal(merged.speed, 1.3)
  assert.equal(merged.status, 'reviewed')
})

// 场景3：同一条同一字段两边改成不同内容 —— 停下报冲突，列出两边
check('同一条同一字段两边都改成不同值：产生字段冲突，暂取远端', () => {
  const base = doc(1, [cue('c1', { target: 'A' })])
  const local = doc(1, [cue('c1', { target: '本页' })])
  const remote = doc(2, [cue('c1', { target: '对方' })])
  const r = mergeDocuments(local, remote, base, 3)
  assert.equal(r.conflicts.length, 1)
  assert.deepEqual(r.conflicts[0].fields.map((f) => f.field), ['target'])
  assert.equal(r.conflicts[0].fields[0].localValue, '本页')
  assert.equal(r.conflicts[0].fields[0].remoteValue, '对方')
  // 冲突字段暂取远端，整条仍随合并结果落库，不阻塞其它台词
  assert.equal(r.document.cues[0].target, '对方')
})

// 场景4：同一字段两边改成相同内容 —— 不算冲突
check('两边把同一字段改成相同值：不算冲突', () => {
  const base = doc(1, [cue('c1', { target: 'A' })])
  const local = doc(1, [cue('c1', { target: '一致' })])
  const remote = doc(2, [cue('c1', { target: '一致' })])
  const r = mergeDocuments(local, remote, base, 3)
  assert.equal(r.conflicts.length, 0)
  assert.equal(r.document.cues[0].target, '一致')
})

// 场景5：一边删除、另一边修改同一条 —— 停下询问；未决前保留修改内容
check('删除 vs 修改：报删除冲突，未决前保留被修改的台词', () => {
  const base = doc(1, [cue('c1'), cue('c2')])
  const local = doc(1, [cue('c2')]) // 本页删 c1
  const remote = doc(2, [cue('c1', { target: '对方改了' }), cue('c2')])
  const r = mergeDocuments(local, remote, base, 3)
  assert.equal(r.conflicts.length, 1)
  assert.equal(r.conflicts[0].kind, 'delete')
  assert.ok(r.document.cues.some((c) => c.id === 'c1'))
  // 用户选删除
  r.conflicts[0].deleteChoice = 'delete'
  const resolved = resolveCueConflict(r.conflicts[0])
  assert.equal(resolved, null)
  // 用户选保留
  r.conflicts[0].deleteChoice = 'keep'
  r.conflicts[0].fields[0].resolution = 'remote'
  const kept = resolveCueConflict(r.conflicts[0])
  assert.equal(kept?.target, '对方改了')
})

// 场景6：双方都删除 —— 安静删除，无冲突
check('两边都删除同一条：安静删除', () => {
  const base = doc(1, [cue('c1'), cue('c2')])
  const local = doc(1, [cue('c2')])
  const remote = doc(2, [cue('c2')])
  const r = mergeDocuments(local, remote, base, 3)
  assert.equal(r.conflicts.length, 0)
  assert.deepEqual(ids(r.document), ['c2'])
})

// 场景7：混合 —— 只有一个真正冲突，其余全部自动写入
check('混合场景：仅冲突条停下，其它台词均已写入', () => {
  const base = doc(1, [cue('c1'), cue('c2'), cue('c3')])
  const local = doc(1, [cue('c1', { target: '本页-1' }), cue('c2', { target: '撞!' }), cue('c3'), cue('c6')])
  const remote = doc(2, [cue('c1'), cue('c2', { target: '撞?' }), cue('c3', { status: 'reviewed' }), cue('c5')])
  const r = mergeDocuments(local, remote, base, 3)
  assert.equal(r.conflicts.length, 1)
  assert.equal(r.conflicts[0].cueId, 'c2')
  const m = new Map(r.document.cues.map((c) => [c.id, c]))
  assert.equal(m.get('c1')?.target, '本页-1') // 本页独改写入
  assert.equal(m.get('c2')?.target, '撞?') // 冲突暂取远端
  assert.equal(m.get('c3')?.status, 'reviewed') // 对方独改写入
  assert.ok(m.has('c5')) // 对方新增
  assert.ok(m.has('c6')) // 本页新增
})

// 场景8：冲突挑选后，本页字段与对方独改字段在同一条共存
check('挑选结果与对方在同一条上的其它修改共存', () => {
  const base = doc(1, [cue('c1', { target: 'A', speed: 1, source: 'S' })])
  const local = doc(1, [cue('c1', { target: '本页选我', speed: 1, source: 'S' })])
  const remote = doc(2, [cue('c1', { target: '对方', speed: 1.5, source: '对方原文' })])
  const r = mergeDocuments(local, remote, base, 3)
  assert.equal(r.conflicts.length, 1) // target 冲突；speed/source 对方独改
  r.conflicts[0].fields[0].resolution = 'local'
  const resolved = resolveCueConflict(r.conflicts[0])
  assert.equal(resolved?.target, '本页选我')
  assert.equal(resolved?.speed, 1.5)
  assert.equal(resolved?.source, '对方原文')
})

// 场景9：旧稿升级（无分条基点 cueRev）——仍能读出并按基点合并
check('旧稿无分条记录：cueRev 缺失也能正常合并', () => {
  const baseCue = cue('c1', { target: 'A' })
  delete (baseCue as Partial<Cue>).cueRev
  const base = doc(1, [baseCue])
  const local = doc(1, [cue('c1', { target: '本页' })])
  const remote = doc(2, [cue('c1', { target: '对方' })])
  const r = mergeDocuments(local, remote, base, 3)
  assert.equal(r.conflicts.length, 1)
  assert.equal(r.document.cues[0].cueRev, 3) // 写入后补齐分条修订号
})

// 场景10：重试再冲突 —— 先前已写入的台词保留（合并是纯函数，库内其它条不被回滚）
check('单条重试时远端又改同一处：重新报冲突，其它已写入条目不变', () => {
  const base = doc(1, [cue('c1'), cue('c2', { target: '已合并的其它台词' })])
  // 第一次合并后 c2 已在 rev3 落库；重试 c1 时远端已到 rev4，且 c1 第三次被改
  const retryBase = doc(3, [cue('c1', { target: '对方v1' }), cue('c2', { target: '已合并的其它台词' })])
  const local = doc(3, [cue('c1', { target: '本页坚持' }), cue('c2', { target: '已合并的其它台词' })])
  const remoteV2 = doc(4, [cue('c1', { target: '对方v2' }), cue('c2', { target: '已合并的其它台词' })])
  const r = mergeDocuments(local, remoteV2, retryBase, 5)
  assert.equal(r.conflicts.length, 1)
  assert.equal(r.conflicts[0].cueId, 'c1')
  // c2 已落库内容原样保留，不因 c1 重试失败而退回
  assert.equal(r.document.cues.find((c) => c.id === 'c2')?.target, '已合并的其它台词')
})

// 场景11：顺序交错 —— 两边各自新增的台词都保留
check('两边在不同位置新增：新增内容都保留', () => {
  const base = doc(1, [cue('a'), cue('b')])
  const local = doc(1, [cue('a'), cue('l'), cue('b')])
  const remote = doc(2, [cue('a'), cue('b'), cue('r')])
  const r = mergeDocuments(local, remote, base, 3)
  assert.deepEqual(ids(r.document).sort(), ['a', 'b', 'l', 'r'].sort())
})

console.log(`\n${passed} checks passed.`)
