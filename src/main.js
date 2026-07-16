'use strict';

const {
  Plugin, ItemView, setIcon,
  PluginSettingTab, Setting, FileSystemAdapter,
} = require('obsidian');
const { spawn }    = require('child_process');
const { homedir }  = require('os');
const { Terminal } = require('@xterm/xterm');
const { FitAddon } = require('@xterm/addon-fit');

// ─── Python PTY proxy ─────────────────────────────────────────────────────────

const PTY_PROXY_PY = `import sys, os, time, signal, ctypes

CHUNK = 4096
PR_SET_PDEATHSIG = 1

def set_pdeathsig(sig):
    # Ask the kernel to send us 'sig' when our parent dies (Linux only).
    try:
        ctypes.CDLL('libc.so.6', use_errno=True).prctl(PR_SET_PDEATHSIG, sig, 0, 0, 0)
    except Exception:
        pass

def write_all(fd, data):
    while data:
        written = os.write(fd, data)
        if written <= 0:
            return
        data = data[written:]

def exit_code(status):
    if os.WIFEXITED(status):
        return os.WEXITSTATUS(status)
    if os.WIFSIGNALED(status):
        return 128 + os.WTERMSIG(status)
    return 0

def signal_session(pid, pty_fd, sig):
    # The shell and its foreground job may be in different process groups.
    groups = {pid}
    try:
        foreground = os.tcgetpgrp(pty_fd)
        if foreground > 0:
            groups.add(foreground)
    except OSError:
        pass
    for pgid in groups:
        try: os.killpg(pgid, sig)
        except OSError: pass

def reap(pid, pty_fd, terminate=False):
    # Hang up the PTY and wait for the shell, escalating if it does not exit.
    if terminate:
        signal_session(pid, pty_fd, signal.SIGTERM)
    try: os.close(pty_fd)
    except OSError: pass
    deadline = time.time() + 1.0
    while time.time() < deadline:
        try:
            waited, status = os.waitpid(pid, os.WNOHANG)
            if waited:
                return exit_code(status)
        except OSError:
            return 0
        time.sleep(0.02)
    signal_session(pid, pty_fd, signal.SIGKILL)
    try:
        _, status = os.waitpid(pid, 0)
        return exit_code(status)
    except OSError:
        return 0

def main():
    if sys.platform == 'win32':
        return 1
    from selectors import DefaultSelector, EVENT_READ
    from struct import pack
    from pty import fork
    from fcntl import ioctl
    from termios import TIOCSWINSZ

    # If Obsidian (our parent) dies, have the kernel signal us so we don't orphan.
    parent_pid = os.getppid()
    set_pdeathsig(signal.SIGTERM)
    if os.getppid() != parent_pid:
        return 1

    shell = sys.argv[1] if len(sys.argv) > 1 else (os.environ.get('SHELL') or '/bin/sh')
    pid, pty_fd = fork()
    if pid == 0:
        # Child: die if the proxy dies, then become the shell.
        proxy_pid = os.getppid()
        set_pdeathsig(signal.SIGTERM)
        if os.getppid() != proxy_pid:
            os._exit(1)
        try:
            os.execvp(shell, [shell])
        except Exception:
            os._exit(127)

    def shutdown(*_):
        reap(pid, pty_fd, terminate=True)
        os._exit(0)

    # SIGTERM (incl. from pdeathsig) / SIGHUP -> clean up the shell and exit.
    signal.signal(signal.SIGTERM, shutdown)
    signal.signal(signal.SIGHUP, shutdown)

    with DefaultSelector() as sel:
        done = False
        shell_exited = False
        resize_buffer = b''

        def on_pty():
            nonlocal done, shell_exited
            try:
                data = os.read(pty_fd, CHUNK)
            except OSError:
                data = b''
            if not data:           # shell exited
                done = True
                shell_exited = True
                try: sel.unregister(pty_fd)
                except: pass
                return
            write_all(1, data)

        def on_stdin():
            nonlocal done
            try:
                data = os.read(0, CHUNK)
            except OSError:
                data = b''
            if not data:           # stdin EOF == parent went away; stop, don't spin
                done = True
                try: sel.unregister(0)
                except: pass
                return
            try: write_all(pty_fd, data)
            except OSError: pass

        def on_cmd():
            nonlocal resize_buffer
            try:
                raw = os.read(3, 256)
            except OSError:
                raw = b''
            if not raw:            # resize pipe closed; stop watching it, don't spin
                try: sel.unregister(3)
                except: pass
                return
            resize_buffer += raw
            while b'\n' in resize_buffer:
                line, resize_buffer = resize_buffer.split(b'\n', 1)
                try:
                    rows, cols = (int(x.strip()) for x in line.decode('ascii').split('x', 1))
                    ioctl(pty_fd, TIOCSWINSZ, pack('HHHH', rows, cols, 0, 0))
                except (ValueError, OSError): pass
            if len(resize_buffer) > 1024:
                resize_buffer = b''

        sel.register(pty_fd, EVENT_READ, on_pty)
        sel.register(0,      EVENT_READ, on_stdin)
        try:
            sel.register(3, EVENT_READ, on_cmd)
        except: pass

        while not done:
            try:
                for key, _ in sel.select(timeout=1.0):
                    key.data()
            except InterruptedError:
                continue
            except OSError:
                break

    # Preserve the shell's real exit status; otherwise terminate its PTY session.
    return reap(pid, pty_fd, terminate=not shell_exited)

sys.exit(main())
`;

