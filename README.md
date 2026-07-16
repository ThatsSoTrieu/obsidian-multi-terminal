# Many-Terminals

An Obsidian plugin that opens up to 6 real terminals inside a single tab — all visible at once in a resizable, reorderable grid.

*4 terminals*
![4 terminals in a 2×2 grid](https://raw.githubusercontent.com/ThatsSoTrieu/obsidian-multi-terminal/main/Multi-Terminal%204%20Terminals.png)

*6 terminals*
![6 terminals in a 3×2 grid](https://raw.githubusercontent.com/ThatsSoTrieu/obsidian-multi-terminal/main/Multi-Terminal%206%20Terminals.png)

---

## Features

- **1–6 terminals in one tab** — all visible simultaneously, no tab switching
- **Drag to resize** — drag the dividers between panes to resize them freely
- **Drag to reorder** — drag a pane's header to swap its position with another
- **Fullscreen toggle** — expand any terminal to fill the entire tab; click again to return to the grid
- **Real PTY** — uses Python's `pty.fork()` for a genuine pseudoterminal, so interactive programs like `vim`, `htop`, `man`, `ssh`, and `fzf` work correctly
- **Obsidian theme aware** — terminal colours and UI chrome follow your active Obsidian theme, including third-party themes; updates live when you switch themes
- **Keyboard navigation** — press `Alt+Arrow` inside any terminal to move focus to the next/previous pane without touching the mouse
- **Pane titles** — the header shows the current working directory (via OSC 7) or the active process title (via OSC 0/2) as the shell emits them
- **Configurable** — set terminal count, shell path, and font size from the plugin settings

---

## Requirements

- **Obsidian** 1.4.11 or later (desktop only)
- **Python 3** in your system `PATH` (uses the stdlib `pty` module — no third-party packages needed)

---

## Installation

### Community plugins (recommended)

Search for **Multi-Terminal** in **Settings → Community plugins → Browse**.

### Manual

1. Download `main.js`, `styles.css`, and `manifest.json` from the [latest release](https://github.com/ThatsSoTrieu/obsidian-multi-terminal/releases/latest)
2. Create a folder at `<your-vault>/.obsidian/plugins/multi-terminal/` and place the three files inside it
3. In Obsidian: **Settings → Community plugins → Installed plugins** → enable **Multi-Terminal**

---

## Usage

Open Multi-Terminal via:
- The **grid icon** in the left ribbon
- The command palette: `Open Multi-Terminal`

### Resizing panes

Drag the divider bars between panes to resize. Proportions are preserved when you change the terminal count.

### Reordering panes

Drag a pane by its **header bar** (the grip icon on the left) and drop it onto another pane to swap their positions.

### Fullscreen

Click the **maximize icon** (⤢) in any pane header to expand that terminal to fill the full tab. Click the **minimize icon** (⤡) or the button on another pane to exit.

### Keyboard navigation

Press `Alt+ArrowRight` or `Alt+ArrowDown` inside a terminal to move focus to the next pane. `Alt+ArrowLeft` or `Alt+ArrowUp` moves to the previous pane.

### Restarting a shell

Click the **refresh icon** (↺) in the pane header to kill and respawn the shell in that pane.

---

## Settings

| Setting | Default | Description |
|---|---|---|
| Terminal count | 4 | Number of panes shown at once (1–6). Updates live. |
| Shell | `/bin/sh` | Absolute path to the shell executable. Takes effect on next pane open or restart. |
| Font size | 12px | Terminal font size. Updates live across all open panes. |

---

## How it works

Each terminal pane spawns a Python process that calls `pty.fork()` to create a real pseudoterminal (PTY), then execs the configured shell inside it. Node's `child_process.spawn` connects four stdio streams: `stdin`/`stdout` carry shell I/O, and a fourth pipe (FD 3) carries resize events as `rows×cols\n` strings, which Python forwards to the PTY via `TIOCSWINSZ`.

[xterm.js](https://xtermjs.org/) renders the terminal in the browser layer. The grid layout uses CSS Grid with explicit fr-based column and row tracks; the divider bars are real grid children that update the track sizes on drag.

This approach — Python PTY proxy over stdio — is the same technique used by [polyipseity/obsidian-terminal](https://github.com/polyipseity/obsidian-terminal) and requires no native Node.js compilation.

The proxy is passed directly to Python rather than written to a shared temporary file. On restart, pane close, or plugin unload, it first terminates the shell and its foreground process group, then escalates only if they do not exit promptly.

---

## Limitations

- **Desktop only** — requires Node.js `child_process` and Python `pty`, which are not available in Obsidian mobile
- **Linux / macOS only** — `pty.fork()` is a POSIX API; Windows is not supported
- **Shell config for pane titles** — OSC 7 (CWD in the header) requires shell configuration. zsh with a modern prompt framework (Starship, Oh My Zsh, Powerlevel10k) emits it automatically. For bash, add to `~/.bashrc`:
  ```bash
  PROMPT_COMMAND='printf "\033]7;file://%s%s\007" "$HOSTNAME" "$PWD"'
  ```

---

## Development

Install dependencies, then run the build and smoke tests:

```bash
npm install
npm run build
npm test
```

The smoke suite verifies fragmented resize messages, shell exit-code propagation, and cleanup of a running foreground process.

---

## License

MIT
