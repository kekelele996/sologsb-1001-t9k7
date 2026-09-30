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

/** Unconditional write: stores the document as the next revision without an optimistic lock. */
export const putDocument = async (document: EditorDocument): Promise<EditorDocument> => {
  const db = await openDb()
  return new Promise<EditorDocument>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite')
    const store = tx.objectStore(STORE)
    store.put(document)
    tx.oncomplete = () => {
      db.close()
      resolve(document)
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
