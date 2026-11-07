import type { ContextItem } from "@hearth/core";

export interface ContextIndexQuery {
  taskId?: string;
  text: string;
  limit?: number;
}

export interface ContextIndexHit {
  item: ContextItem;
  score: number;
}

export interface ContextIndex {
  index(item: ContextItem): void | Promise<void>;
  removeTask(taskId: string): void | Promise<void>;
  search(query: ContextIndexQuery): ContextIndexHit[] | Promise<ContextIndexHit[]>;
}