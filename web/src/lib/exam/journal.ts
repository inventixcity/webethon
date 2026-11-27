import type { AttemptPayload, JournalEntry, Lease } from "@/lib/exam/types";

const DB_NAME = "invigil-journal";
const DB_VERSION = 1;
const ENTRY_STORE = "entries";
const META_STORE = "meta";
const appendLocks = new Map<string, Promise<void>>();
export const JOURNAL_SEQ_BASE = 1_000_000_000;

export type JournalMeta = { genesis: string | null; head: string | null; seq: number; lease: Lease | null; leaseReceivedAt: number | null; receivedAtWall: number | null; clientSeq: number; timeOrigin?: number; payload?: AttemptPayload };
const emptyMeta: JournalMeta = { genesis: null, head: null, seq: 0, lease: null, leaseReceivedAt: null, receivedAtWall: null, clientSeq: 0 };

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(ENTRY_STORE)) db.createObjectStore(ENTRY_STORE, { keyPath: ["attemptId", "seq"] });
      if (!db.objectStoreNames.contains(META_STORE)) db.createObjectStore(META_STORE, { keyPath: "attemptId" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB unavailable"));
  });
}

function transact<T>(attemptId: string, stores: string[], mode: IDBTransactionMode, run: (tx: IDBTransaction, done: (value: T) => void) => void): Promise<T> {
  return openDb().then((db) => new Promise<T>((resolve, reject) => {
    const tx = db.transaction(stores, mode);
    let result: T;
    run(tx, (value) => { result = value; });
    tx.oncomplete = () => { db.close(); resolve(result!); };
    tx.onerror = () => { db.close(); reject(tx.error ?? new Error("Journal transaction failed")); };
    tx.onabort = () => { db.close(); reject(tx.error ?? new Error("Journal transaction aborted")); };
    void attemptId;
  }));
}

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function fromBase64Url(value: string): Uint8Array {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((value.length + 3) % 4);
  return Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
}

export function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  bytes.forEach((byte) => { binary += String.fromCharCode(byte); });
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export async function chainNext(prev: Uint8Array, seq: number, itemId: string, response: unknown, writtenAt: number): Promise<string> {
  const parts = [new TextEncoder().encode("journal.v1"), prev, new TextEncoder().encode(String(seq)), new TextEncoder().encode(itemId), new TextEncoder().encode(canonicalJson(response)), new TextEncoder().encode(String(writtenAt))];
  const bytes = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  parts.forEach((part) => { bytes.set(part, at); at += part.length; });
  return toBase64Url(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)));
}

export async function getMeta(attemptId: string): Promise<JournalMeta> {
  return transact(attemptId, [META_STORE], "readonly", (tx, done) => {
    const req = tx.objectStore(META_STORE).get(attemptId);
    req.onsuccess = () => { const { attemptId: _id, ...meta } = req.result ?? {}; void _id; done({ ...emptyMeta, ...meta } as JournalMeta); };
  });
}

function mutateMeta(attemptId: string, update: (meta: JournalMeta) => JournalMeta): Promise<JournalMeta> {
  return transact(attemptId, [META_STORE], "readwrite", (tx, done) => {
    const store = tx.objectStore(META_STORE);
    const req = store.get(attemptId);
    req.onsuccess = () => {
      const meta = update({ ...emptyMeta, ...req.result });
      store.put({ ...meta, attemptId });
      done(meta);
    };
  });
}

export async function initializeJournal(attemptId: string, genesis: string, head: string | null, seq: number, clientSeq = 0): Promise<void> {
  await mutateMeta(attemptId, (meta) => ({ ...meta, genesis,
    head: seq >= meta.seq ? head : meta.head, seq: Math.max(meta.seq, seq),
    clientSeq: Math.max(meta.clientSeq, clientSeq, seq ? JOURNAL_SEQ_BASE + seq : 0) }));
}

export async function setLease(attemptId: string, lease: Lease): Promise<void> {
  await mutateMeta(attemptId, (meta) => ({ ...meta, lease, leaseReceivedAt: performance.now(), receivedAtWall: Date.now(), timeOrigin: performance.timeOrigin }));
}

export async function cacheAttempt(attemptId: string, payload: AttemptPayload): Promise<void> {
  await mutateMeta(attemptId, (meta) => ({ ...meta, payload }));
}

