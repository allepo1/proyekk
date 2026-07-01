const { useState, useEffect, useRef, useCallback, useMemo } = React;

// ---------------------------------------------------------------------------
// Config & helpers
// ---------------------------------------------------------------------------

const TOKEN_KEY = 'ambis_token';
const USER_KEY = 'ambis_user';
const DRAFT_KEY = 'ambis_draft'; // local autosave fallback while offline

function loadStoredAuth() {
  try {
    const token = localStorage.getItem(TOKEN_KEY);
    const user = JSON.parse(localStorage.getItem(USER_KEY) || 'null');
    if (token && user) return { token, user };
  } catch (e) { /* ignore corrupted storage */ }
  return null;
}

function saveStoredAuth(token, user) {
  localStorage.setItem(TOKEN_KEY, token);
  localStorage.setItem(USER_KEY, JSON.stringify(user));
}

function clearStoredAuth() {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(USER_KEY);
}

async function apiFetch(path, { method = 'GET', body, token, isForm = false } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (!isForm && body !== undefined) headers['Content-Type'] = 'application/json';

  const res = await fetch(path, {
    method,
    headers,
    body: body === undefined ? undefined : isForm ? body : JSON.stringify(body),
  });

  let data = {};
  try { data = await res.json(); } catch (e) { /* empty body */ }

  if (!res.ok) {
    throw new Error(data.error || `Permintaan gagal (${res.status})`);
  }
  return data;
}

function debounce(fn, delay) {
  let timer = null;
  const debounced = (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), delay);
  };
  debounced.cancel = () => clearTimeout(timer);
  return debounced;
}

