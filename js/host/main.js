// host/main.js: the shared screen. Opens a room (or a solo session), runs the
// lobby, then hands control to the round flow. The host is never a player.

import { createHost, joinUrl } from '../net.js';
import { createLocalLink } from '../shared/local.js';
import { SLUG, MAX_PLAYERS, MIN_PLAYERS, PEER_OPTIONS } from '../shared/config.js';
import { $, show, toast, renderRoster } from '../ui.js';
import { createRenderer } from './render3d.js';
import { createHud } from './hud.js';
import { createFlow } from './flow.js';
import { initAudio } from './audio.js';
import { mountSetup } from '../shared/setup.js';

const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

function fail(msg) {
  show('home');
  $('#home-status').textContent = msg;
}

async function fontsReady() {
  // Canvas labels in 3D are drawn with the handwriting font, so wait for it briefly.
  try { await Promise.race([document.fonts.load('700 48px Caveat'), new Promise(r => setTimeout(r, 1500))]); } catch {}
}

function makeStage() {
  const renderer = createRenderer($('#stage'), { reduceMotion });
  const hud = createHud($('#hud'));
  return { renderer, hud };
}

function runLoop(flow) {
  let last = performance.now();
  const loop = now => {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    flow.tick(dt);
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
}

/* --------------------------------------------------------------- room --- */
export async function startHost() {
  initAudio();
  document.body.classList.add('is-host');
  $('#home-status').textContent = 'Opening a room…';
  const host = createHost({ slug: SLUG, maxPlayers: MAX_PLAYERS, minPlayers: MIN_PLAYERS, peerOptions: PEER_OPTIONS });
  let flow = null, stage = null;
  const setup = mountSetup($('#host-setup'), 'host');

  host.on('open', async code => {
    const url = joinUrl(code);
    $('#room-code').textContent = code;
    $('#join-url').textContent = url.replace(/^https?:\/\//, '');
    $('#copy-link').onclick = async () => {
      try { await navigator.clipboard.writeText(url); toast('Link copied'); } catch { toast(url, 5000); }
    };
    $('#home-status').textContent = '';
    show('lobby');
    try {
      await QRCode.toCanvas($('#qr'), url, { width: 240, margin: 1, color: { dark: '#2c2416', light: '#fffdf6' } });
    } catch (e) {
      console.error('QR render failed', e);
      $('#lobby-status').textContent = `Join at ${url}`;
    }
  });

  host.on('roster', players => {
    if (flow && flow.phase !== 'lobby') return;
    renderRoster(players, MAX_PLAYERS);
    const ready = host.canStart();
    $('#start-btn').disabled = !ready;
    $('#lobby-status').textContent =
      !players.length ? 'Scan to join'
      : players.length >= MAX_PLAYERS && ready ? ''
      : ready ? '' : 'Everyone must be ready to start';
  });
  host.on('hello', seat => flow?.onHello(seat));
  // Stickers can arrive while everyone's still in the lobby, before the flow exists
  const lobbyStickers = new Map();
  host.on('input', (seat, payload) => {
    if (!flow && payload?.k === 'stickers') { lobbyStickers.set(seat, Array.isArray(payload.list) ? payload.list.slice(0, 12) : []); return; }
    flow?.onInput(seat, payload);
  });
  host.on('error', err => {
    console.error(err);
    if (!flow || flow.phase === 'lobby') fail(err.type === 'network' || err.type === 'server-error'
      ? 'Could not reach the matchmaking server. Check your connection.'
      : err.message || 'Could not open a room.');
  });

  $('#start-btn').onclick = async () => {
    if (!host.canStart()) return;
    if (!stage) { await fontsReady(); stage = makeStage(); }
    if (!flow) {
      flow = createFlow({
        link: host, ...stage, solo: false, stickers: lobbyStickers,
        onExit: () => { flow.stop(); host.resetReady(); show('lobby'); renderRoster(host.roster(), MAX_PLAYERS); },
      });
      runLoop(flow);
      bindHostKeys(flow);
    }
    const choice = setup.read();
    await show('game');
    stage.renderer.resize();
    flow.start(choice);
  };

  window.addEventListener('beforeunload', e => {
    if (flow && flow.phase !== 'lobby') { e.preventDefault(); e.returnValue = ''; }
  });

  host.open();   // nothing happens until this is called
}

/* --------------------------------------------------------------- solo --- */
// A phone (or small touch tablet) plays solo full screen: the race on top,
// the controls underneath, no host screen needed.
const isTouch = () => matchMedia('(pointer: coarse)').matches && Math.min(innerWidth, innerHeight) < 820;

export async function startSolo({ name, bots, setup }) {
  initAudio();
  const touch = isTouch();
  document.body.classList.add('is-host', ...(touch ? ['pv-touch', 'solo-touch'] : ['solo']));
  if (touch) { try { await document.documentElement.requestFullscreen?.({ navigationUI: 'hide' }); } catch {} }
  const { host, client } = createLocalLink(name);
  await fontsReady();
  const stage = makeStage();
  const flow = createFlow({
    link: host, ...stage, solo: true, botCount: bots,
    onExit: () => location.reload(),
  });
  host.on('input', (seat, payload) => flow.onInput(seat, payload));
  host.on('hello', seat => flow.onHello(seat));

  const { mountController } = await import('../client/controller.js');
  mountController($('#controller'), client, touch
    ? { solo: true, onAgain: () => flow.start(setup), onMenu: () => location.reload() }
    : { solo: true });
  client.connect();
  host.open();

  await show('game');
  stage.renderer.resize();
  runLoop(flow);
  bindHostKeys(flow);
  flow.start(setup);
}

function bindHostKeys(flow) {
  window.addEventListener('keydown', e => {
    if (e.key === 'Enter' || (e.key === ' ' && !document.body.classList.contains('solo'))) {
      if (document.activeElement?.tagName === 'BUTTON') return;
      flow.skip();
    }
  });
}