// ─── Constants ────────────────────────────────────────────────────────────────

const VIEW_TYPE        = 'multi-terminal-view';
const DEFAULT_SETTINGS = { count: 4, shell: '/bin/sh', fontSize: 12 };
const FONT_SIZES       = [8, 10, 11, 12, 13, 14, 16, 18, 20, 24];

// ─── Helpers ──────────────────────────────────────────────────────────────────

function debounce(fn, ms) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

function normalizeSettings(data) {
  const raw = data && typeof data === 'object' ? data : {};
  const count = Number(raw.count);
  const fontSize = Number(raw.fontSize);
  return {
    count: Number.isFinite(count)
      ? Math.max(1, Math.min(6, Math.trunc(count)))
      : DEFAULT_SETTINGS.count,
    shell: typeof raw.shell === 'string' && raw.shell.trim()
      ? raw.shell.trim()
      : DEFAULT_SETTINGS.shell,
    fontSize: FONT_SIZES.includes(fontSize) ? fontSize : DEFAULT_SETTINGS.fontSize,
  };
}

// ─── Obsidian-aware xterm theme ───────────────────────────────────────────────

function getObsidianTheme() {
  const s = getComputedStyle(document.body);
  const v = (name, fallback) => s.getPropertyValue(name).trim() || fallback;
  return {
    background:          v('--background-primary',  '#1e1e2e'),
    foreground:          v('--text-normal',          '#cdd6f4'),
    cursor:              v('--interactive-accent',   '#89b4fa'),
    cursorAccent:        v('--background-primary',   '#1e1e2e'),
    selectionBackground: v('--text-selection',       '#44475a88'),
    black:               v('--color-base-20',        '#313244'),
    red:                 v('--color-red',            '#f38ba8'),
    green:               v('--color-green',          '#a6e3a1'),
    yellow:              v('--color-yellow',         '#f9e2af'),
    blue:                v('--color-blue',           '#89b4fa'),
    magenta:             v('--color-purple',         '#f5c2e7'),
    cyan:                v('--color-cyan',           '#94e2d5'),
    white:               v('--text-muted',           '#bac2de'),
    brightBlack:         v('--color-base-40',        '#585b7a'),
    brightRed:           v('--color-red',            '#f38ba8'),
    brightGreen:         v('--color-green',          '#a6e3a1'),
    brightYellow:        v('--color-yellow',         '#f9e2af'),
    brightBlue:          v('--color-blue',           '#89b4fa'),
    brightMagenta:       v('--color-purple',         '#f5c2e7'),
    brightCyan:          v('--color-cyan',           '#94e2d5'),
    brightWhite:         v('--text-normal',          '#cdd6f4'),
  };
}

// ─── TerminalPane ─────────────────────────────────────────────────────────────

class TerminalPane {
  constructor(containerEl, titleEl, cwd, plugin, onNavigate) {
    this.containerEl = containerEl;
    this.titleEl     = titleEl;
    this.cwd         = cwd;
    this.plugin      = plugin;
    this.onNavigate  = onNavigate;
    this.term        = null;
    this.fit         = null;
    this.proc        = null;
    this.ro          = null;
    this._dataSub    = null;
    this._resizeSub  = null;
    this._build();
  }

