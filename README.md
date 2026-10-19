# Shelf

A file shelf shared by your computers. Drop a file on the shelf on one computer and it
shows up on the shelf of every other computer on the same network, ready to drag out.
After you drag something out it stays on the shelf for a little while, then clears itself.

Works on macOS and Windows. Files go straight from one computer to the other over your
local network. There's no account, no server, and nothing leaves your network.

## Download

Get the latest version from [Releases](https://github.com/barongartner/Shelf/releases/latest):

| Computer | File |
| --- | --- |
| Mac with Apple silicon (M1 and later) | `Shelf-<version>-mac-arm64.dmg` |
| Mac with Intel | `Shelf-<version>-mac-x64.dmg` |
| Windows, installed | `Shelf-Setup-<version>.exe` |
| Windows, no install | `Shelf-<version>-portable.exe` |

**macOS:** open the .dmg and drag Shelf to Applications. The first time, right-click
Shelf and choose Open (the app is signed but not notarized). Allow it when macOS asks
to find devices on your local network.

**Windows:** run the installer (or the portable exe). Allow it when Windows Firewall
asks; check **Private networks**.

## Using it

Shelf lives in the menu bar (Mac) or the notification area (Windows). Click the icon to
show or hide the shelf.

- **Put something on the shelf:** drag files or folders onto it, or press ⌘V / Ctrl+V
  to paste text, an image, or a copied file.
- **Take something off:** drag it from the shelf to the desktop, a folder, or another
  app. You can also click the download arrow to save it to Downloads, or double-click
  to open it.
- **Linger:** once something is dragged out it stays on every shelf for 10 minutes
  (changeable in Settings), with a countdown. Click **Keep** to cancel the countdown.
- **Remove:** click × on an item. It's removed from every computer.

Keyboard: ↑/↓ to select, Space for Quick Look (Mac), Enter to open, Delete to remove,
Esc to hide.

### Connecting your computers

1. Install and open Shelf on each computer.
2. On the second computer, open Settings (gear icon). Your first computer is listed
   under **Nearby**. Click **Join**.
3. The first computer asks whether to let it join. Click **Let It Join**.

Repeat for any other computers. Each shelf has a code (shown in Settings) that every
computer on it shares; only computers with the code can see or add to the shelf.

If your network blocks the automatic discovery (some guest and office networks do),
open **Other ways to connect** in Settings and either type the other computer's shelf
code or its IP address (shown in that same section on the other computer).

### Settings

- Name this computer shows to the others
- How long dragged-out items linger: 1, 5, 10, 30, or 60 minutes, or until removed
- Show the shelf when something arrives
- Keep the shelf on top of other windows
- Open Shelf at login

## How it works

Each computer runs a small server on port 47474 and announces itself on the network
with Bonjour/mDNS (`_shelf._tcp`). Computers on the same shelf exchange their item
lists whenever something changes and every 10 seconds otherwise, and each one
downloads a copy of every item it doesn't have yet, so items stay available even when
the computer that added them goes to sleep. Removal is final: once any computer removes
an item, or its linger time runs out, it's gone from all of them.

Files you drop are not copied on the computer you dropped them on; the shelf points at
the original, and removing the item never deletes your original. Copies that arrive
from other computers are kept in Shelf's app data folder and deleted when the item
leaves the shelf.

Requests between computers carry a key derived from the shelf code. Transfers are not
encrypted, so use Shelf on networks you trust, like your home network.

## Building from source

For developers. Needs Node.js 22.12 or later.

```bash
npm install
npm start            # run Shelf
npm run two          # run two copies on one computer, on the same shelf
npm test             # sync tests: two shelves talking over loopback
npm run dist:mac     # unsigned .dmg/.zip in dist/
npm run dist:win     # installer and portable .exe in dist/
```

Releases: bump `version` in package.json, tag `v<version>`, and push the tag. GitHub
Actions builds the Windows files and attaches them to the release.
`scripts/release-mac.sh --upload` builds, signs and attaches the macOS files.

## License

MIT
