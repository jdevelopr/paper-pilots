/**
 * net.js — host-authoritative PeerJS networking for local multiplayer.
 *
 * Copy into the generated project as js/net.js and extend. Expects the PeerJS UMD
 * bundle to be loaded first, exposing the global `Peer`.
 *
 * The host owns state and broadcasts it. Clients send inputs only.
 *
 * The host is the shared screen, never a player: it holds no seat, has no score, and
 * appears in no roster. `maxPlayers` therefore counts joining devices only — a
 * 4-player room means 4 phones plus the host display.
 * Seats are keyed by a persistent clientId in localStorage, so a dropped player
 * who reopens the join link resumes with their seat, name, and score intact.
 */

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no O/0, I/1/L
const CODE_LENGTH = 4;
const HELLO_TIMEOUT_MS = 10000;
const REAP_AFTER_MS = 120000;

export function makeRoomCode(n = CODE_LENGTH) {
  const bytes = crypto.getRandomValues(new Uint8Array(n));
  return Array.from(bytes, b => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('');
}

export function clientId() {
  let id = localStorage.getItem('cid');
  if (!id) {
    id = crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2);
    localStorage.setItem('cid', id);
  }
  return id;
}

export function joinUrl(code) {
  const u = new URL(window.location.href);
  u.search = '';
  u.hash = '';
  u.searchParams.set('room', code);
  return u.toString();
}

export function roomFromUrl() {
  const r = new URLSearchParams(location.search).get('room');
  return r ? r.trim().toUpperCase() : null;
}

const peerIdFor = (slug, code) => `${slug}-${code.toUpperCase()}`;

/* ------------------------------------------------------------------ host --- */

/**
 * @param {object} opts
 * @param {string} opts.slug        game slug, namespaces the peer id
 * @param {number} opts.maxPlayers
 * @param {object} opts.peerOptions passed to the Peer constructor (custom broker)
 * Events: open(code), roster(players), hello(seat), input(seat,payload),
 *         message(seat,msg), leave(seat), error(err)
 */