  _build() {
    this.term = new Terminal({
      fontFamily: '"JetBrains Mono","Fira Code","Cascadia Code",Menlo,monospace',
      fontSize:   this.plugin.settings.fontSize,
      lineHeight: 1.2,
      cursorBlink: true,
      cursorStyle: 'bar',
      scrollback:  5000,
      theme: getObsidianTheme(),
    });

    this.fit = new FitAddon();
    this.term.loadAddon(this.fit);

    // OSC 7 — CWD notification
    this.term.parser.registerOscHandler(7, data => {
      try {
        const path = decodeURIComponent(new URL(data).pathname);
        const parts = path.split('/').filter(Boolean);
        this._setTitle(parts.length > 2 ? `…/${parts.slice(-2).join('/')}` : `/${parts.join('/')}`);
      } catch {}
      return true;
    });

    // OSC 0/2 — window title
    const titleHandler = data => { this._setTitle(data); return true; };
    this.term.parser.registerOscHandler(0, titleHandler);
    this.term.parser.registerOscHandler(2, titleHandler);

    // Alt+Arrow — navigate between panes
    this.term.attachCustomKeyEventHandler(e => {
      if (e.altKey && e.type === 'keydown') {
        if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
          this.onNavigate?.('next'); return false;
        }
        if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
          this.onNavigate?.('prev'); return false;
        }
      }
      return true;
    });

    this.term.open(this.containerEl);

    // Input/resize handlers live on the persistent term object, so they must be
    // registered exactly once. Registering them inside _spawn() would stack a new
    // copy on every restart() and duplicate every keystroke. They read this.proc
    // lazily, so they always target the current process.
    this._dataSub = this.term.onData(data => {
      if (this.proc?.stdin?.writable) this.proc.stdin.write(data);
    });
    this._resizeSub = this.term.onResize(({ cols, rows }) => this._sendResize(cols, rows));

    this._spawn();

    let ready = false;
    const debouncedFit = debounce(() => this._fit(), 50);
    this.ro = new ResizeObserver(entries => {
      const r = entries[0]?.contentRect;
      if (!r || (r.width === 0 && r.height === 0)) return;
      if (!ready) { ready = true; this._fit(); return; }
      debouncedFit();
    });
    this.ro.observe(this.containerEl);
  }

  _setTitle(text) {
    if (this.titleEl) this.titleEl.textContent = text;
  }

  _spawn() {
    const shell = this.plugin.settings.shell || '/bin/sh';
    const proc = spawn('python3', ['-c', PTY_PROXY_PY, shell], {
      stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
      cwd: this.cwd,
      env: {
        ...process.env,
        TERM:      'xterm-256color',
        COLORTERM: 'truecolor',
        COLUMNS:   String(this.term?.cols ?? 80),
        LINES:     String(this.term?.rows ?? 24),
      },
    });
    this.proc = proc;

    // All proc handlers guard on `this.proc === proc` so that events from an
    // already-replaced process (e.g. the old proc's async 'exit' after restart())
    // can't write stale output into, or null out, the current process.
    proc.stdout.on('data', chunk => { if (this.proc === proc) this.term?.write(chunk); });
    proc.stderr.on('data', chunk => { if (this.proc === proc) this.term?.write(chunk); });
    proc.stdin.on('error', () => {});

    proc.on('error', err => {
      if (this.proc !== proc) return;
      this.proc = null;
      this.term?.write(`\r\n\x1b[31m[error: ${err.message}]\x1b[0m\r\n`);
      if (err.code === 'ENOENT') {
        this.term?.write(`\x1b[2m[python3 not found — install Python 3 and ensure it is in PATH]\x1b[0m\r\n`);
      }
    });

    proc.on('exit', code => {
      if (this.proc !== proc) return;
      this.proc = null;
      this.term?.write(`\r\n\x1b[2m[exited ${code ?? 0}]\x1b[0m\r\n`);
    });
  }

  _terminateProcess(proc) {
    if (!proc || proc.exitCode !== null || proc.signalCode !== null) return;
    try { proc.kill('SIGTERM'); } catch {}
    const timer = setTimeout(() => {
      if (proc.exitCode === null && proc.signalCode === null) {
        try { proc.kill('SIGKILL'); } catch {}
      }
    }, 1250);
    timer.unref?.();
    proc.once('exit', () => clearTimeout(timer));
  }

  _fit() {
    try {
      this.fit.fit();
      this._sendResize(this.term.cols, this.term.rows);
    } catch {}
  }

  _sendResize(cols, rows) {
    try {
      const pipe = this.proc?.stdio?.[3];
      if (pipe?.writable) pipe.write(`${rows}x${cols}\n`);
    } catch {}
  }

  applyTheme(theme) {
    if (this.term) this.term.options.theme = theme || getObsidianTheme();
  }

  applyFontSize(size) {
    if (this.term) { this.term.options.fontSize = size; this._fit(); }
  }

  restart() {
    const oldProc = this.proc;
    this.proc = null;
    this._terminateProcess(oldProc);
    this.term?.reset();
    this._setTitle('');
    this._spawn();
  }

  dispose() {
    this.ro?.disconnect();
    this._dataSub?.dispose();
    this._resizeSub?.dispose();
    const oldProc = this.proc;
    this.proc = null;
    this._terminateProcess(oldProc);
    this.term?.dispose();
    this.term = null;
  }
}

