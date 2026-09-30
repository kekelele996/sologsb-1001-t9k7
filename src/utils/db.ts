import type { EditorDocument } from '../types'

const DB_NAME = 'sologsb-1001'
const STORE = 'documents'

const openDb = (): Promise<IDBDatabase> => new Promise((resolve, reject) => {
  const request = indexedDB.open(DB_NAME, 1)
  request.onupgradeneeded = () => {
    if (!request.result.objectStoreNames.contains(STORE)) request.result.createObjectStore(STORE, { keyPath: 'id' })
  }
  request.onsuccess = () => resolve(request.result)
  request.onerror = () => reject(request.error)
})

const transact = async <T>(mode: IDBTransactionMode, action: (store: IDBObjectStore) => IDBRequest<T>) => {
  const db = await openDb()
  return new Promise<T>((resolve, reject) => {
    const tx = db.transaction(STORE, mode)
    const request = action(tx.objectStore(STORE))
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
    tx.oncomplete = () => db.close()
    tx.onerror = () => reject(tx.error)
  })
}

export const loadDocument = (id: string) => transact<EditorDocument | undefined>('readonly', (store) => store.get(id))

export const saveDocument = async (document: EditorDocument, expectedRevision?: number) => {
  const db = await openDb()
  return new Promise<EditorDocument>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite')
    const store = tx.objectStore(STORE)
    const getRequest = store.get(document.id)
    let next: EditorDocument | undefined
    let settled = false
    getRequest.onsuccess = () => {
      const current = getRequest.result as EditorDocument | undefined
      if (expectedRevision !== undefined && current && current.revision !== expectedRevision) {
        settled = true
        reject(new Error('REVISION_CONFLICT'))
        return
      }
      next = { ...document, revision: (current?.revision ?? document.revision ?? 0) + 1, updatedAt: Date.now() }
      store.put(next)
    }
    tx.oncomplete = () => {
      db.close()
      if (!settled && next) resolve(next)
    }
    tx.onerror = () => {
      db.close()
      if (!settled) reject(tx.error)
    }
    tx.onabort = () => {
      db.close()
      if (!settled) reject(tx.error ?? new Error('TRANSACTION_ABORTED'))
    }
  })
}
