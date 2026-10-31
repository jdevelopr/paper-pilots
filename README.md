# Paper Pilots

A party game where up to 4 players race paper airplanes through an office building. One screen (a laptop or TV) shows the race. Everyone else plays on their phone by scanning a QR code.

Each floor of the building is raced **3 times** before the elevator goes up:

1. Lobby
2. Cubicle Farm
3. Break Room
4. Server Room
5. Executive Suite

You throw your plane from the launch desk, then glide it the rest of the way. Paper planes can't fly forever, so you want to land in the best landing zone you can reach. Zones farther away pay more paper clips. Along the way you can grab clips floating in the air, ride the floor vents to gain height, stay away from the ceiling fans that push you down, and avoid crashing into the furniture.

After every race, players spend their paper clips in the **Supply closet**. Points from race placings decide the overall winner, the **Employee of the month**.

## How to play

| | On a phone | On a keyboard |
|---|---|---|
| Aim | Drag sideways on the throw pad | Left / Right arrows |
| Angle | Slider on the left | Up / Down arrows |
| Throw | Pull back on the pad, then let go | Hold **Space**, then release |
| Steer | Joystick: left/right turns, up climbs, down dives | WASD or the arrow keys |

On the host screen, **Enter** (or Space) skips the floor intro and the results screen.

**Flying tips:** Diving builds speed. Climbing turns that speed back into height. If you climb too hard you'll stall and drop. Floor vents (the round grates with streaks rising out of them) lift you up. Hitting the ceiling or furniture costs durability, and at zero durability your plane crumples into a ball and earns no zone payout. Zones painted on top of desks, tables, the fridge and so on only count if you land on the top surface.

**Payouts each race:** you get the landing zone's value (3 / 6 / 10 / 15 / 24 clips), plus 8 / 5 / 3 / 1 clips for placing 1st to 4th, plus any clips you picked up. Placings also give 10 / 6 / 3 / 1 points toward the overall win. A plane that crumples gets no zone or placement reward.

**Ranking within a race:** the best zone wins. Ties go to whoever flew farther. Missing every zone ranks below any zone landing, and crumpling ranks last.

### Upgrades

| Upgrade | Cost | Effect |
|---|---|---|
| Cardstock | 12 | +70 durability, but heavier, so it sinks faster |
| Rubber Band Launcher | 10 | Faster launch |
| Wide Wing Fold | 14 | Glides much longer, but turns slower |
| Glossy Paper | 10 | Less drag, but slides farther when it lands |
| Sticky Note Flaps | 8 | Sharper turns, slightly more drag |
| Nose Clip | 8 | Fans barely push you, slightly heavier |
| Packing Tape | 9 | Takes 40% less damage |
| Fridge Magnet | 7 | Pulls in paper clips from farther away |
| Binder Clip Brake | 6 | Stops almost dead when it lands |

Upgrades show up on your plane in 3D: the magnet, tape strips, yellow flaps, nose clip and so on.

## Solo flight (no phone needed)

On the home screen, click **Solo flight**. Pick 0–3 computer rivals and either 3 or 5 floors (9 or 15 races). The phone controller appears as a panel in the corner of the screen, and you can use it with the mouse or the keyboard. This is the quickest way to try out the gameplay.

## Run it locally

The game is static files with no build step. Opening `index.html` by double-clicking won't work, because browsers block ES modules and WebRTC on `file://`. Serve the folder instead:

```bash
cd paper-pilots
python3 -m http.server 8080
# then open http://localhost:8080
```

Solo mode works on `localhost` right away.

To test multiplayer on one computer, open the host in a normal window and join from a **private/incognito** window. Two tabs in the same window share a player identity, so the second tab would take over the first one's seat.

Real phones need HTTPS, so deploy first (see below) and then scan the QR code.

## Deploy to AWS Amplify (HTTPS, free tier)

**Drag and drop (easiest):**

1. Zip the `paper-pilots` folder. The zip should contain `index.html` at its top level, not inside a parent folder.
2. In the AWS Amplify console, choose **Create new app**, then **Deploy without Git**.
3. Drop the zip in. Amplify gives you an `https://….amplifyapp.com` URL.
4. To update the game later, drop in a new zip.

**From Git:** connect the repo in Amplify. The included `amplify.yml` deploys the files as-is with no build step.

Netlify, Vercel, Cloudflare Pages and GitHub Pages all work the same way with no configuration.

Join links look like `https://your-site/?room=ABCD`. The QR code is built from whatever address the host page is on, so it always points at the right place.

## Before real use: the matchmaking server

Phones connect directly to the host (peer-to-peer WebRTC). A small "broker" server introduces them to each other first. Out of the box the game uses the free public PeerJS broker. That's fine for playing with friends, but it has no uptime guarantee.

For anything public, run your own PeerServer (`npm i -g peer` and then `peerjs --port 9000`, or use the official Docker image) behind HTTPS. Then put its address in `js/shared/config.js`:

```js
export const PEER_OPTIONS = { host: 'peer.yourdomain.com', port: 443, secure: true, path: '/' };
```

**Networks:** players on the same Wi-Fi connect directly. Players on very different networks (strict corporate or mobile carrier NATs) may need a TURN server. You can add one with `config: { iceServers: [...] }` in `PEER_OPTIONS`.

## Good to know

- **The host screen is not a player.** A 4-player game means 4 phones plus the screen. You can start a race with just 1 phone.
- **Reconnecting:** if a phone locks or drops, reopen the same link (or let the page reconnect on its own). The player gets the same seat, name, clips and upgrades back. On the host, a dropped player's card is greyed out while they're away, and their plane keeps gliding on its own.
- **Closing the host tab ends the room.** The browser will ask you to confirm if a game is in progress.
- **Reduced motion:** if the operating system's "reduce motion" setting is on, the game turns off screen shake, line wobble and most animations. Everything is still playable.

## Project layout

```
index.html            all screens, CDN tags, Three.js import map
css/style.css         cork board + paper art direction, motion system
js/main.js            picks host / solo / phone from the URL
js/net.js             PeerJS host-authoritative networking (rooms, reconnect, liveness)
js/ui.js              screen switching, roster sticky notes, toast
js/shared/            config, colours, upgrade catalogue, solo local link
js/game/              pure rules: flight sim, floors, bots, payouts (no DOM)
js/host/              shared screen: flow, 3D renderer, ink shader, HUD, sound
js/client/            phone: join flow and controller
```

To tune the game, edit:

- `js/game/sim.js` for flight physics (`SIM` constants)
- `js/game/floors.js` for level layouts, vents, fans, zones and clip placement
- `js/shared/upgrades.js` for upgrade costs and stats
- `js/game/rules.js` for payouts and `RACES_PER_FLOOR` (races on each floor)

The rendering style is a custom post-process in `js/host/ink.js`. It draws ink outlines from depth and normal edges, adds pencil crosshatching in the shadows, and puts paper grain over everything, with lines that "boil" at 6 fps like a hand-drawn animation.
