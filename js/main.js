// main.js: entry point. Decides the role from the URL and loads only that code path.
//   ?room=ABCD  -> phone controller (joiner)
//   no param    -> home screen: host a room, play solo, or type a code
import { roomFromUrl } from './net.js';
import { $, show } from './ui.js';
import { mountSetup } from './shared/setup.js';

const room = roomFromUrl();

if (room) {
  import('./client/main.js').then(m => m.start(room)).catch(fatal);
} else {
  show('home');
  $('#host-btn').onclick = () => import('./host/main.js').then(m => m.startHost()).catch(fatal);
  let soloSetup = null;
  $('#solo-btn').onclick = () => {
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
  show('home');
  $('#home-status').textContent = 'Something failed to load. Check your connection and reload.';
}
