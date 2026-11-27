import { Pacer, sleep } from './pool.mjs';

// One read iteration for a virtual user: list (with paging), read one note, or search. Shared by the read
// scenario and the soak test, so both measure the same request mix.
const SEARCH_WORDS = ['garden', 'budget', 'invoice', 'meeting', 'groceries', 'travel', 'recipe', 'project'];
const SORTS = ['-updatedAt', 'createdAt', 'title', '-createdAt'];

// thinkMs is the pause a person takes between actions: each iteration waits thinkMs * (0.5 .. 1.5). Zero means a
// closed loop that saturates the server, which measures queueing rather than user experience.
export function readUser({ visitor, token, vu, thinkMs = 0, intervalMs = 110 }) {
  const pacer = new Pacer(intervalMs); // at most ~545 requests/min per IP, under the 600/min read budget
  const sort = SORTS[vu % SORTS.length];
  const state = { cursor: null, ids: [] };
  return async (recorder, random = Math.random) => {
    if (thinkMs > 0) await sleep(thinkMs * (0.5 + random()));
    await pacer.turn();
    const roll = random();
    if (roll < 0.6 || state.ids.length === 0) {
      const cursor = state.cursor ? `&cursor=${encodeURIComponent(state.cursor)}` : '';
      const response = await visitor.send('GET', `/api/v1/entities/notes?scope=mine&limit=20&sort=${sort}${cursor}`, { token });
      recorder.record('list', response);
      if (response.status === 200) {
        state.cursor = response.json.meta?.nextCursor ?? null;
        state.ids = response.json.data.map(note => note.id);
      } else {
        state.cursor = null;
      }
      return;
    }
    if (roll < 0.9) {
      const id = state.ids[Math.floor(random() * state.ids.length)];
      await pacer.turn();
      recorder.record('read', await visitor.send('GET', `/api/v1/entities/notes/${id}`, { token }));
      return;
    }
    await pacer.turn();
    const word = SEARCH_WORDS[Math.floor(random() * SEARCH_WORDS.length)];
    const filter = random() < 0.3 ? '&filter[pinned]=true' : '';
    recorder.record('search', await visitor.send('GET', `/api/v1/entities/notes?scope=mine&limit=20&q=${word}${filter}`, { token }));
  };
}
