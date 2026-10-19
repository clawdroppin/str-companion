<div align="center">

# 🛡️ STR Companion

**The all-in-one setup, cleanup and launch companion for _Skyrim Together Reborn_ co-op.**

Get your whole group onto the same setup, fix what breaks co-op, and play the campaign together, without digging through INI files and log folders.

[![Release](https://img.shields.io/github/v/release/clawdroppin/str-companion?style=flat-square&color=d2ac5c)](https://github.com/clawdroppin/str-companion/releases/latest)
![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20Linux%20%7C%20Steam%20Deck-2a251e?style=flat-square)
[![CI](https://img.shields.io/github/actions/workflow/status/clawdroppin/str-companion/ci.yml?branch=main&style=flat-square&label=tests)](https://github.com/clawdroppin/str-companion/actions)
![Skyrim](https://img.shields.io/badge/Skyrim-Special%20Edition%20(Steam)-2a251e?style=flat-square)
[![License: MIT](https://img.shields.io/badge/license-MIT-2a251e?style=flat-square)](LICENSE)

![Dashboard](docs/screenshots/dashboard.png)

</div>

---

## ⬇️ Download

Get the latest version from **[Releases](https://github.com/clawdroppin/str-companion/releases/latest)**. Every build is portable, so there's nothing to install.

### 🪟 Windows
1. Download **`STR-Companion-x.y.z.exe`** and run it.
2. Windows may show **"Windows protected your PC"** because the app isn't code-signed. Click **More info → Run anyway**.

### 🐧 Linux / Steam Deck
Skyrim runs through **Proton**. The app finds the game in your Steam library (native, Flatpak or Snap Steam) and reads saves, `Plugins.txt` and INIs from inside the Proton prefix automatically.

1. Download **`STR-Companion-x.y.z-linux-x86_64.AppImage`**, then:
   ```bash
   chmod +x STR-Companion-*.AppImage
   ./STR-Companion-*.AppImage
   ```
   If it won't start on Ubuntu 22.04+, install FUSE 2 (`sudo apt install libfuse2`) or use the `.tar.gz` instead: extract it and run `str-companion`.
2. To **launch Skyrim Together and the server** from the app, install **[protontricks](https://github.com/Matoking/protontricks)** (from your distro, or Flathub `com.github.Matoking.protontricks`). It starts the Windows programs inside Skyrim's Proton prefix. The server also runs with plain Wine if you have it.
3. On **Steam Deck**, use Desktop Mode.
4. Optional: install `7zip` (or `p7zip` with its rar plugin) to install `.rar` mods.

### First run
The app finds Skyrim through Steam. If it doesn't, point it at the folder that contains `SkyrimSE.exe`.

> **Everyone in your group should use it.** The best part is **Friends Sync**, which shows exactly what's different between your setups.

---

## ✨ What it does

| | |
|---|---|
| 🩺 **Dashboard** | Health check of your whole setup: game version, SKSE, Address Library, Skyrim Together, **missing master files** (the #1 cause of startup crashes), plugin limits, problem mods, Anniversary Edition content, and Steam auto-updates. It also warns when **Steam updated Skyrim** since your last session, flags **Skyrim Together's plugins being switched off**, and summarizes the **last crash**. Most problems have a **one-click fix**. |
| ★ **Quick Setup** | For friends on a fresh install: paste the host's setup code and add a Nexus API key. The app installs **every mod at the host's exact version**, runs mod installers (FOMOD) with their recommended options, moves extra Anniversary content aside, matches the load order and applies the co-op game settings. **Premium** Nexus accounts are fully automatic. **Free** accounts click "Slow download" once per mod, because STR Companion handles Nexus's *Mod Manager Download* links. |
| ▶️ **Play & Server** | Launch Skyrim Together (your saves are **snapshotted automatically first**), start, stop or restart your server, see who's connected live, and **copy a ready-made invite** (address, password and setup code) for your group chat. |
| 🧩 **Mods** | A curated catalog (Required · Stability · Recommended · Visuals · More content), each labeled by Skyrim Together compatibility. **Install, update-check and uninstall** in one place. Add any Nexus mod by link, or install from an archive. For SKSE mods, it shows whether they **actually loaded** on your game version. |
| 🧹 **Cleanup** | Moves Anniversary Edition add-ons into a backup, **keeping the 4 free ones USSEP needs**. Also flags known-incompatible mods, and lets you switch off or set aside any plugin, with a warning if other mods depend on it. |
| ⚙️ **Config Editor** | Friendly editors with plain-English descriptions for `STServer.ini`, `SkyrimPrefs.ini`, `Skyrim.ini`, `SkyrimCustom.ini` and Engine Fixes. **One-click presets** include *Story Co-op (3 players)*, *Hardcore*, *Big Group*, *Performance* and *Quality*, and you can save your own. |
| ⇄ **Friends Sync** | Each player copies a short `STR2-…` setup code. Paste a friend's code to see mismatched game versions, missing plugins and load order differences. **Match the host's load order in one click**, with Nexus links for anything you're missing. Save friends to your **party** and see at a glance who's in sync. |
| 💾 **Backups** | **Save snapshots**, taken automatically before every launch (old automatic ones are pruned, yours are kept), plus a restorable history of every file the app moved or replaced. Shows disk usage, and lets you delete what you no longer need. |
| ✅ **Session Checklist** | The pre-session routine that keeps quests in sync, plus a stuck-quest helper. |
| 📜 **Logs** | Server, client, SKSE and Engine Fixes logs in one place, plus a **crash report reader** that names the mods showing up most in each crash (with [Crash Logger](https://www.nexusmods.com/skyrimspecialedition/mods/59818) installed). |

### 🔒 Safe by design
- **Nothing is ever deleted.** Files are *moved* to `<Skyrim>\_STRCompanion_Backup\`, with a manifest so every batch can be restored.
- Config files are **snapshotted before every save**.
- Base-game files and the plugins Skyrim Together needs are **locked** and can't be moved.
- INI and load-order changes are **blocked while Skyrim is running**, because the game would overwrite them on exit.
- Paths are checked so nothing outside the game folder can ever be moved, including by a malicious mod archive.
- Your Nexus API key is stored encrypted (Windows secure storage, or your Linux keyring) and only sent to `nexusmods.com`.

<details>
<summary><b>📸 More screenshots</b></summary>

| Mods | Config Editor |
|---|---|
| ![Mods](docs/screenshots/mods.png) | ![Config](docs/screenshots/config.png) |
| **Cleanup** | **Backups** |
| ![Cleanup](docs/screenshots/cleanup.png) | ![Backups](docs/screenshots/backups.png) |

</details>

---

## 🎮 Quick start for a campaign with friends

**Friends setting up from scratch:** install Skyrim from Steam, open STR Companion and go to **Quick Setup**:
1. Paste the host's setup code (they copy it from **Friends Sync**, or from **Copy invite** on the Play page).
2. Click **Open my API key page**, copy your *Personal API Key* from Nexus Mods (a free account works) and paste it in.
3. Free account? Turn on **Let STR Companion handle "Mod Manager Download" links**.
4. Click **Set up everything**. Free accounts click **Slow download** on each Nexus page that opens; everything else is automatic.
5. When it says you match the host, launch from **Play & Server**.

**Hosting, or setting it up by hand:**


1. **Everyone:** open STR Companion and go through the **Dashboard** until everything is green or yellow.
2. **Everyone:** **Cleanup → Move Anniversary add-ons to backup**, unless you all own and enable exactly the same ones.
3. **Everyone:** **Friends Sync**. Post your code in your group chat, then paste the host's code and click **Match their load order**. Install anything listed as missing, and save friends to your party.
4. **Host:** **Config Editor → Skyrim Together server → Story Co-op (3 players)**, then set a join password.
5. **Host:** **Play & Server → Start server**. Share your `IP:port` (forward the port on your router, or use Tailscale or ZeroTier).
6. **Everyone:** **Launch Skyrim Together** (saves are snapshotted automatically first) and connect with **F2**. The host can use **Copy invite** to share the address and password.
7. Pick **one party leader** for the whole campaign. Quest progress syncs from them.

## 🔑 Nexus Mods integration

Add your **personal API key** (Nexus → *Settings → API keys*) under **Settings** to enable update checks and mod details.

- **Premium accounts:** installs download directly.
- **Free accounts:** the app opens the mod's Nexus page. Click **Manual download**, and the app picks up the file from your Downloads folder and offers to install it.
- Mods with an installer that has options (FOMOD) should be installed with **Vortex** instead. The app tells you when that's the case.
- `.rar` archives need [7-Zip](https://www.7-zip.org/) installed. `.7z` and `.zip` work out of the box.

## ❓ FAQ

<details><summary><b>I use Vortex. Will this conflict?</b></summary>

No. The app detects Vortex-managed mods and reads their versions, and it sends you to Vortex to update those. If you move a Vortex-managed file, Vortex may say it was "changed externally". Choose to keep the change, or better, disable that mod in Vortex.
</details>

<details><summary><b>Why does it say my SKSE mod "needs a build for my game version"?</b></summary>

SKSE plugins (`.dll` files) are tied to specific game versions. After you launch the game once, the card shows **"Loads on your game"** or **"Didn't load"** based on the SKSE log.
</details>

<details><summary><b>How do I undo something?</b></summary>

**Backups → Restore all**, or restore single files. Uninstalling a mod also puts back any original files it had replaced.
</details>

<details><summary><b>Steam updated Skyrim and now nothing works!</b></summary>

SKSE and Skyrim Together need updates for each new game version. The Dashboard can set Steam to **"Only update when I launch"** (close Steam first) so this doesn't happen mid-campaign.
</details>

---

## 🛠️ Building from source

Requires **Node.js 20+**.

```bash
npm install
npm start            # run the app
npm test             # unit tests (fake game folders in your temp dir, never your real install)
npm run dist         # Windows portable exe -> dist/
npm run dist:linux   # Linux AppImage + tar.gz -> dist/ (build on Linux)
```

Every push runs the tests on Windows and Linux in [GitHub Actions](.github/workflows/ci.yml). That includes a Linux UI smoke test that opens every page against a fake Proton install. Publishing a GitHub release builds and attaches the Windows and Linux downloads automatically.

Contributors and AI agents: read **[AGENTS.md](AGENTS.md)** first. It covers the architecture, the safety rules the code relies on, and how to verify the UI.

---

<sub>STR Companion is an unofficial fan tool. It is not affiliated with the Tilted Phoques team (Skyrim Together Reborn), Bethesda, or Nexus Mods. Mod recommendations come from the Skyrim Together FAQ and community reports, so test before long sessions.</sub>
