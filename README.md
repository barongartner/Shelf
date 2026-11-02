# Shelf

A file shelf shared by your computers and your phone. Drop a file on the shelf on one
computer and it shows up on the shelf of every other computer on the same network, ready
to drag out. Open the shelf on your phone and the same files are there to save, and photos
from the phone go the other way. After something is taken it stays on the shelf for a
little while, then clears itself.

Works on macOS and Windows, with any phone or browser as a third device. Files go straight
from one device to the other over your local network. There's no account, no server in the
cloud, and nothing leaves your network.

## Download

Get the latest version from [Releases](https://github.com/barongartner/Shelf/releases/latest):

| Computer | File |
| --- | --- |
| Mac with Apple silicon (M1 and later) | `Shelf-<version>-mac-arm64.zip` or `.dmg` |
| Mac with Intel | `Shelf-<version>-mac-x64.zip` or `.dmg` |
| Windows, installed | `Shelf-Setup-<version>.exe` |
| Windows, no install | `Shelf-<version>-portable.exe` |

**Windows:** run the installer (or the portable exe). Allow it when Windows Firewall asks;
check **Private networks**.

**macOS:** the files on Releases are built by GitHub and are not notarized, so macOS
blocks them on first open. The quickest install skips that entirely. The repo is private,
so the download goes through the GitHub CLI (`brew install gh`, then `gh auth login`
once). In Terminal:

```bash
gh release download --repo barongartner/Shelf --pattern 'Shelf-*-mac-arm64.zip' --output /tmp/Shelf.zip --clobber && rm -rf /Applications/Shelf.app && ditto -x -k /tmp/Shelf.zip /Applications
```

(Use `mac-x64` in the pattern on an Intel Mac.) Then open Shelf from Applications. If you
downloaded the .zip or .dmg in Safari instead, open the app once, then go to System
Settings, Privacy & Security, scroll to Security and click **Open Anyway**. On macOS 14
and earlier, right-click the app and choose Open. Allow it when macOS asks to find devices
on your local network.

## Using it

Shelf lives in the menu bar (Mac) or the notification area (Windows). Click the icon to
show or hide the shelf; it pops up at the icon like the system's own flyouts, with a caret
pointing at it, until you drag it somewhere else (Settings has a button to dock it again).

- **Put something on the shelf:** drag files or folders onto it, or press Cmd+V / Ctrl+V to
  paste text, an image, or a copied file.
- **Take something off:** drag it from the shelf to the desktop, a folder, or another app.
  You can also click the download arrow to save it to Downloads, or double-click to open it.
- **Linger:** once something is taken it stays on every shelf for 10 minutes (changeable in
  Settings), with a countdown. Click **Keep** to cancel the countdown.
- **Remove:** click the x on an item. It's removed from every computer and phone.

Keyboard: Up/Down to select, Space for Quick Look (Mac), Enter to open, Delete to remove, Esc
to hide.

### Your phone

1. Click the phone button at the top of the shelf. A QR code appears.
2. Point the phone's camera at it and open the link. The shelf opens in the browser; there
   is nothing to install. (No camera handy? Open the address shown under the code and type
   the six-digit code.)
3. Put it on the Home Screen: Share, Add to Home Screen. The page offers this the first
   time and Settings on the page walks through it. The icon and the name are set, and the
   icon opens Shelf like an app, already signed in.

The phone stays signed in from then on: the computer remembers it, the page keeps a cookie
and a copy of the last shelf, and it reconnects by itself every time it opens, so the QR
code is a one-time thing. If the computer is asleep when the page is open, it says so and
picks up where it left off when the computer wakes. On the secure address (see below) the
Home Screen app even opens while the computer is asleep and shows the shelf as it was. You
only scan again if you remove the phone in the phone panel on a computer, or tap **Forget
this phone** on the page.

Two details behind that. The page moves itself to the computer's name on the network
(`PCNAME.local`) as soon as the phone can reach it, because that name stays the same when
the computer's address changes, so an icon added there keeps working. And an icon added to
the iOS Home Screen opens as an app with storage of its own, separate from Safari's, so the
app is handed the phone's token through its manifest: no second code, no second phone on
the shelf.

On the phone, photos and videos show as a grid and everything else as a list. Tap to open.
To get a photo into the Photos app, open it and press and hold it, then choose **Save to
Photos**. Other files, videos and whole folders download to the Files app with the
**Download** button; a folder arrives as a .zip. Press and hold a tile (or tap **Select**)
to pick several and download them together.

To send things the other way, use **Photos** and **Files** at the bottom of the page, or
paste text into the page. Items from the phone show up on every computer with the phone's
name on them.

**One-tap saving of many photos.** Browsers only open the share sheet from a secure
address, so by default photos are saved one at a time by pressing and holding. To get a
**Save N Photos** button, open Settings on the phone's shelf page and follow the three
steps under **Save to Photos**: download the certificate this computer made, install it,
trust it, and switch to the secure address. This is a one-time setup per computer.

### Connecting your computers

1. Install and open Shelf on each computer.
2. On the second computer, open Settings (gear icon). Your first computer is listed under
   **Nearby**. Click **Join**.
3. The first computer asks whether to let it join. Click **Let It Join**.

Repeat for any other computers. Each shelf has a code (shown in Settings) that every
computer on it shares; only computers with the code can see or add to the shelf. A phone
connected through any one computer can open the shelf through every computer on it.

If your network blocks the automatic discovery (some guest and office networks do), open
**Other ways to connect** in Settings and either type the other computer's shelf code or
its IP address (shown in that same section on the other computer).

### Settings

- Name this computer shows to the others
- How long taken items linger: 1, 5, 10, 30, or 60 minutes, or until removed
- Show the shelf when something arrives
- Keep the shelf on top of other windows (off, and the shelf hides when you click elsewhere)
- Open Shelf at login
- Move the shelf back next to its icon

## How it works

Each computer runs a small server on port 47474 (plus 47475 for the secure address) and
announces itself on the network with Bonjour/mDNS (`_shelf._tcp`). Computers on the same
shelf exchange their item lists whenever something changes and every 10 seconds otherwise,
and each one downloads a copy of every item it doesn't have yet, so items stay available
even when the computer that added them goes to sleep. Removal is final: once any computer
removes an item, or its linger time runs out, it's gone from all of them.

Files you drop are not copied on the computer you dropped them on; the shelf points at the
original, and removing the item never deletes your original. Copies that arrive from other
computers or phones are kept in Shelf's app data folder and deleted when the item leaves
the shelf.

Every request between computers is signed with a secret derived from the shelf code, and
the secret itself never travels; a device that only claims to be on the shelf learns
nothing. Phones get their own token when they scan the QR code, which the computers keep
and sync between themselves. Transfers between computers are not encrypted, so use Shelf on
networks you trust, like your home network. The secure address for phones uses a
certificate each computer makes for itself and that you can trust once on the phone.

## Building from source

For developers. Needs Node.js 22.12 or later.

```bash
npm install
npm start            # run Shelf
npm run two          # run two copies on one computer, on the same shelf
npm test             # sync, phone API, certificate, zip and hardening tests
npm run dist:mac     # unsigned .dmg/.zip in dist/
npm run dist:win     # installer and portable .exe in dist/
```

`SHELF_DEV=1 npm start` prints a pairing link for opening the phone page in a browser on
this computer and serves the page straight from `src/web` so edits show on reload.

Releases: bump `version` in package.json, tag `v<version>`, and push the tag. GitHub
Actions builds the Windows files and ad-hoc signed macOS files and attaches them to the
release. `scripts/release-mac.sh --upload` on a Mac builds, signs and replaces the macOS
files with properly signed ones.

## License

MIT
