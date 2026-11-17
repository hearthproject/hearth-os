import { useSyncExternalStore } from "react";

const KEY = "hearth.task-read.v1";
const EVENT = "hearth-task-read";
type TaskRevision = { id: string; updatedAt: string };
let fallback = "{}";

function snapshot(): string {
  try { return localStorage.getItem(KEY) ?? fallback; } catch { return fallback; }
}

export function parseTaskReadState(raw: string): Record<string, string> {
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    return Object.fromEntries(Object.entries(value).filter(([, revision]) => typeof revision === "string"));
  } catch { return {}; }
}

export function isTaskUnread(task: TaskRevision, seen: Record<string, string>): boolean {
  return !seen[task.id] || seen[task.id]! < task.updatedAt;
}

export function markTasksRead(tasks: TaskRevision[]): void {
  const seen = parseTaskReadState(snapshot());
  let changed = false;
  for (const task of tasks) {
    if (isTaskUnread(task, seen)) { seen[task.id] = task.updatedAt; changed = true; }
  }
  if (!changed) return;
  fallback = JSON.stringify(seen);
  try { localStorage.setItem(KEY, fallback); } catch { /* Still clear the badge for this session. */ }
  window.dispatchEvent(new Event(EVENT));
}

function subscribe(listener: () => void) {
  const storageListener = (event: StorageEvent) => {
    if (event.key === KEY || event.key === null) { fallback = "{}"; listener(); }
  };
  window.addEventListener(EVENT, listener);
  window.addEventListener("storage", storageListener);
  return () => { window.removeEventListener(EVENT, listener); window.removeEventListener("storage", storageListener); };
}

export function useTaskReadState(): Record<string, string> {
  return parseTaskReadState(useSyncExternalStore(subscribe, snapshot, () => "{}"));
}
