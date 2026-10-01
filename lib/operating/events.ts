import type { CafeDomainEvent } from "./types";
export type DomainEventHandler = (event: CafeDomainEvent) => void | Promise<void>;
export class InProcessDomainEvents {
  private handlers = new Set<DomainEventHandler>();
  subscribe(handler: DomainEventHandler): () => void { this.handlers.add(handler); return () => this.handlers.delete(handler); }
  async publish(event: CafeDomainEvent): Promise<void> { await Promise.all([...this.handlers].map((handler) => handler(event))); }
}