// ─── MultiTerminalView ───────────────────────────────────────────────────────

class MultiTerminalView extends ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin               = plugin;
    this.paneList             = [];
    this.focusedIdx           = 0;
    this.cwd                  = homedir();
    this.colFrs               = null;
    this.rowFrs               = null;
    this._gutters             = [];
    this._dragSourceIdx       = null;
    this._fullscreenContainer = null;
    this._activeResizeCleanup = null;
  }

  getViewType()    { return VIEW_TYPE; }
  getDisplayText() { return 'Multi-Terminal'; }
  getIcon()        { return 'layout-grid'; }

  // ── Layout helpers ────────────────────────────────────────────

  _numCols(n) {
    if (n <= 3) return n;
    if (n === 4) return 2;
    return 3;
  }

  _numRows(n) { return Math.ceil(n / this._numCols(n)); }

  _frToTemplate(frs) {
    return frs.map((fr, i) =>
      i < frs.length - 1 ? `minmax(0, ${fr}fr) 6px` : `minmax(0, ${fr}fr)`
    ).join(' ');
  }

  _applyTemplate() {
    this.gridEl.style.gridTemplateColumns = this._frToTemplate(this.colFrs);
    this.gridEl.style.gridTemplateRows    = this._frToTemplate(this.rowFrs);
  }

  // ── Resize gutters ────────────────────────────────────────────

  _rebuildGutters(cols, rows) {
    this._activeResizeCleanup?.();
    for (const g of this._gutters) g.remove();
    this._gutters = [];

    for (let c = 0; c < cols - 1; c++) {
      const g = this.gridEl.createEl('div', { cls: 'mt-gutter mt-gutter-col' });
      g.style.gridColumn = String(c * 2 + 2);
      g.style.gridRow    = '1 / -1';
      this._gutters.push(g);
      const ci = c;
      g.addEventListener('pointerdown', e => this._startResize(e, 'col', ci));
    }

    for (let r = 0; r < rows - 1; r++) {
      const g = this.gridEl.createEl('div', { cls: 'mt-gutter mt-gutter-row' });
      g.style.gridRow    = String(r * 2 + 2);
      g.style.gridColumn = '1 / -1';
      this._gutters.push(g);
      const ri = r;
      g.addEventListener('pointerdown', e => this._startResize(e, 'row', ri));
    }
  }

  _startResize(e, axis, gutterIdx) {
    if (e.button !== 0) return;
    e.preventDefault();
    this._activeResizeCleanup?.();
    const isCol    = axis === 'col';
    const frs      = [...(isCol ? this.colFrs : this.rowFrs)];
    const rect     = this.gridEl.getBoundingClientRect();
    const totalPx  = (isCol ? rect.width : rect.height) - (frs.length - 1) * 6;
    const sumFrs   = frs.reduce((a, b) => a + b, 0);
    const startPx  = frs.map(f => f / sumFrs * totalPx);
    const startMouse = isCol ? e.clientX : e.clientY;
    const gEl = e.currentTarget;
    gEl.classList.add('mt-active');
    gEl.setPointerCapture?.(e.pointerId);

    // Coalesce the relayout/fit work to one pass per animation frame — pointer
    // events can fire far faster than the screen refreshes, and each _fit() forces a
    // measure/reflow across every pane.
    let rafId = null;
    const relayout = () => {
      rafId = null;
      this._applyTemplate();
      for (const { pane } of this.paneList) pane._fit();
    };

    const onMove = ev => {
      const delta    = (isCol ? ev.clientX : ev.clientY) - startMouse;
      const combined = startPx[gutterIdx] + startPx[gutterIdx + 1];
      const MIN      = 40;
      const a = Math.max(MIN, Math.min(combined - MIN, startPx[gutterIdx] + delta));
      const newFrs = [...frs];
      newFrs[gutterIdx]     = a;
      newFrs[gutterIdx + 1] = combined - a;
      if (isCol) this.colFrs = newFrs;
      else       this.rowFrs = newFrs;
      if (rafId === null) rafId = requestAnimationFrame(relayout);
    };

    const cleanup = () => {
      if (rafId !== null) { cancelAnimationFrame(rafId); rafId = null; }
      gEl.classList.remove('mt-active');
      gEl.removeEventListener('pointermove', onMove);
      gEl.removeEventListener('pointerup', onUp);
      gEl.removeEventListener('pointercancel', onUp);
      try { gEl.releasePointerCapture?.(e.pointerId); } catch {}
      this._activeResizeCleanup = null;
    };

    const onUp = () => {
      relayout();   // settle on the final size
      cleanup();
    };

    this._activeResizeCleanup = cleanup;
    gEl.addEventListener('pointermove', onMove);
    gEl.addEventListener('pointerup', onUp);
    gEl.addEventListener('pointercancel', onUp);
  }

  // ── Focus management ──────────────────────────────────────────

  _focusPaneAt(idx) {
    const n = this.paneList.length;
    if (!n) return;
    idx = ((idx % n) + n) % n;
    this.focusedIdx = idx;
    for (const { container } of this.paneList) container.classList.remove('mt-focused');
    this.paneList[idx].container.classList.add('mt-focused');
    this.paneList[idx].pane.term?.focus();
  }

  _moveFocus(dir) {
    const n = this.paneList.length;
    if (!n) return;
    this._focusPaneAt(dir === 'next'
      ? (this.focusedIdx + 1) % n
      : (this.focusedIdx - 1 + n) % n);
  }

  // ── Drag-to-reorder ───────────────────────────────────────────

  _swapPanes(a, b) {
    const ea = this.paneList[a];
    const eb = this.paneList[b];

    const colA = ea.container.style.gridColumn;
    const rowA = ea.container.style.gridRow;
    ea.container.style.gridColumn = eb.container.style.gridColumn;
    ea.container.style.gridRow    = eb.container.style.gridRow;
    eb.container.style.gridColumn = colA;
    eb.container.style.gridRow    = rowA;

    ea.container.dataset.paneIdx = String(b);
    eb.container.dataset.paneIdx = String(a);
    const numA = ea.container.querySelector('.mt-pane-num');
    const numB = eb.container.querySelector('.mt-pane-num');
    if (numA && numB) { const t = numA.textContent; numA.textContent = numB.textContent; numB.textContent = t; }

    this.paneList[a] = eb;
    this.paneList[b] = ea;
    if      (this.focusedIdx === a) this.focusedIdx = b;
    else if (this.focusedIdx === b) this.focusedIdx = a;
  }

  // ── Fullscreen ────────────────────────────────────────────────

  _toggleFullscreen(container, pane, fsBtn) {
    if (this._fullscreenContainer === container) {
      container.classList.remove('mt-fullscreen');
      this._fullscreenContainer = null;
      setIcon(fsBtn, 'maximize-2');
      fsBtn.setAttribute('aria-pressed', 'false');
    } else {
      if (this._fullscreenContainer) {
        this._fullscreenContainer.classList.remove('mt-fullscreen');
        const prev = this._fullscreenContainer.querySelector('.mt-fs-btn');
        if (prev) {
          setIcon(prev, 'maximize-2');
          prev.setAttribute('aria-pressed', 'false');
        }
      }
      container.classList.add('mt-fullscreen');
      this._fullscreenContainer = container;
      setIcon(fsBtn, 'minimize-2');
      fsBtn.setAttribute('aria-pressed', 'true');
      this._focusPaneAt(Number(container.dataset.paneIdx));
    }
    pane._fit();
  }

  // ── Lifecycle ─────────────────────────────────────────────────

  async onOpen() {
    if (process.platform === 'win32') {
      const root = this.containerEl.children[1];
      root.empty();
      root.createEl('p', {
        text: 'Multi-Terminal is not supported on Windows. It requires a POSIX PTY (Linux or macOS).',
        cls: 'mt-error',
      });
      return;
    }

    const root = this.containerEl.children[1];
    root.empty();
    root.addClass('mt-root');
    this.gridEl = root.createEl('div', { cls: 'mt-grid' });

    if (this.plugin.app.vault.adapter instanceof FileSystemAdapter) {
      this.cwd = this.plugin.app.vault.adapter.getBasePath();
    }

    await this._applyCount(this.plugin.settings.count);

    this.registerEvent(
      this.app.workspace.on('css-change', () => {
        const theme = getObsidianTheme();   // resolve once, not per pane
        for (const { pane } of this.paneList) pane.applyTheme(theme);
      })
    );
  }

  async onClose() {
    this._activeResizeCleanup?.();
    for (const { pane } of this.paneList) pane.dispose();
    this.paneList = [];
  }

  async setCount(n) { await this._applyCount(n); }

  // ── Pane management ───────────────────────────────────────────

  async _applyCount(n) {
    n = Math.max(1, Math.min(6, Math.trunc(Number(n) || DEFAULT_SETTINGS.count)));
    const cols     = this._numCols(n);
    const rows     = this._numRows(n);
    const prevN    = this.paneList.length;
    const prevCols = prevN ? this._numCols(prevN) : 0;
    const prevRows = prevN ? this._numRows(prevN) : 0;

    if (cols !== prevCols || rows !== prevRows) {
      this.colFrs = Array(cols).fill(1);
      this.rowFrs = Array(rows).fill(1);
      this.paneList.forEach(({ container }, i) => {
        container.style.gridColumn = String((i % cols) * 2 + 1);
        container.style.gridRow    = String(Math.floor(i / cols) * 2 + 1);
      });
    }

    while (this.paneList.length > n) {
      const { pane, container } = this.paneList.pop();
      if (this._fullscreenContainer === container) this._fullscreenContainer = null;
      pane.dispose();
      container.remove();
    }

    while (this.paneList.length < n) {
      const idx = this.paneList.length;
      const col = idx % cols;
      const row = Math.floor(idx / cols);

      const container = this.gridEl.createEl('div', { cls: 'mt-pane' });
      container.style.gridColumn = String(col * 2 + 1);
      container.style.gridRow    = String(row * 2 + 1);
      container.dataset.paneIdx  = String(idx);

      const hdr    = container.createEl('div', { cls: 'mt-pane-hdr' });
      const grip   = hdr.createEl('span', { cls: 'mt-grip' });
      setIcon(grip, 'grip-vertical');
      hdr.createEl('span', { cls: 'mt-pane-num', text: String(idx + 1) });
      const titleEl = hdr.createEl('span', { cls: 'mt-pane-title' });
      const btn = hdr.createEl('button', {
        cls: 'mt-icon-btn',
        title: 'Restart shell',
        attr: { type: 'button', 'aria-label': 'Restart shell' },
      });
      setIcon(btn, 'refresh-cw');
      const fsBtn = hdr.createEl('button', {
        cls: 'mt-icon-btn mt-fs-btn',
        title: 'Toggle fullscreen',
        attr: {
          type: 'button',
          'aria-label': 'Toggle terminal fullscreen',
          'aria-pressed': 'false',
        },
      });
      setIcon(fsBtn, 'maximize-2');

      const xtermEl = container.createEl('div', { cls: 'mt-xterm' });

      const pane = new TerminalPane(
        xtermEl,
        titleEl,
        this.cwd,
        this.plugin,
        dir => this._moveFocus(dir),
      );

      btn.addEventListener('click', () => {
        this.paneList[Number(container.dataset.paneIdx)].pane.restart();
      });

      fsBtn.addEventListener('click', () => {
        const i = Number(container.dataset.paneIdx);
        this._toggleFullscreen(container, this.paneList[i].pane, fsBtn);
      });

      xtermEl.addEventListener('mousedown', () => {
        this._focusPaneAt(Number(container.dataset.paneIdx));
      });

      hdr.draggable = true;

      hdr.addEventListener('dragstart', e => {
        this._dragSourceIdx = Number(container.dataset.paneIdx);
        e.dataTransfer.effectAllowed = 'move';
        setTimeout(() => container.classList.add('mt-dragging'), 0);
      });

      hdr.addEventListener('dragend', () => {
        container.classList.remove('mt-dragging');
        for (const { container: c } of this.paneList) c.classList.remove('mt-drag-over');
        this._dragSourceIdx = null;
      });

      container.addEventListener('dragover', e => {
        const myIdx = Number(container.dataset.paneIdx);
        if (this._dragSourceIdx !== null && this._dragSourceIdx !== myIdx) {
          e.preventDefault();
          container.classList.add('mt-drag-over');
        }
      });

      container.addEventListener('dragleave', e => {
        if (!container.contains(e.relatedTarget)) {
          container.classList.remove('mt-drag-over');
        }
      });

      container.addEventListener('drop', e => {
        e.preventDefault();
        container.classList.remove('mt-drag-over');
        const target = Number(container.dataset.paneIdx);
        if (this._dragSourceIdx !== null && this._dragSourceIdx !== target) {
          this._swapPanes(this._dragSourceIdx, target);
        }
        this._dragSourceIdx = null;
      });

      this.paneList.push({ pane, container });
    }

    this._rebuildGutters(cols, rows);
    this._applyTemplate();

    if (this.focusedIdx >= this.paneList.length) this.focusedIdx = 0;
    for (const { container } of this.paneList) container.classList.remove('mt-focused');
    this.paneList[this.focusedIdx]?.container.classList.add('mt-focused');
  }
}

