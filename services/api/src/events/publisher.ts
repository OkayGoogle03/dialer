/** Abstraction over the broker so the outbox relay is testable without NATS. */
export abstract class EventPublisher {
  /** Publish with broker-side de-duplication on msgId. Must throw if the broker did not persist the message. */
  abstract publish(subject: string, payload: Uint8Array, msgId: string): Promise<void>;
  abstract isConnected(): boolean;
  abstract close(): Promise<void>;
}
