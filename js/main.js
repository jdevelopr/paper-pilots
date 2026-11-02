// main.js: entry point. Decides the role from the URL and loads only that code path.
//   ?room=ABCD  -> phone controller (joiner)
//   no param    -> home screen: host a room, play solo, or type a code
import { roomFromUrl } from './net.js';
import { $, show, mountPrefs } from './ui.js';
import { mountSetup } from './shared/setup.js';

const room = roomFromUrl();

if (room) import('./client/main.js').then(m => m.start(room)).catch(fatal);
else {
  show('home');
  // A failed join (closed room, wrong code) lands back here with a message
  let msg = null;
  try { msg = sessionStorage.getItem('homeMsg'); sessionStorage.removeItem('homeMsg'); } catch {}
  if (msg) { $('#home-status').textContent = msg; $('#join-code').value = sessionStorage.getItem('room') || ''; }
}

// The home screen's buttons are always wired up, whatever the address says
{
  $('#host-btn').onclick = () => import('./host/main.js').then(m => m.startHost()).catch(fatal);
  let soloSetup = null;
  $('#solo-btn').onclick = () => {
    if (!soloSetup) mountPrefs($('#solo-prefs'));
    soloSetup ||= mountSetup($('#solo-setup'), 'solo');
    $('#solo-name').value = localStorage.getItem('name') || '';
    show('solo');
    setTimeout(() => $('#solo-name').focus(), 250);
  };
  $('#solo-back').onclick = () => show('home');
  $('#stickers-btn').onclick = () => import('./client/stickerbook.js').then(m => m.openStickerBook({ seat: 0 })).catch(fatal);
  $('#solo-form').onsubmit = e => {
    e.preventDefault();
    const name = $('#solo-name').value.trim().slice(0, 12) || 'Pilot';
    localStorage.setItem('name', name);
    const bots = +document.querySelector('input[name=bots]:checked').value;
    const setup = soloSetup.read();
    import('./host/main.js').then(m => m.startSolo({ name, bots, setup })).catch(fatal);
  };
  $('#join-form').onsubmit = e => {
    e.preventDefault();
    const code = $('#join-code').value.trim().toUpperCase();
    if (code.length !== 4) { $('#home-status').textContent = 'Room codes are 4 letters'; return; }
    location.search = `?room=${code}`;
  };
  $('#join-code').addEventListener('input', e => { e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ''); });
}

function fatal(err) {
  console.error(err);
  if (room) { try { sessionStorage.setItem('homeMsg', 'Something failed to load. Check your connection and try again.'); } catch {} location.replace(location.pathname); return; }
  show('home');
  $('#home-status').textContent = 'Something failed to load. Check your connection and reload.';
}
