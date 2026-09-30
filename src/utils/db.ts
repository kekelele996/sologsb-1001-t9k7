import type { EditorDocument, PendingMergeState } from '../types'

const DB_NAME = 'sologsb-1001'
const DOC_STORE = 'documents'
const MERGE_STORE = 'mergeState'

const openDb = (): Promise<IDBDatabase> => new Promise((resolve, reject) => {
  // v2：新增 mergeState 库，保存逐台词合并中尚未挑完的冲突（刷新后可继续单条重试）
  const request = indexedDB.open(DB_NAME, 2)
  request.onupgradeneeded = () => {
    const db = request.result
    if (!db.objectStoreNames.contains(DOC_STORE)) db.createObjectStore(DOC_STORE, { keyPath: 'id' })
    if (!db.objectStoreNames.contains(MERGE_STORE)) db.createObjectStore(MERGE_STORE, { keyPath: 'id' })
  }
  request.onsuccess = () => resolve(request.result)
  request.onerror = () => reject(request.error)
})

const transact = async <T>(storeName: string, mode: IDBTransactionMode, action: (store: IDBObjectStore) => IDBRequest<T>) => {
  const db = await openDb()
  return new Promise<T>((resolve, reject) => {
    const tx = db.transaction(storeName, mode)
    const request = action(tx.objectStore(storeName))
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
    tx.oncomplete = () => db.close()
    tx.onerror = () => reject(tx.error)
  })
}

export const loadDocument = (id: string) => transact<EditorDocument | undefined>(DOC_STORE, 'readonly', (store) => store.get(id))

export const saveDocument = async (document: EditorDocument, expectedRevision?: number) => {
  const db = await openDb()
  return new Promise<EditorDocument>((resolve, reject) => {
    const tx = db.transaction(DOC_STORE, 'readwrite')
    const store = tx.objectStore(DOC_STORE)
    const getRequest = store.get(document.id)
    let next: EditorDocument | undefined
    let conflict = false
    getRequest.onsuccess = () => {
      const current = getRequest.result as EditorDocument | undefined
      if (expectedRevision !== undefined && current && current.revision !== expectedRevision) {
        conflict = true
        return // 不写入；事务随后以空操作正常结束，仅用结果区分冲突
      }
      next = { ...document, revision: (current?.revision ?? document.revision ?? 0) + 1, updatedAt: Date.now() }
      store.put(next)
    }
    tx.oncomplete = () => {
      db.close()
      if (conflict) reject(new Error('REVISION_CONFLICT'))
      else if (next) resolve(next)
      else reject(new Error('SAVE_EMPTY'))
    }
    tx.onerror = () => {
      db.close()
      reject(tx.error)
    }
    tx.onabort = () => {
      db.close()
      reject(tx.error ?? new Error('TRANSACTION_ABORTED'))
    }
  })
}

export const loadPendingMerge = (documentId: string) =>
  transact<PendingMergeState | undefined>(MERGE_STORE, 'readonly', (store) => store.get(documentId))

export const savePendingMerge = (state: PendingMergeState) =>
  transact<IDBValidKey>(MERGE_STORE, 'readwrite', (store) =>
    // JSON 净化：调用方传入的可能是 Vue reactive 对象，结构化克隆不接受 Proxy
    store.put(JSON.parse(JSON.stringify(state))))

export const deletePendingMerge = (documentId: string) =>
  transact<undefined>(MERGE_STORE, 'readwrite', (store) => store.delete(documentId))
