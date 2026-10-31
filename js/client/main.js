// client/main.js: a phone joining a room. Name -> lobby (ready up) -> controller.
// Reopening the join link restores the same seat, name and clips (net.js keys
// seats by a persistent client id), so reconnecting takes zero taps.

import { createClient } from '../net.js';
import { SLUG, MAX_PLAYERS, PEER_OPTIONS } from '../shared/config.js';
import { $, show, toast, renderRoster, vibrate } from '../ui.js';
import { colorFor } from '../shared/colors.js';
import { mountController } from './controller.js';

let client = null, ctl = null, mySeat = null, ready = false, everWelcomed = false, retry = 0;
let view = null, viewLoading = null;

// Every player gets their own 3D chase view of the race. On a desktop the
// controls dock in the corner (like solo); on a phone the view takes the top
// of the screen and the controls sit below it.
const touch = matchMedia('(pointer: coarse)').matches && Math.min(innerWidth, innerHeight) < 820;
document.body.classList.add('pv', touch ? 'pv-touch' : 'solo');

async function ensureView() {
  if (view) return view;
  if (!viewLoading) viewLoading = (async () => {
    try { await Promise.race([document.fonts.load('700 48px Caveat'), new Promise(r => setTimeout(r, 1500))]); } catch {}
    const { createPlayerView } = await import('./view.js');
    view = createPlayerView({ stage: $('#stage'), hudRoot: $('#hud'), getSeat: () => mySeat });
    return view;
  })();
  return viewLoading;
}
// Messages that arrive while the 3D view is still loading are queued, not lost
const pending = [];
function toView(fn) {
  if (view) return fn(view);
  pending.push(fn);
  ensureView().then(v => { while (pending.length) pending.shift()(v); });
}

export function start(code) {
  sessionStorage.setItem('room', code);
  const name = localStorage.getItem('name');
  if (!name) return promptName(code);
  connect(code, name);
}

function promptName(code) {
  show('name');
  $('#name-input').value = '';
  setTimeout(() => $('#name-input').focus(), 300);
  $('#name-form').onsubmit = e => {
    e.preventDefault();
    const n = $('#name-input').value.trim().slice(0, 12);
    if (!n) return;
    localStorage.setItem('name', n);
    connect(code, n);
  };
}

function fail(msg) {
  show('home');
  $('#home-status').textContent = msg;
  $('#join-code').value = sessionStorage.getItem('room') || '';
  // Typing a code on the home screen re-joins via ?room=
}

function connect(code, name) {
  if (client) { try { client.destroy(); } catch {} }
  client = createClient({ slug: SLUG, code, name, peerOptions: PEER_OPTIONS });

  if (!ctl) ctl = mountController($('#controller'), {
    get seat() { return mySeat; },
    on: (ev, fn) => { handlers.push([ev, fn]); },
    input: p => client?.input(p),
  });

  client.on('welcome', msg => {
    everWelcomed = true; retry = 0;
    mySeat = msg.seat;
    $('#me-chip').innerHTML = '';
    $('#me-chip').textContent = name;
    $('#me-chip').style.color = colorFor(mySeat);
    renderRoster(msg.players, MAX_PLAYERS, mySeat);
    ensureView();
    if (msg.phase === 'lobby' || msg.phase === 'over') show('lobby');
    else show('game').then(() => view?.resize());
  });
  client.on('lobby', players => {
    renderRoster(players, MAX_PLAYERS, mySeat);
    const mine = players.find(p => p.seat === mySeat);
    if (mine) { ready = mine.ready; paintReady(); }
  });
  client.on('event', msg => {
    if (msg.name === 'phase') {
      if (msg.data.phase === 'lobby') show('lobby');
      else { show('game').then?.(() => view?.resize()); }
      toView(v => v.setPhase(msg.data));
    }
    if (msg.name === 'layout') toView(v => v.setLayout(msg.data));
    if (msg.name === 'snap') { if (view) view.addSnap(msg.data); return; }
    if (msg.name === 'fx' && view) view.fx(msg.data);
    for (const [ev, fn] of handlers) if (ev === 'event') fn(msg);
  });
  client.on('rejected', reason => fail(reason === 'Room is full' ? 'That room is full' : reason));
  client.on('error', err => {
    console.error(err);
    if (!everWelcomed) {
      fail(err.type === 'peer-unavailable' || /reach that room/.test(err.message || '')
        ? 'No room with that code. Check it, or the host may have closed it.'
        : 'Could not connect. Check your connection and try again.');
    } else reconnectSoon(code, name);
  });
  client.on('disconnected', () => { if (everWelcomed) reconnectSoon(code, name); });

  $('#ready-btn').onclick = () => {
    ready = !ready;
    client.ready(ready);
    vibrate(ready ? [10, 30, 10] : 10);
    paintReady();
  };
  client.connect();
}

const handlers = [];

function paintReady() {
  $('#ready-btn').textContent = ready ? 'Not ready' : 'Ready';
  $('#ready-btn').classList.toggle('primary', !ready);
}

let reconnTimer = null;
function reconnectSoon(code, name) {
  if (reconnTimer) return;
  toast('Reconnecting…', 2500);
  reconnTimer = setTimeout(() => {
    reconnTimer = null;
    if (retry++ > 8) return fail('Lost the room. The host may have closed it.');
    connect(code, name);
  }, Math.min(4000, 800 + retry * 600));
}