// ─── Settings tab ─────────────────────────────────────────────────────────────

class MultiTerminalSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl('h2', { text: 'Multi-Terminal' });

    new Setting(containerEl)
      .setName('Terminal count')
      .setDesc('Number of shell panes shown at once. Updates live.')
      .addDropdown(d => {
        for (let i = 1; i <= 6; i++) d.addOption(String(i), String(i));
        d.setValue(String(this.plugin.settings.count))
         .onChange(async v => {
           this.plugin.settings.count = Number(v);
           await this.plugin.saveSettings();
           for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE)) {
             await leaf.view.setCount(Number(v));
           }
         });
      });

    new Setting(containerEl)
      .setName('Shell')
      .setDesc('Absolute path to the shell. Takes effect on next pane open or restart.')
      .addText(t =>
        t.setPlaceholder('/bin/sh')
         .setValue(this.plugin.settings.shell)
         .onChange(async v => {
           this.plugin.settings.shell = v.trim() || '/bin/sh';
           await this.plugin.saveSettings();
         })
      );

    new Setting(containerEl)
      .setName('Font size')
      .setDesc('Terminal font size in pixels. Updates live.')
      .addDropdown(d => {
        for (const size of FONT_SIZES) {
          d.addOption(String(size), `${size}px`);
        }
        d.setValue(String(this.plugin.settings.fontSize))
         .onChange(async v => {
           this.plugin.settings.fontSize = Number(v);
           await this.plugin.saveSettings();
           for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE)) {
             for (const { pane } of leaf.view.paneList) pane.applyFontSize(Number(v));
           }
         });
      });
  }
}

