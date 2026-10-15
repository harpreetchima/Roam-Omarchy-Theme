/* No graph settings, cached palette, paths, or general-purpose storage API. */
(() => {
  "use strict";

  function createStorage() {
    const { DB_NAME } = globalThis.RoamOmarchyDesktopSource;
    let disposed = false;
    let database = null;
    let opening = null;
    let writes = Promise.resolve();
    const transactions = new Set();
    const closed = () => new DOMException("Local storage operation canceled.", "AbortError");

    function open() {
      if (disposed) return Promise.reject(closed());
      if (database) return Promise.resolve(database);
      if (opening) return opening;
      opening = new Promise((resolve, reject) => {
        let rejected = false;
        const request = indexedDB.open(DB_NAME, 1);
        const fail = (error) => { rejected = true; reject(error); };
        request.onupgradeneeded = () => {
          if (disposed) { request.transaction.abort(); return; }
          if (!request.result.objectStoreNames.contains("local")) request.result.createObjectStore("local");
        };
        request.onerror = () => fail(request.error);
        request.onblocked = () => fail(new Error("Local storage is blocked."));
        request.onsuccess = () => {
          const db = request.result;
          if (disposed || rejected) { db.close(); reject(closed()); return; }
          database = db;
          db.onversionchange = () => { db.close(); database = null; opening = null; };
          resolve(db);
        };
      }).catch((error) => { opening = null; throw error; });
      return opening;
    }

    async function transact(mode, run, current = () => true) {
      const db = await open();
      if (disposed || !current()) throw closed();
      return new Promise((resolve, reject) => {
        let transaction;
        let result;
        try {
          transaction = db.transaction("local", mode);
          transactions.add(transaction);
          transaction.oncomplete = () => { transactions.delete(transaction); resolve(result); };
          transaction.onabort = transaction.onerror = () => {
            transactions.delete(transaction);
            reject(transaction.error || closed());
          };
          run(transaction.objectStore("local"), (value) => { result = value; });
        } catch (error) {
          try { transaction?.abort(); } catch { /* Already completed. */ }
          transactions.delete(transaction);
          reject(error);
        }
      });
    }

    function write(key, value, current) {
      const operation = writes.then(() => transact("readwrite", (store) => {
        if (value === undefined) store.delete(key);
        else store.put(value, key);
      }, current));
      writes = operation.catch(() => {});
      return operation;
    }

    return {
      load() {
        return transact("readonly", (store, setResult) => {
          const result = {};
          store.get("options").onsuccess = (event) => { result.options = event.target.result; };
          store.get("directory").onsuccess = (event) => { result.handle = event.target.result; };
          setResult(result);
        });
      },
      saveOptions: (options, current) => write("options", options, current),
      saveHandle: (handle, current) => write("directory", handle, current),
      forgetHandle: (current) => write("directory", undefined, current),
      dispose() {
        if (disposed) return;
        disposed = true;
        for (const transaction of transactions) {
          try { transaction.abort(); } catch { /* Committed user intent may already be saved. */ }
        }
        transactions.clear();
        database?.close();
        database = null;
      },
    };
  }

  globalThis.RoamOmarchyDesktopStorage = Object.freeze({ createStorage });
})();
