import type { EventEnvelope } from "@hearth/core";

type Listener = (event: EventEnvelope) => void;

export class EventBus {
  private readonly listeners = new Set<Listener>();

  publish(event: EventEnvelope): void {
    for (const listener of this.listeners) listener(event);
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}