// ─── Plugin ───────────────────────────────────────────────────────────────────

class MultiTerminalPlugin extends Plugin {
  settings  = { ...DEFAULT_SETTINGS };

  async onload() {
    await this.loadSettings();

    this.registerView(VIEW_TYPE, leaf => new MultiTerminalView(leaf, this));
    this.addSettingTab(new MultiTerminalSettingTab(this.app, this));
    this.addRibbonIcon('layout-grid', 'Open Multi-Terminal', () => this.activateView());
    this.addCommand({
      id: 'open-multi-terminal',
      name: 'Open Multi-Terminal',
      callback: () => this.activateView(),
    });
  }

  async onunload() {
    this.app.workspace.detachLeavesOfType(VIEW_TYPE);
  }

  async activateView() {
    const existing = this.app.workspace.getLeavesOfType(VIEW_TYPE);
    if (existing.length > 0) { this.app.workspace.revealLeaf(existing[0]); return; }
    const leaf = this.app.workspace.getLeaf('tab');
    await leaf.setViewState({ type: VIEW_TYPE, active: true });
    this.app.workspace.revealLeaf(leaf);
  }

  async loadSettings() {
    this.settings = normalizeSettings(await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }
}

Object.defineProperty(exports, '__esModule', { value: true });
exports.default = MultiTerminalPlugin;