export function createHost({ slug, maxPlayers = 8, minPlayers = 2, peerOptions = {} } = {}) {
  const listeners = {};
  const on = (ev, fn) => ((listeners[ev] ||= []).push(fn), api);
  const emit = (ev, ...a) => (listeners[ev] || []).forEach(fn => fn(...a));

  /** @type {Map<string, {seat:number,cid:string,name:string,ready:boolean,score:number,conn:any,connected:boolean,goneAt:number|null}>} */
  const seats = new Map();
  let peer = null;
  let code = null;
  let phase = 'lobby';
  let attempts = 0;

  const roster = () =>
    [...seats.values()]
      .sort((a, b) => a.seat - b.seat)
      .map(({ seat, name, ready, score, connected }) => ({ seat, name, ready, score, connected }));

  function open() {
    code = makeRoomCode();
    peer = new Peer(peerIdFor(slug, code), peerOptions);

    peer.on('open', () => { emit('open', code); broadcastRoster(); });
    peer.on('connection', wire);
    peer.on('disconnected', () => { try { peer.reconnect(); } catch {} });
    peer.on('error', err => {
      // Room code collided on a shared broker — pick another and retry.
      if (err.type === 'unavailable-id' && attempts++ < 5) {
        try { peer.destroy(); } catch {}
        return open();
      }
      emit('error', err);
    });
  }

  function wire(conn) {
    let entry = null;
    const helloTimer = setTimeout(() => { if (!entry) conn.close(); }, HELLO_TIMEOUT_MS);

    conn.on('data', msg => {
      if (!msg || typeof msg !== 'object') return;
      if (entry && entry.conn === conn) entry.seen = Date.now();
      if (msg.t === 'pong') return;

      if (msg.t === 'hello') {
        clearTimeout(helloTimer);
        entry = admit(conn, msg);
        if (entry) { emit('hello', entry.seat); broadcastRoster(); }
        return;
      }
      if (!entry) return; // no identity yet, ignore

      if (msg.t === 'ready') {
        entry.ready = !!msg.ready;
        broadcastRoster();
      } else if (msg.t === 'input') {
        emit('input', entry.seat, msg.payload);
      } else {
        emit('message', entry.seat, msg);
      }
    });

    const drop = () => {
      clearTimeout(helloTimer);
      // A returning player's old connection can report 'close' after the new one
      // has already said hello. Only the seat's current connection may drop it.
      if (!entry || entry.conn !== conn) return;
      markGone(entry);
    };
    conn.on('close', drop);
    conn.on('error', drop);
  }

  function markGone(entry) {
    if (!entry.connected) return;
    entry.connected = false;
    entry.goneAt = Date.now();
    try { entry.conn?.close(); } catch {}
    entry.conn = null;
    emit('leave', entry.seat);
    broadcastRoster();
  }

  // Liveness: a phone that locks or loses Wi-Fi often never sends 'close'.
  // Ping every 2s; anyone silent for 7s is shown as reconnecting.
  setInterval(() => {
    const now = Date.now();
    for (const s of seats.values()) {
      if (!s.connected) continue;
      if (now - (s.seen || now) > 7000) markGone(s);
      else safeSend(s.conn, { t: 'ping', t0: now });
    }
  }, 2000);

  function admit(conn, msg) {
    const cid = String(msg.clientId || '');
    if (!cid) { safeSend(conn, { t: 'rejected', reason: 'Bad handshake' }); return null; }

    let entry = seats.get(cid);

    if (entry) {
      // Returning player: same seat, same score.
      if (entry.conn && entry.conn !== conn) { try { entry.conn.close(); } catch {} }
      entry.conn = conn;
      entry.connected = true;
      entry.goneAt = null;
      entry.seen = Date.now();
      if (msg.name) entry.name = String(msg.name).slice(0, 16);
    } else {
      if (seats.size >= maxPlayers) {
        safeSend(conn, { t: 'rejected', reason: 'Room is full' });
        setTimeout(() => conn.close(), 100);
        return null;
      }
      entry = {
        seat: nextSeat(), cid,
        name: String(msg.name || `Player ${seats.size + 1}`).slice(0, 16),
        ready: false, score: 0, conn, connected: true, goneAt: null, seen: Date.now(),
      };
      seats.set(cid, entry);
    }

    safeSend(conn, { t: 'welcome', seat: entry.seat, phase, players: roster() });
    return entry;
  }

  function nextSeat() {
    const taken = new Set([...seats.values()].map(s => s.seat));
    for (let i = 0; i < maxPlayers; i++) if (!taken.has(i)) return i;
    return seats.size;
  }

  // Must do both: broadcast to peers AND emit locally, or the host's own lobby UI
  // never updates when players join, ready up, or drop.
  const broadcastRoster = () => {
    const players = roster();
    broadcast({ t: 'lobby', players });
    emit('roster', players);
  };

  function broadcast(msg) {
    for (const s of seats.values()) if (s.connected) safeSend(s.conn, msg);
  }

  function sendTo(seat, msg) {
    const s = [...seats.values()].find(x => x.seat === seat);
    if (s?.connected) safeSend(s.conn, msg);
  }

  /** Remove players who have been gone longer than REAP_AFTER_MS. Call between rounds. */
  function reap(ms = REAP_AFTER_MS) {
    const now = Date.now();
    let changed = false;
    for (const [cid, s] of seats)
      if (!s.connected && s.goneAt && now - s.goneAt > ms) { seats.delete(cid); changed = true; }
    if (changed) broadcastRoster();
  }

  const api = {
    on, open, broadcast, sendTo, reap, roster,
    get code() { return code; },
    get joinUrl() { return code ? joinUrl(code) : null; },
    get players() { return [...seats.values()]; },
    // Host is not a player, so this counts joiners only.
    connectedCount: () => [...seats.values()].filter(s => s.connected).length,
    canStart() {
      const live = [...seats.values()].filter(s => s.connected);
      return live.length >= minPlayers && live.every(s => s.ready);
    },
    setPhase(p) { phase = p; },
    resetReady() { for (const s of seats.values()) s.ready = false; broadcastRoster(); },
    start(state) { phase = 'playing'; broadcast({ t: 'start', state }); },
    state(state) { broadcast({ t: 'state', ...state }); },
    event(name, data) { broadcast({ t: 'event', name, data }); },
    over(results) { phase = 'over'; broadcast({ t: 'over', results }); },
    destroy() { try { peer?.destroy(); } catch {} },
  };
  return api;
}

