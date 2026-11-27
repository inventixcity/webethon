import { Visitor } from './client.mjs';

// Minimal Server-Sent Events reader for fetch streams. Each parsed frame is passed to onFrame with the time
// it was received (performance.now), so delivery latency can be computed after the run.
export async function readFrames(response, onFrame) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return 'closed';
    buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');
    let end;
    while ((end = buffer.indexOf('\n\n')) !== -1) {
      const block = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      const frame = parseFrame(block);
      if (frame) onFrame({ ...frame, at: performance.now() });
    }
  }
}

function parseFrame(block) {
  let event = null;
  const data = [];
  let comment = false;
  let retry = false;
  for (const line of block.split('\n')) {
    if (line === '') continue;
    if (line.startsWith(':')) {
      comment = true;
      continue;
    }
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    const value = colon === -1 ? '' : line.slice(colon + 1).replace(/^ /, '');
    if (field === 'event') event = value;
    else if (field === 'data') data.push(value);
    else if (field === 'retry') retry = true;
  }
  if (event === null && data.length === 0) return comment || retry ? { event: retry ? 'retry' : 'comment', data: '' } : null;
  return { event: event ?? 'message', data: data.join('\n') };
}

// Opens one subscriber. `ready` resolves on the first frame (the server sends `retry` before it subscribes
// to the change feed, so after that frame, changes are not missed). `done` resolves when the stream ends.
export function subscribe(path, token, visitor = new Visitor()) {
  const controller = new AbortController();
  const subscriber = {
    visitor,
    frames: [],
    status: null,
    code: null,
    error: null,
    controller,
  };
  subscriber.ready = new Promise(resolve => {
    subscriber.markReady = resolve;
  });
  subscriber.done = (async () => {
    try {
      const response = await visitor.open(path, { token, signal: controller.signal });
      subscriber.status = response.status;
      if (response.status !== 200) {
        subscriber.code = (await response.text()).match(/"code"\s*:\s*"([A-Z_]+)"/)?.[1] ?? null;
        subscriber.markReady(false);
        return;
      }
      await readFrames(response, frame => {
        if (frame.event === 'retry') subscriber.markReady(true);
        else subscriber.frames.push(frame);
      });
    } catch (error) {
      subscriber.error = error?.name === 'AbortError' ? null : String(error?.message ?? error);
    } finally {
      subscriber.markReady(false);
    }
  })();
  return subscriber;
}
