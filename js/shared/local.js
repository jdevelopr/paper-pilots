// local.js: an in-page stand-in for net.js, used by solo mode.
// It exposes the same host and client surface the game uses, so the exact same
// flow and controller code run whether the "phone" is a real phone over PeerJS
// or a panel docked on the desktop. Messages are cloned and delivered on a
// microtask to mimic the wire (no shared references, no synchronous re-entry).

export function createLocalLink(name) {
  const hostL = {}, clientL = {};
  const on = (L, api) => (ev, fn) => ((L[ev] ||= []).push(fn), api);
  const emit = (L, ev, ...a) => (L[ev] || []).forEach(fn => fn(...a));
  const wire = msg => (typeof structuredClone === 'function' ? structuredClone(msg) : JSON.parse(JSON.stringify(msg)));
  const toClient = msg => {
    const m = wire(msg);
    queueMicrotask(() => {
      if (m.t === 'event') emit(clientL, 'event', m);
      else if (m.t === 'lobby') emit(clientL, 'lobby', m.players);
      else if (m.t === 'welcome') emit(clientL, 'welcome', m);
    });
  };

  const seat = { seat: 0, name, ready: true, score: 0, connected: true };
  let phase = 'lobby';

  const host = {
    on: null,
    open() { queueMicrotask(() => { emit(hostL, 'open', 'SOLO'); emit(hostL, 'hello', 0); }); },
    broadcast: toClient,
    sendTo: (s, msg) => { if (s === 0) toClient(msg); },
    event: (n, data) => toClient({ t: 'event', name: n, data }),
    roster: () => [{ ...seat }],
    get players() { return [seat]; },
    connectedCount: () => 1,
    canStart: () => true,
    setPhase: p => { phase = p; },
    resetReady() {},
    reap() {},
    destroy() {},
    get code() { return 'SOLO'; },
  };
  host.on = on(hostL, host);

  const client = {
    on: null,
    connect() { queueMicrotask(() => emit(clientL, 'welcome', { seat: 0, phase, players: host.roster() })); },
    send(msg) {
      const m = wire(msg);
      queueMicrotask(() => { if (m.t === 'input') emit(hostL, 'input', 0, m.payload); });
    },
    input(payload) { client.send({ t: 'input', payload }); },
    ready() {},
    get seat() { return 0; },
    destroy() {},
  };
  client.on = on(clientL, client);

  return { host, client };
}
