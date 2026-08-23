import { authenticatedFetch } from './api';

export type ServerSentEvent = {
  event: string;
  data: string;
};

export class ServerSentEventDecoder {
  private buffer = '';
  private eventName = '';
  private dataLines: string[] = [];

  push(chunk: string): ServerSentEvent[] {
    this.buffer += chunk;
    const events: ServerSentEvent[] = [];
    let newlineIndex = this.buffer.indexOf('\n');
    while (newlineIndex >= 0) {
      let line = this.buffer.slice(0, newlineIndex);
      this.buffer = this.buffer.slice(newlineIndex + 1);
      if (line.endsWith('\r')) line = line.slice(0, -1);
      this.consumeLine(line, events);
      newlineIndex = this.buffer.indexOf('\n');
    }
    return events;
  }

  finish(): ServerSentEvent[] {
    const events: ServerSentEvent[] = [];
    if (this.buffer.length > 0) {
      const line = this.buffer.endsWith('\r') ? this.buffer.slice(0, -1) : this.buffer;
      this.buffer = '';
      this.consumeLine(line, events);
    }
    this.dispatch(events);
    return events;
  }

  private consumeLine(line: string, events: ServerSentEvent[]): void {
    if (line === '') {
      this.dispatch(events);
      return;
    }
    if (line.startsWith(':')) return;

    const colonIndex = line.indexOf(':');
    const field = colonIndex >= 0 ? line.slice(0, colonIndex) : line;
    let value = colonIndex >= 0 ? line.slice(colonIndex + 1) : '';
    if (value.startsWith(' ')) value = value.slice(1);

    if (field === 'event') this.eventName = value;
    if (field === 'data') this.dataLines.push(value);
  }

  private dispatch(events: ServerSentEvent[]): void {
    if (this.dataLines.length === 0) {
      this.eventName = '';
      return;
    }
    events.push({
      event: this.eventName || 'message',
      data: this.dataLines.join('\n'),
    });
    this.eventName = '';
    this.dataLines = [];
  }
}

export async function streamAuthenticatedSse(
  url: string,
  onEvent: (event: ServerSentEvent) => void,
  options: RequestInit = {},
): Promise<void> {
  const response = await authenticatedFetch(url, {
    ...options,
    headers: {
      Accept: 'text/event-stream',
      ...options.headers,
    },
  });
  if (!response.ok) {
    throw new Error(`SSE request failed (HTTP ${response.status}).`);
  }
  if (!response.body) {
    throw new Error('SSE response did not include a readable body.');
  }

  const reader = response.body.getReader();
  const textDecoder = new TextDecoder();
  const eventDecoder = new ServerSentEventDecoder();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      for (const event of eventDecoder.push(textDecoder.decode(value, { stream: true }))) {
        onEvent(event);
      }
    }
    for (const event of eventDecoder.push(textDecoder.decode())) onEvent(event);
    for (const event of eventDecoder.finish()) onEvent(event);
  } finally {
    reader.releaseLock();
  }
}