/* ---------------------------------------------------------------- client --- */

/**
 * Events: connected(), welcome(msg), lobby(players), start(state),
 *         state(msg), event(msg), over(results), rejected(reason),
 *         disconnected(), error(err)
 */
export function createClient({ slug, code, name, peerOptions = {} } = {}) {
  const listeners = {};
  const on = (ev, fn) => ((listeners[ev] ||= []).push(fn), api);
  const emit = (ev, ...a) => (listeners[ev] || []).forEach(fn => fn(...a));

  let peer = null, conn = null, seat = null, timer = null, lastHeard = 0, gone = false, watchdog = null;
  const queue = [];
  const goneOnce = () => { if (gone) return; gone = true; clearInterval(watchdog); emit('disconnected'); };
  const closeOnHide = () => { try { conn?.close(); } catch {} };
  window.addEventListener('pagehide', closeOnHide);

  function connect() {
    peer = new Peer(undefined, peerOptions); // auto id; host never dials back

    peer.on('open', () => {
      conn = peer.connect(peerIdFor(slug, code), { reliable: true });

      timer = setTimeout(() => {
        if (!conn?.open) emit('error', new Error('Could not reach that room. Check the code, or the host may have closed it.'));
      }, HELLO_TIMEOUT_MS);

      conn.on('open', () => {
        clearTimeout(timer);
        safeSend(conn, { t: 'hello', clientId: clientId(), name });
        while (queue.length) safeSend(conn, queue.shift());
        lastHeard = Date.now();
        watchdog = setInterval(() => { if (Date.now() - lastHeard > 8000) goneOnce(); }, 2000);
        emit('connected');
      });

      conn.on('data', msg => {
        if (!msg || typeof msg !== 'object') return;
        lastHeard = Date.now();
        if (msg.t === 'ping') { safeSend(conn, { t: 'pong', t0: msg.t0 }); return; }
        if (msg.t === 'welcome') { seat = msg.seat; emit('welcome', msg); }
        else if (msg.t === 'rejected') emit('rejected', msg.reason);
        else if (msg.t === 'lobby') emit('lobby', msg.players);
        else if (msg.t === 'start') emit('start', msg.state);
        else if (msg.t === 'state') emit('state', msg);
        else if (msg.t === 'event') emit('event', msg);
        else if (msg.t === 'over') emit('over', msg.results);
      });

      conn.on('close', () => goneOnce());
      conn.on('error', err => emit('error', err));
    });

    peer.on('disconnected', () => { try { peer.reconnect(); } catch {} });
    peer.on('error', err => emit('error', err));
  }

  function send(msg) {
    if (conn?.open) safeSend(conn, msg);
    else queue.push(msg); // sends before open are silently dropped by PeerJS
  }

  const api = {
    on, connect, send,
    input: payload => send({ t: 'input', payload }),
    ready: v => send({ t: 'ready', ready: !!v }),
    get seat() { return seat; },
    destroy() {
      gone = true; clearTimeout(timer); clearInterval(watchdog);
      window.removeEventListener('pagehide', closeOnHide);
      try { peer?.destroy(); } catch {}
    },
  };
  return api;
}

/* ---------------------------------------------------------------- shared --- */

// Class instances, Map, Set, and functions do not survive the wire — send plain data.
function safeSend(conn, msg) {
  try { conn?.open && conn.send(msg); } catch (e) { console.warn('send failed', e); }
}
