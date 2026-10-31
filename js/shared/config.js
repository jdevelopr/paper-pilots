// config.js: deployment settings.
//
// PEER_OPTIONS goes straight to the PeerJS constructor. Empty means the free public
// PeerJS broker, which is fine for testing and small games with friends. For anything
// bigger, run your own PeerServer and fill this in, e.g.
//   { host: 'peer.yourdomain.com', port: 443, secure: true, path: '/' }
export const PEER_OPTIONS = {};

export const SLUG = 'paper-pilots-v1'; // namespaces room ids on the shared broker
export const MAX_PLAYERS = 4;          // phones only; the host screen never plays
export const MIN_PLAYERS = 1;          // one phone is enough to start a race
