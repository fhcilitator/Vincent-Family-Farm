import type { Channel, Event } from '@vff/protocol';

export interface LoggedEvent {
  seq: number;
  ts: number;
  type: string;
  body: unknown;
}

export interface SinceResult {
  events: LoggedEvent[];
  /**
   * True when the caller's `sinceSeq` predates the oldest retained event, so
   * some events are gone for good. Callers surface this to the user as an
   * explicit "earlier output dropped" marker — a transcript with a silent
   * hole is worse than one that admits the gap.
   */
  truncated: boolean;
  head: number;
}

/**
 * An append-only, sequence-numbered, bounded ring of events for one stream
 * (a Claude session or a PTY).
 *
 * This is the mechanism that lets work outlive a mobile connection. Events
 * land here whether or not a phone is listening; a reconnecting client asks
 * for everything after the last seq it rendered and catches up in one round
 * trip. No session re-creation, no lost turn.
 *
 * Bounded by BOTH event count and total bytes. A twenty-minute autonomous
 * Claude run while the phone is in a pocket must not exhaust the agent's
 * memory, and event count alone doesn't bound that — one `cat` of a large
 * file can outweigh thousands of small deltas.
 */
export class ChannelLog {
  readonly channel: Channel;
  readonly stream: string;

  #events: LoggedEvent[] = [];
  #head = 0;
  #bytes = 0;
  #dropped = 0;

  constructor(
    channel: Channel,
    stream: string,
    private readonly maxEvents = 4000,
    private readonly maxBytes = 8 * 1024 * 1024,
  ) {
    this.channel = channel;
    this.stream = stream;
  }

  get head(): number {
    return this.#head;
  }

  /** Count of events evicted by the bound. Surfaced once, then reset. */
  get droppedCount(): number {
    return this.#dropped;
  }

  /** Seq of the oldest retained event, or 0 when the log is empty. */
  get oldestSeq(): number {
    return this.#events[0]?.seq ?? 0;
  }

  append(type: string, body: unknown): LoggedEvent {
    const seq = ++this.#head;
    const entry: LoggedEvent = { seq, ts: Date.now(), type, body };

    this.#events.push(entry);
    this.#bytes += approxBytes(entry);
    this.#evict();

    return entry;
  }

  /**
   * Everything after `sinceSeq`, oldest first. `sinceSeq: 0` means "give me
   * the whole retained log".
   */
  since(sinceSeq: number): SinceResult {
    // A client ahead of us means the agent restarted and reset its counter.
    // Treat it as a full resync rather than silently returning nothing.
    if (sinceSeq > this.#head) {
      return { events: [...this.#events], truncated: true, head: this.#head };
    }

    const events = this.#events.filter((e) => e.seq > sinceSeq);
    const truncated = this.#events.length > 0 && sinceSeq > 0 && sinceSeq < this.oldestSeq - 1;

    return { events, truncated, head: this.#head };
  }

  /** Wrap a logged event in the wire envelope for this channel. */
  toEnvelope(e: LoggedEvent): Event {
    return {
      kind: 'event',
      ch: this.channel,
      type: e.type,
      seq: e.seq,
      stream: this.stream,
      body: e.body,
    };
  }

  #evict(): void {
    while (
      this.#events.length > this.maxEvents ||
      (this.#bytes > this.maxBytes && this.#events.length > 1)
    ) {
      const gone = this.#events.shift();
      if (!gone) break;
      this.#bytes -= approxBytes(gone);
      this.#dropped++;
    }
  }
}

/**
 * Cheap size estimate. Exact byte accounting would mean serializing every
 * event twice; the bound only needs to be approximately right to keep memory
 * from running away.
 */
function approxBytes(e: LoggedEvent): number {
  const body = e.body;
  let size = 64; // envelope overhead
  if (typeof body === 'string') size += body.length;
  else if (body != null) {
    try {
      size += JSON.stringify(body)?.length ?? 0;
    } catch {
      size += 1024; // circular or unserializable — charge a flat penalty
    }
  }
  return size;
}
