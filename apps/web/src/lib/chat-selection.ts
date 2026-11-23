import { useSyncExternalStore } from "react";

export interface ChatSelectionState {
  conversationId: string | null;
  pendingProjectId: string | null;
  busy: boolean;
  nonce: number;
}

const STORAGE_KEY = "hearth.conversation";

function readStoredConversation(): string | null {
  try {
    return window.localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

function writeStoredConversation(id: string | null): void {
  try {
    if (id) window.localStorage.setItem(STORAGE_KEY, id);
    else window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    // localStorage 不可用时只影响下次打开时的默认对话
  }
}

let state: ChatSelectionState = {
  conversationId: readStoredConversation(),
  pendingProjectId: null,
  busy: false,
  nonce: 0
};

const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

export function getChatSelection(): ChatSelectionState {
  return state;
}

function subscribeChatSelection(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useChatSelection(): ChatSelectionState {
  return useSyncExternalStore(subscribeChatSelection, getChatSelection, getChatSelection);
}

/** 外部（左侧栏）发起的切换请求，会递增 nonce 让聊天页执行一次完整重置。 */
export function requestChat(conversationId: string | null, pendingProjectId: string | null = null): void {
  writeStoredConversation(conversationId);
  state = {
    ...state,
    conversationId,
    pendingProjectId: conversationId ? null : pendingProjectId,
    nonce: state.nonce + 1
  };
  emit();
}

/** 聊天页内部状态变化时同步给左侧栏，不触发重置。 */
export function syncChatSelection(conversationId: string | null, pendingProjectId: string | null): void {
  if (state.conversationId === conversationId && state.pendingProjectId === pendingProjectId) return;
  writeStoredConversation(conversationId);
  state = { ...state, conversationId, pendingProjectId };
  emit();
}

export function setChatBusy(busy: boolean): void {
  if (state.busy === busy) return;
  state = { ...state, busy };
  emit();
}