function formatRelativeTime(iso) {
  if (!iso) return '';
  const date = new Date(iso);
  return date.toLocaleString('id-ID', {
    day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

function blankNote() {
  return {
    id: null,
    title: '',
    text: '',
    canvas: {},
    audio: null,
    tags: [],
    createdAt: null,
    updatedAt: null,
  };
}

function wordCount(text) {
  const trimmed = (text || '').trim();
  if (!trimmed) return 0;
  return trimmed.split(/\s+/).length;
}

// ---------------------------------------------------------------------------
// Auth screen
// ---------------------------------------------------------------------------

function AuthScreen({ onAuthenticated }) {
  const [mode, setMode] = useState('login'); // 'login' | 'register'
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const data = await apiFetch(`/api/${mode === 'login' ? 'login' : 'register'}`, {
        method: 'POST',
        body: { email, password },
      });
      const user = { id: data.userId, email: data.email || email };
      saveStoredAuth(data.token, user);
      onAuthenticated({ token: data.token, user });
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-50 px-4">
      <div className="w-full max-w-sm rounded-[32px] border border-slate-200/80 bg-white p-8 shadow-sm">
        <p className="text-lg font-semibold text-slate-900">Ambis.</p>
        <p className="mt-2 text-sm text-slate-500">
          {mode === 'login' ? 'Masuk untuk melanjutkan catatanmu.' : 'Buat akun baru untuk mulai mencatat.'}
        </p>

        <form onSubmit={submit} className="mt-6 space-y-4">
          <label className="block">
            <span className="text-sm font-semibold text-slate-600">Email</span>
            <input
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="kamu@kampus.ac.id"
              className="mt-2 w-full rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-900 outline-none transition focus:border-slate-400 focus:ring-2 focus:ring-slate-100"
            />
          </label>
          <label className="block">
            <span className="text-sm font-semibold text-slate-600">Password</span>
            <input
              type="password"
              required
              minLength={6}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Minimal 6 karakter"
              className="mt-2 w-full rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-900 outline-none transition focus:border-slate-400 focus:ring-2 focus:ring-slate-100"
            />
          </label>

          {error && (
            <p className="rounded-2xl bg-red-50 px-4 py-3 text-sm text-red-600">{error}</p>
          )}

          <button
            type="submit"
            disabled={loading}
            className="w-full rounded-2xl bg-slate-900 px-4 py-3 text-sm font-semibold text-white transition hover:bg-slate-700 disabled:opacity-60"
          >
            {loading ? 'Memproses...' : mode === 'login' ? 'Masuk' : 'Daftar'}
          </button>
        </form>

        <button
          type="button"
          onClick={() => { setMode(mode === 'login' ? 'register' : 'login'); setError(''); }}
          className="mt-5 w-full text-center text-sm font-medium text-sky-700 hover:underline"
        >
          {mode === 'login' ? 'Belum punya akun? Daftar' : 'Sudah punya akun? Masuk'}
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------------

function TabButton({ label, active, onClick }) {
  return (
    <button
      className={`rounded-full px-4 py-2 text-sm font-medium transition ${active ? 'bg-slate-900 text-white shadow-sm' : 'text-slate-600 hover:bg-slate-100'}`}
      onClick={onClick}
      type="button"
    >
      {label}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Digital canvas (real freehand drawing, no external deps)
// ---------------------------------------------------------------------------

const CANVAS_COLORS = ['#0f172a', '#0ea5e9', '#ef4444', '#22c55e', '#f59e0b'];

function DigitalCanvasCard({ initialDataUrl, onChange }) {
  const canvasRef = useRef(null);
  const drawing = useRef(false);
  const lastPoint = useRef(null);
  const [color, setColor] = useState(CANVAS_COLORS[0]);
  const [eraser, setEraser] = useState(false);
  const [hasStrokes, setHasStrokes] = useState(Boolean(initialDataUrl));
  const restoredRef = useRef(false);

  // Restore saved drawing once the canvas exists.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || restoredRef.current) return;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    if (initialDataUrl) {
      const img = new Image();
      img.onload = () => ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      img.src = initialDataUrl;
    }
    restoredRef.current = true;
  }, [initialDataUrl]);

  const getPoint = (e) => {
    const canvas = canvasRef.current;
    const rect = canvas.getBoundingClientRect();
    const clientX = e.touches ? e.touches[0].clientX : e.clientX;
    const clientY = e.touches ? e.touches[0].clientY : e.clientY;
    return {
      x: ((clientX - rect.left) / rect.width) * canvas.width,
      y: ((clientY - rect.top) / rect.height) * canvas.height,
    };
  };

  const startDraw = (e) => {
    e.preventDefault();
    drawing.current = true;
    lastPoint.current = getPoint(e);
  };

  const draw = (e) => {
    if (!drawing.current) return;
    e.preventDefault();
    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d');
    const point = getPoint(e);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.lineWidth = eraser ? 18 : 3;
    ctx.strokeStyle = eraser ? '#ffffff' : color;
    ctx.beginPath();
    ctx.moveTo(lastPoint.current.x, lastPoint.current.y);
    ctx.lineTo(point.x, point.y);
    ctx.stroke();
    lastPoint.current = point;
    setHasStrokes(true);
  };

  const endDraw = () => {
    if (!drawing.current) return;
    drawing.current = false;
    const canvas = canvasRef.current;
    onChange({ dataUrl: canvas.toDataURL('image/png') });
  };

  const clearCanvas = () => {
    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    setHasStrokes(false);
    onChange({ dataUrl: '' });
  };

  return (
    <div className="rounded-3xl border border-slate-200/80 bg-white p-5 shadow-sm">
      <div className="flex items-center justify-between gap-4 mb-5">
        <div className="rounded-full bg-slate-50 px-3 py-1 text-xs font-semibold uppercase tracking-[0.24em] text-slate-500">
          Canvas Digital
        </div>
        <div className="rounded-full bg-slate-100 px-3 py-1 text-xs text-slate-600">
          {hasStrokes ? 'Ada coretan' : 'Kosong'}
        </div>
      </div>

      <div className="relative rounded-3xl border border-slate-200/80 bg-white p-4 shadow-[0_18px_40px_rgba(15,23,42,0.06)]">
        <div className="floating-toolbar absolute left-4 top-4 z-10 flex items-center gap-2 rounded-full border border-slate-200 bg-white/95 px-3 py-2">
          <button
            type="button"
            title="Pensil"
            onClick={() => setEraser(false)}
            className={`inline-flex h-9 w-9 items-center justify-center rounded-full text-slate-700 transition ${!eraser ? 'bg-slate-900 text-white' : 'bg-slate-100 hover:bg-slate-200'}`}
          >
            ✎
          </button>
          <button
            type="button"
            title="Penghapus"
            onClick={() => setEraser(true)}
            className={`inline-flex h-9 w-9 items-center justify-center rounded-full text-slate-700 transition ${eraser ? 'bg-slate-900 text-white' : 'bg-slate-100 hover:bg-slate-200'}`}
          >
            ⌫
          </button>
          <button
            type="button"
            title="Hapus semua"
            onClick={clearCanvas}
            className="inline-flex h-9 w-9 items-center justify-center rounded-full bg-slate-100 text-slate-700 transition hover:bg-slate-200"
          >
            🗑
          </button>
          <span className="mx-1 h-6 w-px bg-slate-200" />
          {CANVAS_COLORS.map((c) => (
            <button
              key={c}
              type="button"
              title={c}
              onClick={() => { setColor(c); setEraser(false); }}
              className={`h-6 w-6 rounded-full border-2 transition ${color === c && !eraser ? 'border-slate-900 scale-110' : 'border-white'}`}
              style={{ backgroundColor: c }}
            />
          ))}
        </div>

        <canvas
          ref={canvasRef}
          width={640}
          height={320}
          className="h-52 w-full touch-none rounded-3xl border border-dashed border-slate-300 bg-white"
          onMouseDown={startDraw}
          onMouseMove={draw}
          onMouseUp={endDraw}
          onMouseLeave={endDraw}
          onTouchStart={startDraw}
          onTouchMove={draw}
          onTouchEnd={endDraw}
        />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Voice recorder (real MediaRecorder, uploads to server)
// ---------------------------------------------------------------------------

function VoiceRecorderCard({ audioUrl, onChange, token }) {
  const [recording, setRecording] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState('');
  const mediaRecorderRef = useRef(null);
  const chunksRef = useRef([]);
  const timerRef = useRef(null);
  const streamRef = useRef(null);

  useEffect(() => () => {
    clearInterval(timerRef.current);
    if (streamRef.current) streamRef.current.getTracks().forEach((t) => t.stop());
  }, []);

  const startRecording = async () => {
    setError('');
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      setError('Browser ini tidak mendukung perekaman suara.');
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      const recorder = new MediaRecorder(stream);
      chunksRef.current = [];
      recorder.ondataavailable = (e) => { if (e.data.size > 0) chunksRef.current.push(e.data); };
      recorder.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        const blob = new Blob(chunksRef.current, { type: 'audio/webm' });
        setUploading(true);
        try {
          const form = new FormData();
          form.append('audio', blob, `rekaman-${Date.now()}.webm`);
          const data = await apiFetch('/api/upload-audio', { method: 'POST', body: form, isForm: true, token });
          onChange(data.url);
        } catch (err) {
          setError('Gagal mengunggah rekaman: ' + err.message);
        } finally {
          setUploading(false);
        }
      };
      mediaRecorderRef.current = recorder;
      recorder.start();
      setRecording(true);
      setSeconds(0);
      timerRef.current = setInterval(() => setSeconds((s) => s + 1), 1000);
    } catch (err) {
      setError('Izin mikrofon ditolak atau tidak tersedia.');
    }
  };

  const stopRecording = () => {
    if (mediaRecorderRef.current && recording) {
      mediaRecorderRef.current.stop();
    }
    clearInterval(timerRef.current);
    setRecording(false);
  };

  const toggleRecording = () => (recording ? stopRecording() : startRecording());

  const mm = String(Math.floor(seconds / 60)).padStart(2, '0');
  const ss = String(seconds % 60).padStart(2, '0');

  return (
    <div className="rounded-3xl border border-slate-200/80 bg-white p-6 shadow-sm">
      <div className="flex items-center justify-between gap-4">
        <div>
          <p className="text-xs uppercase tracking-[0.24em] text-slate-500">Voice Recorder</p>
          <p className="mt-2 text-lg font-semibold text-slate-900">Rekam Catatan Audio</p>
        </div>
        <button
          type="button"
          className={`flex h-12 w-12 items-center justify-center rounded-full text-white shadow-sm transition ${recording ? 'bg-red-600 animate-pulse' : 'bg-red-500 hover:bg-red-600'}`}
          onClick={toggleRecording}
          aria-label="Tombol rekam"
          disabled={uploading}
        >
          {recording ? '■' : '●'}
        </button>
      </div>

      <div className="mt-6 flex items-center justify-between rounded-3xl border border-slate-200 bg-slate-50 px-4 py-4">
        <div>
          <p className="text-sm text-slate-500">Status</p>
          <p className={`mt-1 text-base font-semibold ${recording ? 'text-slate-900' : 'text-slate-600'}`}>
            {uploading ? 'Mengunggah...' : recording ? 'Merekam...' : audioUrl ? 'Tersimpan' : 'Siap rekam'}
          </p>
        </div>
        <div className="rounded-2xl bg-white px-4 py-2 text-sm font-medium text-slate-900 shadow-sm">
          {mm}:{ss}
        </div>
      </div>

      {recording && (
        <div className="mt-6 flex items-end justify-between gap-2">
          {[20, 35, 25, 40, 30].map((height, index) => (
            <div key={index} className="wave-bar" style={{ height: `${height}px` }} />
          ))}
        </div>
      )}

      {error && <p className="mt-4 rounded-2xl bg-red-50 px-4 py-3 text-sm text-red-600">{error}</p>}

      {audioUrl && !recording && (
        <div className="mt-6">
          <audio controls src={audioUrl} className="w-full" />
          <button
            type="button"
            onClick={() => onChange(null)}
            className="mt-3 text-sm font-medium text-slate-500 hover:text-red-600"
          >
            Hapus rekaman
          </button>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sidebar: note list + search
// ---------------------------------------------------------------------------

function NoteListItem({ note, active, onClick }) {
  const snippet = (note.text || '').replace(/\s+/g, ' ').trim().slice(0, 70);
  return (
    <button
      type="button"
      onClick={onClick}
      className={`w-full rounded-3xl border p-4 text-left transition ${active ? 'border-slate-900 bg-slate-900 text-white' : 'border-slate-200 bg-slate-50 hover:bg-slate-100'}`}
    >
      <p className={`text-sm font-semibold ${active ? 'text-white' : 'text-slate-900'}`}>
        {note.title || 'Tanpa judul'}
      </p>
      <p className={`mt-1 text-sm ${active ? 'text-slate-200' : 'text-slate-500'}`}>
        {snippet || 'Belum ada isi.'}
      </p>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <span className={`text-xs ${active ? 'text-slate-300' : 'text-slate-400'}`}>
          {formatRelativeTime(note.updatedAt)}
        </span>
        {note.tags && note.tags.slice(0, 2).map((tag) => (
          <span
            key={tag}
            className={`rounded-full px-2 py-0.5 text-xs ${active ? 'bg-white/20 text-white' : 'bg-slate-200 text-slate-600'}`}
          >
            #{tag}
          </span>
        ))}
      </div>
    </button>
  );
}

// ---------------------------------------------------------------------------
// Ambis x Cafe (decorative side panel, now with real word-count progress)
// ---------------------------------------------------------------------------

function AmbisCafePanel({ words }) {
  const target = 500;
  const pct = Math.min(100, Math.round((words / target) * 100));
  const tables = [
    { title: 'Meja 1 - Dekat Colokan', status: 'Tersedia' },
    { title: 'Meja 2 - Area Tenang', status: 'Tersedia' },
    { title: 'Meja 3 - Sudut Jendela', status: 'Tersedia' },
  ];

  return (
    <div className="sticky top-6 space-y-6">
      <div className="rounded-3xl border border-slate-200/80 bg-white p-6 shadow-sm">
        <div className="flex items-center justify-between gap-3">
          <div>
            <p className="text-sm font-semibold text-slate-900">Ambis x Cafe</p>
            <p className="mt-1 text-sm text-slate-500">Booking tempat kerja nyaman.</p>
          </div>
          <div className="rounded-2xl bg-slate-100 px-3 py-1 text-xs uppercase tracking-[0.24em] text-slate-600">Light</div>
        </div>
        <div className="mt-6 space-y-4">
          {tables.map((table) => (
            <div key={table.title} className="rounded-3xl border border-slate-200 bg-slate-50 p-4">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="font-semibold text-slate-900">{table.title}</p>
                  <p className="mt-1 text-sm text-slate-500">Status: <span className="font-medium text-slate-700">{table.status}</span></p>
                </div>
                <button className="rounded-full bg-slate-900 px-3 py-2 text-xs font-semibold uppercase tracking-[0.24em] text-white transition hover:bg-slate-700" type="button">
                  Booking
                </button>
              </div>
            </div>
          ))}
        </div>
        <div className="mt-6 rounded-3xl border border-slate-200 bg-slate-50 p-5">
          <p className="text-sm font-medium text-slate-900">Target 500 Kata</p>
          <div className="mt-3 h-2 overflow-hidden rounded-full bg-slate-200">
            <div className="h-full rounded-full bg-slate-900 transition-all" style={{ width: `${pct}%` }} />
          </div>
          <p className="mt-3 text-sm text-slate-500">{words} / {target} kata pada catatan ini.</p>
          <button
            className="mt-4 w-full rounded-2xl border border-slate-200 bg-slate-100 px-4 py-3 text-sm font-semibold text-slate-500 disabled:cursor-not-allowed"
            disabled={pct < 100}
            title={pct < 100 ? 'Capai 500 kata untuk membuka kupon' : 'Kupon terbuka!'}
          >
            {pct >= 100 ? 'Klaim Kupon Kopi 50%' : `Klaim Kupon Kopi 50% (${pct}%)`}
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main authenticated app
// ---------------------------------------------------------------------------

function NotebookApp({ auth, onLogout }) {
  const { token, user } = auth;

  const [notes, setNotes] = useState([]);
  const [loadingNotes, setLoadingNotes] = useState(true);
  const [query, setQuery] = useState('');
  const [currentNote, setCurrentNote] = useState(blankNote());
  const [activeTab, setActiveTab] = useState('Teks');
  const [tagsInput, setTagsInput] = useState('');
  const [saveState, setSaveState] = useState('idle'); // idle | saving | saved | error
  const [saveError, setSaveError] = useState('');
  const [listError, setListError] = useState('');

  const isDirtyRef = useRef(false);

  const fetchNotes = useCallback(async (q) => {
    setLoadingNotes(true);
    setListError('');
    try {
      const params = q ? `?q=${encodeURIComponent(q)}` : '';
      const data = await apiFetch(`/api/notes${params}`, { token });
      setNotes(data.notes || []);
    } catch (err) {
      setListError(err.message);
    } finally {
      setLoadingNotes(false);
    }
  }, [token]);

  useEffect(() => { fetchNotes(''); }, [fetchNotes]);

  const debouncedSearch = useMemo(() => debounce((q) => fetchNotes(q), 350), [fetchNotes]);
  useEffect(() => { debouncedSearch(query); }, [query, debouncedSearch]);

  // ---- Save (server + local draft fallback) ----

  const persistNote = useCallback(async (note) => {
    setSaveState('saving');
    setSaveError('');
    try {
      const payload = {
        id: note.id,
        title: note.title,
        text: note.text,
        canvas: note.canvas,
        audio: note.audio,
        tags: note.tags,
      };
      const data = await apiFetch('/api/save-note', { method: 'POST', body: payload, token });
      setCurrentNote((prev) => ({
        ...prev,
        id: data.id,
        createdAt: prev.createdAt || data.createdAt,
        updatedAt: data.updatedAt,
      }));
      setSaveState('saved');
      localStorage.removeItem(DRAFT_KEY);
      // refresh sidebar list to reflect the change without losing the search box
      fetchNotes(query);
    } catch (err) {
      setSaveState('error');
      setSaveError(err.message);
    }
  }, [token, fetchNotes, query]);

  const debouncedPersist = useMemo(() => debounce(persistNote, 1200), [persistNote]);

  const hasContent = (note) =>
    Boolean((note.title && note.title.trim()) || (note.text && note.text.trim()) || note.audio || (note.canvas && note.canvas.dataUrl));

  useEffect(() => {
    if (!isDirtyRef.current) return;
    // Always keep a local draft as a safety net (e.g. offline / server error).
    try { localStorage.setItem(DRAFT_KEY, JSON.stringify(currentNote)); } catch (e) { /* storage full */ }
    if (hasContent(currentNote)) {
      debouncedPersist(currentNote);
    }
  }, [currentNote, debouncedPersist]);

  const updateNote = (patch) => {
    isDirtyRef.current = true;
    setCurrentNote((prev) => ({ ...prev, ...patch }));
  };

  const selectNote = async (note) => {
    debouncedPersist.cancel();
    isDirtyRef.current = false;
    setSaveState('idle');
    try {
      const data = await apiFetch(`/api/notes/${note.id}`, { token });
      setCurrentNote(data.note);
      setTagsInput((data.note.tags || []).join(', '));
    } catch (err) {
      setListError(err.message);
    }
  };

  const newNote = () => {
    debouncedPersist.cancel();
    isDirtyRef.current = false;
    setCurrentNote(blankNote());
    setTagsInput('');
    setSaveState('idle');
    setActiveTab('Teks');
  };

  const deleteNote = async () => {
    if (!currentNote.id) return;
    if (!window.confirm('Hapus catatan ini?')) return;
    try {
      await apiFetch(`/api/notes/${currentNote.id}`, { method: 'DELETE', token });
      newNote();
      fetchNotes(query);
    } catch (err) {
      setListError(err.message);
    }
  };

  const commitTags = () => {
    const tags = tagsInput.split(',').map((t) => t.trim()).filter(Boolean);
    updateNote({ tags });
  };

  const words = wordCount(currentNote.text);

  const saveLabel = {
    idle: 'Belum ada perubahan',
    saving: 'Menyimpan...',
    saved: `Tersimpan · ${formatRelativeTime(currentNote.updatedAt)}`,
    error: `Gagal menyimpan: ${saveError}`,
  }[saveState];

  return (
    <div className="mx-auto min-h-screen max-w-[1400px] px-4 py-6 sm:px-6 lg:px-8">
      <div className="grid gap-6 lg:grid-cols-[280px_minmax(0,1fr)_320px]">
        <aside className="rounded-[32px] border border-slate-200/80 bg-white p-6 shadow-sm">
          <div className="mb-6 flex items-start justify-between gap-2">
            <div>
              <p className="text-lg font-semibold text-slate-900">Ambis.</p>
              <p className="mt-2 text-sm text-slate-500">{user.email}</p>
            </div>
            <button
              type="button"
              onClick={onLogout}
              className="rounded-full bg-slate-100 px-3 py-1.5 text-xs font-semibold text-slate-600 hover:bg-slate-200"
            >
              Keluar
            </button>
          </div>

          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Cari catatan atau #tag..."
            className="mb-4 w-full rounded-2xl border border-slate-200 bg-slate-50 px-4 py-2.5 text-sm text-slate-900 outline-none transition focus:border-slate-400 focus:ring-2 focus:ring-slate-100"
          />

          <div className="space-y-3 max-h-[50vh] overflow-y-auto pr-1">
            {loadingNotes && <p className="text-sm text-slate-400">Memuat...</p>}
            {!loadingNotes && listError && <p className="text-sm text-red-600">{listError}</p>}
            {!loadingNotes && !listError && notes.length === 0 && (
              <p className="text-sm text-slate-400">Belum ada catatan. Mulai tulis yang pertama!</p>
            )}
            {notes.map((note) => (
              <NoteListItem
                key={note.id}
                note={note}
                active={note.id === currentNote.id}
                onClick={() => selectNote(note)}
              />
            ))}
          </div>

          <button
            onClick={newNote}
            className="mt-6 inline-flex w-full items-center justify-center rounded-3xl bg-sky-100 px-4 py-3 text-sm font-semibold text-sky-700 transition hover:bg-sky-200"
            type="button"
          >
            + Catatan Baru
          </button>
        </aside>

        <main className="space-y-6">
          <section className="rounded-[32px] border border-slate-200/80 bg-white p-6 shadow-sm">
            <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <p className="text-sm font-semibold uppercase tracking-[0.24em] text-slate-500">Catatan Teks</p>
                <h1 className="mt-2 text-3xl font-semibold text-slate-900">Ruang Catatan Ambis</h1>
              </div>
              <div className="flex flex-wrap gap-2">
                {['Teks', 'Canvas', 'Rekam Suara'].map((tab) => (
                  <TabButton key={tab} label={tab} active={activeTab === tab} onClick={() => setActiveTab(tab)} />
                ))}
              </div>
            </div>

            <div className="mt-3 flex items-center justify-between text-xs">
              <span className={saveState === 'error' ? 'text-red-600' : 'text-slate-400'}>{saveLabel}</span>
              {currentNote.id && (
                <button type="button" onClick={deleteNote} className="font-medium text-red-500 hover:underline">
                  Hapus catatan
                </button>
              )}
            </div>

            {activeTab === 'Teks' && (
              <div className="mt-6 rounded-[28px] border border-slate-200/80 bg-slate-50 p-6">
                <label className="block">
                  <span className="text-sm font-semibold text-slate-600">Judul Catatan</span>
                  <input
                    type="text"
                    value={currentNote.title}
                    onChange={(e) => updateNote({ title: e.target.value })}
                    placeholder="Contoh: Ringkasan Matkul PABW"
                    className="mt-3 w-full rounded-3xl border border-slate-200 bg-white px-5 py-4 text-2xl font-semibold text-slate-900 outline-none transition focus:border-slate-400 focus:ring-2 focus:ring-slate-100"
                  />
                </label>
                <label className="mt-6 block">
                  <span className="text-sm font-semibold text-slate-600">Isi Catatan</span>
                  <textarea
                    value={currentNote.text}
                    onChange={(e) => updateNote({ text: e.target.value })}
                    placeholder="Mulai mengetik di sini seperti di kertas digital yang lembut dan tenang..."
                    className="mt-3 min-h-[320px] w-full resize-y rounded-[32px] bg-white px-6 py-6 text-slate-700 shadow-sm outline-none transition focus:ring-2 focus:ring-slate-100"
                  />
                </label>
                <label className="mt-6 block">
                  <span className="text-sm font-semibold text-slate-600">Tag (pisahkan dengan koma)</span>
                  <input
                    type="text"
                    value={tagsInput}
                    onChange={(e) => setTagsInput(e.target.value)}
                    onBlur={commitTags}
                    placeholder="pabw, tugas, ringkasan"
                    className="mt-3 w-full rounded-3xl border border-slate-200 bg-white px-5 py-3 text-sm text-slate-900 outline-none transition focus:border-slate-400 focus:ring-2 focus:ring-slate-100"
                  />
                </label>
              </div>
            )}

            {activeTab === 'Canvas' && (
              <div className="mt-6">
                <DigitalCanvasCard
                  initialDataUrl={currentNote.canvas && currentNote.canvas.dataUrl}
                  onChange={(canvas) => updateNote({ canvas })}
                />
              </div>
            )}

            {activeTab === 'Rekam Suara' && (
              <div className="mt-6">
                <VoiceRecorderCard
                  audioUrl={currentNote.audio}
                  onChange={(audio) => updateNote({ audio })}
                  token={token}
                />
              </div>
            )}
          </section>
        </main>

        <div>
          <AmbisCafePanel words={words} />
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Root
// ---------------------------------------------------------------------------

function App() {
  const [auth, setAuth] = useState(() => loadStoredAuth());

  const handleLogout = () => {
    clearStoredAuth();
    setAuth(null);
  };

  if (!auth) {
    return <AuthScreen onAuthenticated={setAuth} />;
  }

  return <NotebookApp auth={auth} onLogout={handleLogout} />;
}

const root = ReactDOM.createRoot(document.getElementById('root'));
root.render(<App />);