/** Reload fallback uses wall-clock delta. Never clamp a late edit back to the signed deadline. */
export async function leaseElapsed(meta: JournalMeta): Promise<number> {
  if (!meta.lease || meta.leaseReceivedAt === null || meta.receivedAtWall === null) return 0;
  // Comparing performance.now values cannot identify a reload: the new page may have been open
  // longer than the old page. timeOrigin identifies the browsing context explicitly.
  const delta = meta.timeOrigin === performance.timeOrigin ? performance.now() - meta.leaseReceivedAt : Date.now() - meta.receivedAtWall;
  return Math.max(0, delta);
}

export async function appendEntry(attemptId: string, itemId: string, response: JournalEntry["response"], flagged: boolean, lease: Lease, elapsedMs: number): Promise<JournalEntry> {
  const previous = appendLocks.get(attemptId) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => { release = resolve; });
  const queued = previous.then(() => current);
  appendLocks.set(attemptId, queued);
  await previous;
  try {
  const writtenAt = lease.issuedAt + Math.floor(elapsedMs);
  // The read, sequence allocation, hash/head and entry write share ONE readwrite transaction.
  // IndexedDB also serializes this transaction against other tabs. WebCrypto is asynchronous;
  // keep a read request outstanding and perform writes inside its active onsuccess callback.
  return await transact<JournalEntry>(attemptId, [ENTRY_STORE, META_STORE], "readwrite", (tx, done) => {
    const store = tx.objectStore(META_STORE);
    const req = store.get(attemptId);
    req.onsuccess = () => {
      const meta: JournalMeta = { ...emptyMeta, ...req.result };
      if (!meta.genesis || writtenAt > lease.deadlineAt || elapsedMs < 0) { tx.abort(); return; }
      const seq = meta.seq + 1;
      const prev = fromBase64Url(meta.head ?? meta.genesis);
      let hash: string | undefined;
      let failed = false;
      void chainNext(prev, seq, itemId, response, writtenAt).then((value) => { hash = value; }, () => { failed = true; });
      const keepAlive = () => {
        const read = store.get(attemptId);
        read.onsuccess = () => {
          if (failed) { tx.abort(); return; }
          if (hash === undefined) { keepAlive(); return; }
          const entry: JournalEntry = { seq, itemId, response, flagged, lease, elapsedMs: Math.floor(elapsedMs), writtenAt, hash };
          tx.objectStore(ENTRY_STORE).add({ ...entry, attemptId });
          store.put({ ...meta, attemptId, head: hash, seq, clientSeq: Math.max(meta.clientSeq, JOURNAL_SEQ_BASE + seq) });
          done(entry);
        };
      };
      keepAlive();
    };
  });
  } finally {
    release();
    if (appendLocks.get(attemptId) === queued) appendLocks.delete(attemptId);
  }
}

export async function listEntries(attemptId: string, limit = 200): Promise<JournalEntry[]> {
  return transact(attemptId, [ENTRY_STORE], "readonly", (tx, done) => {
    const req = tx.objectStore(ENTRY_STORE).getAll(IDBKeyRange.bound([attemptId, 0], [attemptId, Number.MAX_SAFE_INTEGER]), Math.min(limit, 0xffffffff));
    req.onsuccess = () => done((req.result as Array<JournalEntry & { attemptId: string }>).map(({ attemptId: _id, ...entry }) => { void _id; return entry; }));
  });
}

export async function acknowledgeEntries(attemptId: string, seqs: number[], head: string | null, serverSeq: number): Promise<void> {
  await transact<void>(attemptId, [ENTRY_STORE, META_STORE], "readwrite", (tx, done) => {
    const entries = tx.objectStore(ENTRY_STORE);
    seqs.forEach((seq) => entries.delete([attemptId, seq]));
    const req = tx.objectStore(META_STORE).get(attemptId);
    req.onsuccess = () => {
      const old = { ...emptyMeta, ...req.result };
      // An acknowledgement of an earlier batch must not replace a newer local chain head.
      tx.objectStore(META_STORE).put({ ...old, attemptId, head: serverSeq >= old.seq ? head : old.head, seq: Math.max(serverSeq, old.seq), clientSeq: Math.max(old.clientSeq, JOURNAL_SEQ_BASE + serverSeq) });
    };
    done();
  });
}

export async function nextClientSeq(attemptId: string): Promise<number> {
  return (await mutateMeta(attemptId, (meta) => ({ ...meta, clientSeq: meta.clientSeq + 1 }))).clientSeq;
}

export async function pendingCount(attemptId: string): Promise<number> { return (await listEntries(attemptId, Number.MAX_SAFE_INTEGER)).length; }
