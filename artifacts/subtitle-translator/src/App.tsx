import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent, type DragEvent, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ErrorBoundary } from '@/components/error-boundary';
import { Toaster } from '@/components/ui/toaster';
import { TooltipProvider } from '@/components/ui/tooltip';
import NotFound from '@/pages/not-found';
import { 
  Activity, AlertCircle, ArrowDownToLine, AudioLines, Check, CheckCircle2, 
  Clock3, FileAudio2, FileText, KeyRound, LockKeyhole, Pause, Play, 
  RotateCcw, ShieldCheck, Sparkles, Square, UploadCloud, Eye, EyeOff, 
  Layers, Zap, Cpu, RefreshCw, AlertTriangle
} from 'lucide-react';
import {
  Route,
  Switch,
  useLocation,
  Router as WouterRouter,
} from 'wouter';

const queryClient = new QueryClient();

interface ModelProfile {
  id: string;
  label: string;
  tier: 'high-volume' | 'ultra-quality' | 'legacy';
  tagline: string;
  badge?: string;
  recommended?: boolean;
  legacy?: boolean;
  rpd: number;
  rpm: number;
  tpm: number;
  minIntervalMs: number;
  strategy: 'chunked' | 'full';
  fallbacks: string[];
}

const FALLBACK_MODELS: ModelProfile[] = [
  {
    id: 'gemini-3.5-flash-lite',
    label: 'Gemini 3.5 Flash Lite',
    tier: 'high-volume',
    tagline: 'Overall #1 for daily runs. Stable 80–100 block chunks with natural Sinhala rhythm.',
    badge: 'Default / High Volume',
    recommended: true,
    rpd: 500,
    rpm: 15,
    tpm: 250000,
    minIntervalMs: 4500,
    strategy: 'chunked',
    fallbacks: ['gemini-3.1-flash-lite']
  },
  {
    id: 'gemini-3.1-flash-lite',
    label: 'Gemini 3.1 Flash Lite',
    tier: 'high-volume',
    tagline: 'Official high-volume backup. Takes over automatically on quota / 429 errors.',
    badge: 'Backup / High Volume',
    rpd: 500,
    rpm: 15,
    tpm: 250000,
    minIntervalMs: 4500,
    strategy: 'chunked',
    fallbacks: []
  },
  {
    id: 'gemini-3.8-flash',
    label: 'Gemini 3.8 Flash',
    tier: 'ultra-quality',
    tagline: '#1 linguistic quality. Full-episode context preserves slang, sarcasm and adult humour.',
    badge: 'Top Linguistic Quality',
    recommended: true,
    rpd: 20,
    rpm: 5,
    tpm: 250000,
    minIntervalMs: 12500,
    strategy: 'full',
    fallbacks: ['gemini-3.7-flash', 'gemini-3.6-flash', 'gemini-3-flash', 'gemini-3.5-flash-lite']
  },
  {
    id: 'gemini-3.7-flash',
    label: 'Gemini 3.7 Flash',
    tier: 'ultra-quality',
    tagline: 'Primary high-quality backup. Eliminates literal "Google Translate" phrasing.',
    badge: 'Quality Backup',
    rpd: 20,
    rpm: 5,
    tpm: 250000,
    minIntervalMs: 12500,
    strategy: 'full',
    fallbacks: ['gemini-3.6-flash', 'gemini-3-flash', 'gemini-3.5-flash-lite']
  },
  {
    id: 'gemini-3.6-flash',
    label: 'Gemini 3.6 Flash',
    tier: 'ultra-quality',
    tagline: 'Base Gen-3 model. Secondary Tier-2 fallback.',
    badge: 'Gen-3 Ultra-Quality',
    rpd: 20,
    rpm: 5,
    tpm: 250000,
    minIntervalMs: 12500,
    strategy: 'full',
    fallbacks: ['gemini-3-flash', 'gemini-3.5-flash-lite']
  },
  {
    id: 'gemini-3-flash',
    label: 'Gemini 3 Flash',
    tier: 'ultra-quality',
    tagline: 'Base Gen-3 model. Secondary Tier-2 fallback.',
    badge: 'Gen-3 Ultra-Quality',
    rpd: 20,
    rpm: 5,
    tpm: 250000,
    minIntervalMs: 12500,
    strategy: 'full',
    fallbacks: ['gemini-3.5-flash-lite']
  },
  {
    id: 'gemini-2.5-flash-lite',
    label: 'Gemini 2.5 Flash Lite',
    tier: 'legacy',
    tagline: 'Legacy model. Weaker Sinhala and more script bleeding.',
    badge: 'Legacy / Not Recommended',
    legacy: true,
    rpd: 20,
    rpm: 10,
    tpm: 250000,
    minIntervalMs: 6500,
    strategy: 'full',
    fallbacks: ['gemini-3.5-flash-lite']
  },
  {
    id: 'gemini-2.5-flash',
    label: 'Gemini 2.5 Flash',
    tier: 'legacy',
    tagline: 'Legacy model. Tends toward literal, textbook tone.',
    badge: 'Legacy / Literal Tone',
    legacy: true,
    rpd: 20,
    rpm: 5,
    tpm: 250000,
    minIntervalMs: 12500,
    strategy: 'full',
    fallbacks: ['gemini-3.5-flash-lite']
  }
];

interface JobSnapshot {
  id: string;
  fileName: string;
  state: 'queued' | 'running' | 'paused' | 'complete' | 'failed' | 'cancelled';
  phase: 'translating' | 'healing' | 'finalizing' | 'done';
  error: string | null;
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  totalBlocks: number;
  translatedBlocks: number;
  progress: number;
  chunk: {
    completed: number;
    current: number;
    estimatedTotal: number;
    range: { from: number; to: number; size: number } | null;
  };
  primaryModel: string;
  activeModel: string | null;
  activeStrategy: 'chunked' | 'full';
  mode: 'auto' | 'chunked' | 'full';
  chunkSize: number;
  modelSwitches: Array<{ at: number; from: string; to: string; reason: string }>;
  waiting: { reason: string; until: number } | null;
  purity: {
    status: 'monitoring' | 'healing' | 'passed' | 'healed' | 'issues';
    foreignScriptBlocks: number;
    parentheticalsStripped: number;
    autoCleaned: number;
    healed: number;
    pendingHeal: number;
    unresolved: number;
  };
  requests: number;
  tokens: { input: number; output: number };
  quota: Array<{ modelId: string; requestsToday: number; rpd: number }>;
  recent: Array<{
    index: string;
    timestamp: string;
    source: string;
    translation: string;
    healed: boolean;
    unresolved: boolean;
  }>;
  events: Array<{ at: number; level: 'info' | 'warn' | 'error'; message: string }>;
}

function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '—';
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${String(secs).padStart(2, '0')}`;
}

function Home() {
  const [apiKey, setApiKey] = useState(() => {
    try { return localStorage.getItem('subtitle-translator-api-key') || ''; } catch { return ''; }
  });
  const [showKey, setShowKey] = useState(false);
  const [persistKey, setPersistKey] = useState(() => {
    try { return localStorage.getItem('subtitle-translator-save-key') === 'true'; } catch { return false; }
  });

  const [models, setModels] = useState<ModelProfile[]>(FALLBACK_MODELS);
  const [selectedModelId, setSelectedModelId] = useState<string>('gemini-3.5-flash-lite');
  const [executionMode, setExecutionMode] = useState<'auto' | 'chunked' | 'full'>('auto');
  const [chunkSize, setChunkSize] = useState(90);

  const [file, setFile] = useState<File | null>(null);
  const [fileContent, setFileContent] = useState<string>('');
  const [fileName, setFileName] = useState('');
  const [cueCount, setCueCount] = useState<number | null>(null);

  const [jobId, setJobId] = useState<string | null>(null);
  const [jobSnapshot, setJobSnapshot] = useState<JobSnapshot | null>(null);
  const [localError, setLocalError] = useState<string>('');
  const [isDragging, setIsDragging] = useState(false);
  const [isStarting, setIsStarting] = useState(false);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Fetch available models from backend registry on mount
  useEffect(() => {
    fetch('/api/translate/models')
      .then(res => res.json())
      .then(data => {
        if (data.models && Array.isArray(data.models)) {
          setModels(data.models);
        }
      })
      .catch(() => {
        // Fallback to initial embedded registry
      });
  }, []);

  // Sync API key persistence
  useEffect(() => {
    try {
      if (persistKey && apiKey) {
        localStorage.setItem('subtitle-translator-api-key', apiKey);
        localStorage.setItem('subtitle-translator-save-key', 'true');
      } else {
        localStorage.removeItem('subtitle-translator-api-key');
        localStorage.setItem('subtitle-translator-save-key', 'false');
      }
    } catch {
      // Browser storage fallback
    }
  }, [apiKey, persistKey]);

  const activeModelProfile = useMemo(() => {
    return models.find(m => m.id === selectedModelId) || models[0];
  }, [models, selectedModelId]);

  // Polling active job
  useEffect(() => {
    if (!jobId) {
      if (pollTimerRef.current) clearInterval(pollTimerRef.current);
      return;
    }

    const poll = async () => {
      try {
        const res = await fetch(`/api/translate/jobs/${jobId}`);
        if (!res.ok) return;
        const snap: JobSnapshot = await res.json();
        setJobSnapshot(snap);

        if (snap.state === 'complete' || snap.state === 'failed' || snap.state === 'cancelled') {
          if (pollTimerRef.current) clearInterval(pollTimerRef.current);
        }
      } catch {
        // Ignore transient poll network errors
      }
    };

    poll();
    pollTimerRef.current = setInterval(poll, 1500);

    return () => {
      if (pollTimerRef.current) clearInterval(pollTimerRef.current);
    };
  }, [jobId]);

  const handleFile = useCallback(async (selectedFile: File) => {
    setLocalError('');
    if (!selectedFile.name.toLowerCase().endsWith('.srt')) {
      setLocalError('Please upload a valid .srt subtitle file.');
      return;
    }

    try {
      const text = await selectedFile.text();
      // Count approximate cue blocks
      const normalized = text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').trim();
      const blocks = normalized.split(/\n[ \t]*\n+/);
      const approxCues = blocks.filter(b => b.includes('-->')).length;

      setFile(selectedFile);
      setFileContent(text);
      setFileName(selectedFile.name);
      setCueCount(approxCues || blocks.length);
      setJobId(null);
      setJobSnapshot(null);
    } catch {
      setLocalError('Failed to read SRT file contents.');
    }
  }, []);

  const onFileInput = (e: ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (f) void handleFile(f);
    e.target.value = '';
  };

  const onDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setIsDragging(false);
    const f = e.dataTransfer.files?.[0];
    if (f) void handleFile(f);
  };

  const startTranslation = async () => {
    if (!apiKey.trim()) {
      setLocalError('A valid Gemini API key is required to start translation.');
      return;
    }
    if (!fileContent) {
      setLocalError('Please upload an SRT file first.');
      return;
    }

    setLocalError('');
    setIsStarting(true);

    try {
      const res = await fetch('/api/translate/jobs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          srtContent: fileContent,
          fileName,
          apiKey: apiKey.trim(),
          modelId: selectedModelId,
          mode: executionMode,
          chunkSize,
        }),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `Server returned HTTP ${res.status}`);
      }

      const snap: JobSnapshot = await res.json();
      setJobId(snap.id);
      setJobSnapshot(snap);
    } catch (err) {
      setLocalError(err instanceof Error ? err.message : 'Could not start translation job.');
    } finally {
      setIsStarting(false);
    }
  };

  const triggerAction = async (action: 'pause' | 'resume' | 'cancel') => {
    if (!jobId) return;
    try {
      const res = await fetch(`/api/translate/jobs/${jobId}/action`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action }),
      });
      if (res.ok) {
        const snap: JobSnapshot = await res.json();
        setJobSnapshot(snap);
      }
    } catch (err) {
      setLocalError(err instanceof Error ? err.message : 'Action failed');
    }
  };

  const downloadSrt = () => {
    if (!jobId) return;
    window.location.href = `/api/translate/jobs/${jobId}/download`;
  };

  const currentModelDisplay = useMemo(() => {
    if (!jobSnapshot?.activeModel) return activeModelProfile.label;
    const found = models.find(m => m.id === jobSnapshot.activeModel);
    return found ? found.label : jobSnapshot.activeModel;
  }, [jobSnapshot?.activeModel, activeModelProfile, models]);

  const activeStrategy = jobSnapshot ? jobSnapshot.activeStrategy : (
    executionMode === 'auto' ? activeModelProfile.strategy : executionMode
  );

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark"><AudioLines size={17} strokeWidth={1.7} /></span>
          <span>FRAME / TEXT</span>
        </div>
        <div className="top-meta">
          <span className="live-dot" />
          <span>Sinhala Localization Engine</span>
          <span>·</span>
          <span>3-Layer Defense Active</span>
        </div>
      </header>

      <main className="workspace">
        <div className="page-heading">
          <div>
            <div className="eyebrow">SRT LOCALIZATION PIPELINE · FAULT-TOLERANT</div>
            <h1>Sinhala Subtitle Studio</h1>
            <p>100% spoken Sinhala. Natural colloquial rhythm, zero foreign scripts, full frame sync.</p>
          </div>
          <div className="heading-index">ENGLISH → SINHALA (සිංහල)</div>
        </div>

        <div className="workspace-grid">
          {/* Left Column: Configuration & Upload */}
          <div>
            {/* Step 1: Model & Strategy Selector */}
            <section className="panel" aria-labelledby="settings-title">
              <div className="panel-head">
                <div className="panel-title">
                  <KeyRound size={15} />
                  <span id="settings-title">Gemini Multi-Model Registry & Key</span>
                </div>
                <span className="step">01 — CONFIGURE</span>
              </div>

              <div className="panel-body">
                <form className="field-block" autoComplete="off" onSubmit={e => e.preventDefault()}>
                  <label className="field-label" htmlFor="api-key">
                    Gemini API Key <span className="field-hint">DIRECT GOOGLE AI STUDIO KEY</span>
                  </label>
                  <div className="input-wrap">
                    <input
                      id="api-key"
                      className="field-control"
                      data-testid="input-api-key"
                      type={showKey ? 'text' : 'password'}
                      autoComplete="off"
                      placeholder="AIzaSy..."
                      value={apiKey}
                      onChange={e => setApiKey(e.target.value)}
                    />
                    <button
                      type="button"
                      aria-label={showKey ? 'Hide API key' : 'Reveal API key'}
                      className="icon-button"
                      data-testid="toggle-api-key-visibility"
                      onClick={() => setShowKey(v => !v)}
                    >
                      {showKey ? <EyeOff size={15} /> : <Eye size={15} />}
                    </button>
                  </div>
                  <label className="toggle-row">
                    <input
                      type="checkbox"
                      data-testid="checkbox-persist-key"
                      checked={persistKey}
                      onChange={e => setPersistKey(e.target.checked)}
                    />
                    <span>Remember on this browser instance</span>
                  </label>
                  <div className="privacy-note">
                    <LockKeyhole size={13} />
                    <span>Keys are kept private in-memory or device storage and hashed before quota management.</span>
                  </div>
                </form>

                {/* Model Selector */}
                <div className="field-block">
                  <label className="field-label" htmlFor="model-select">
                    Gemini Model Selection
                  </label>
                  <select
                    id="model-select"
                    className="select-control"
                    data-testid="select-model"
                    value={selectedModelId}
                    onChange={e => setSelectedModelId(e.target.value)}
                    disabled={jobSnapshot?.state === 'running'}
                  >
                    <optgroup label="Tier 1: High-Volume Chunking Models (500 RPD | 15 RPM)">
                      {models.filter(m => m.tier === 'high-volume').map(m => (
                        <option key={m.id} value={m.id}>
                          {m.label} ({m.rpd} RPD | {m.rpm} RPM) {m.badge ? `— [${m.badge}]` : ''}
                        </option>
                      ))}
                    </optgroup>
                    <optgroup label="Tier 2: Ultra-Quality Full-Context Models (20 RPD | 5 RPM)">
                      {models.filter(m => m.tier === 'ultra-quality').map(m => (
                        <option key={m.id} value={m.id}>
                          {m.label} ({m.rpd} RPD | {m.rpm} RPM) {m.badge ? `— [${m.badge}]` : ''}
                        </option>
                      ))}
                    </optgroup>
                    <optgroup label="Tier 3: Legacy Models">
                      {models.filter(m => m.tier === 'legacy').map(m => (
                        <option key={m.id} value={m.id}>
                          {m.label} ({m.rpd} RPD | {m.rpm} RPM) {m.badge ? `— [${m.badge}]` : ''}
                        </option>
                      ))}
                    </optgroup>
                  </select>
                  <div className="model-tagline-box">
                    <p className="model-tagline">{activeModelProfile.tagline}</p>
                    <div className="model-metrics">
                      <span className="metric-pill"><Zap size={11} /> {activeModelProfile.rpm} RPM limit</span>
                      <span className="metric-pill"><Cpu size={11} /> {activeModelProfile.rpd} RPD limit</span>
                      <span className="metric-pill">Pacing: {activeModelProfile.minIntervalMs / 1000}s</span>
                    </div>
                  </div>
                </div>

                {/* Strategy and Chunk Mode */}
                <div className="field-row">
                  <div className="field-block">
                    <label className="field-label" htmlFor="strategy-mode">
                      Execution Strategy
                    </label>
                    <select
                      id="strategy-mode"
                      className="select-control"
                      value={executionMode}
                      onChange={e => setExecutionMode(e.target.value as any)}
                      disabled={jobSnapshot?.state === 'running'}
                    >
                      <option value="auto">Auto (Model Default: {activeModelProfile.strategy.toUpperCase()})</option>
                      <option value="chunked">Chunked Batches (80–100 Blocks)</option>
                      <option value="full">Full-SRT Single Pass / Mega-Chunk</option>
                    </select>
                  </div>

                  <div className="field-block">
                    <label className="field-label" htmlFor="chunk-size">
                      Chunk Size <span className="field-hint">BLOCKS PER CALL</span>
                    </label>
                    <input
                      id="chunk-size"
                      className="field-control"
                      type="number"
                      min="40"
                      max="150"
                      value={chunkSize}
                      onChange={e => setChunkSize(Math.max(40, Math.min(150, Number(e.target.value) || 90)))}
                      disabled={executionMode === 'full' || jobSnapshot?.state === 'running'}
                    />
                  </div>
                </div>
              </div>
            </section>

            {/* Step 2: SRT File Upload */}
            <section className="panel" style={{ marginTop: 17 }} aria-labelledby="source-title">
              <div className="panel-head">
                <div className="panel-title">
                  <FileAudio2 size={15} />
                  <span id="source-title">Source Subtitle File</span>
                </div>
                <span className="step">02 — IMPORT</span>
              </div>

              <div className="panel-body">
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".srt,application/x-subrip,text/plain"
                  className="sr-only"
                  data-testid="input-srt-file"
                  onChange={onFileInput}
                />
                <div
                  className={`dropzone ${isDragging ? 'dragging' : ''}`}
                  data-testid="dropzone-srt"
                  role="button"
                  tabIndex={0}
                  onClick={() => fileInputRef.current?.click()}
                  onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') fileInputRef.current?.click(); }}
                  onDragOver={e => { e.preventDefault(); setIsDragging(true); }}
                  onDragLeave={() => setIsDragging(false)}
                  onDrop={onDrop}
                >
                  <span className="upload-icon"><UploadCloud size={17} /></span>
                  <span className="drop-title">{fileName ? 'Replace subtitle file' : 'Drop your .srt file here'}</span>
                  <span className="drop-sub">Standard SubRip .srt · Preserves all timestamps and styling</span>
                </div>

                {fileName && (
                  <div className="file-summary" data-testid="text-file-summary">
                    <div className="file-name">
                      <CheckCircle2 size={15} />
                      <span title={fileName}>{fileName}</span>
                    </div>
                    <span className="file-count">{cueCount?.toLocaleString()} CUES FOUND</span>
                  </div>
                )}

                {/* Error Banner */}
                {(localError || jobSnapshot?.error) && (
                  <div className="inline-error" role="alert" data-testid="status-error">
                    <AlertCircle size={14} style={{ verticalAlign: '-3px', marginRight: 6 }} />
                    {localError || jobSnapshot?.error}
                  </div>
                )}

                {/* Control Actions */}
                <div className="runbar">
                  {!jobSnapshot || jobSnapshot.state === 'queued' || jobSnapshot.state === 'complete' ? (
                    <button
                      className="button button-primary full-width"
                      disabled={!fileContent || isStarting}
                      onClick={startTranslation}
                    >
                      {isStarting ? <RefreshCw className="animate-spin" size={14} /> : <Play size={13} />}
                      {jobSnapshot?.state === 'complete' ? 'Start New Translation' : 'Start Sinhala Translation'}
                    </button>
                  ) : jobSnapshot.state === 'running' ? (
                    <>
                      <button className="button button-secondary" onClick={() => triggerAction('pause')}>
                        <Pause size={13} /> Pause Run
                      </button>
                      <button className="button button-danger" onClick={() => triggerAction('cancel')}>
                        <Square size={12} /> Cancel
                      </button>
                    </>
                  ) : jobSnapshot.state === 'paused' ? (
                    <>
                      <button className="button button-primary" onClick={() => triggerAction('resume')}>
                        <Play size={13} /> Resume
                      </button>
                      <button className="button button-danger" onClick={() => triggerAction('cancel')}>
                        <Square size={12} /> Cancel
                      </button>
                    </>
                  ) : (
                    <button className="button button-primary full-width" onClick={() => triggerAction('resume')}>
                      <RotateCcw size={13} /> Retry Remaining
                    </button>
                  )}

                  {jobSnapshot && (jobSnapshot.translatedBlocks > 0 || jobSnapshot.state === 'complete') && (
                    <button className="button button-secondary" onClick={downloadSrt}>
                      <ArrowDownToLine size={14} /> Download .SRT (UTF-8 BOM)
                    </button>
                  )}
                </div>
              </div>
            </section>

            <div className="footer-note">
              <ShieldCheck size={13} />
              <span>Layer 1 (Linguistic Prompt) + Layer 2 (Regex Sanitizer) + Layer 3 (Rolling Context) Active.</span>
            </div>
          </div>

          {/* Right Column: Execution Monitor & Preview */}
          <div>
            {/* Translation Monitor Panel */}
            <section className="panel" aria-labelledby="progress-title">
              <div className="panel-head">
                <div className="panel-title">
                  <Activity size={15} />
                  <span id="progress-title">Translation & Quality Monitor</span>
                </div>
                <span className={`status-chip ${jobSnapshot?.state === 'running' ? 'is-running' : jobSnapshot?.state === 'complete' ? 'is-done' : ''}`}>
                  <span className="status-light" />
                  {jobSnapshot ? jobSnapshot.state.toUpperCase() : 'STANDBY'}
                </span>
              </div>

              <div className="panel-body">
                {/* Active Model & Strategy Badge */}
                <div className="active-status-bar">
                  <div className="status-badge-item">
                    <span className="badge-lbl">ACTIVE MODEL:</span>
                    <strong className="badge-val">{currentModelDisplay}</strong>
                  </div>
                  <div className="status-badge-item">
                    <span className="badge-lbl">EXECUTION MODE:</span>
                    <strong className="badge-val">{activeStrategy === 'full' ? 'Full-SRT Single Pass' : 'Chunked (80–100 Blocks)'}</strong>
                  </div>
                </div>

                {/* Progress bar */}
                <div className="progress-meta" style={{ marginTop: 12 }}>
                  <span>Overall Translation Progress</span>
                  <strong>{jobSnapshot ? jobSnapshot.progress : 0}%</strong>
                </div>
                <div className="progress-track" role="progressbar">
                  <div className="progress-fill" style={{ width: `${jobSnapshot ? jobSnapshot.progress : 0}%` }} />
                </div>
                <div className="progress-meta">
                  <span>
                    {jobSnapshot?.chunk.range
                      ? `Processing Cues ${jobSnapshot.chunk.range.from}–${jobSnapshot.chunk.range.to}`
                      : jobSnapshot?.phase === 'healing'
                      ? 'Auto-Healing Corrupted / Missing Blocks...'
                      : 'Awaiting Run'}
                  </span>
                  <span>
                    {jobSnapshot ? `${jobSnapshot.translatedBlocks.toLocaleString()} / ${jobSnapshot.totalBlocks.toLocaleString()} cues` : '0 cues'}
                  </span>
                </div>

                {/* Unicode Purity Check Status Badge */}
                <div className="purity-card">
                  <div className="purity-header">
                    <div className="purity-title">
                      <ShieldCheck size={16} />
                      <span>Unicode Purity & Script Defense</span>
                    </div>
                    {jobSnapshot?.purity.status === 'passed' ? (
                      <span className="purity-badge passed">Passed (100% Sinhala)</span>
                    ) : jobSnapshot?.purity.status === 'healed' ? (
                      <span className="purity-badge healed">{jobSnapshot.purity.healed} Auto-Healed</span>
                    ) : jobSnapshot?.purity.status === 'healing' ? (
                      <span className="purity-badge healing">Auto-Heal Active</span>
                    ) : (
                      <span className="purity-badge clean">Monitoring</span>
                    )}
                  </div>
                  <div className="purity-stats">
                    <div><span>Foreign Script Rejections:</span> <strong>{jobSnapshot?.purity.foreignScriptBlocks || 0}</strong></div>
                    <div><span>Parenthetical Notes Stripped:</span> <strong>{jobSnapshot?.purity.parentheticalsStripped || 0}</strong></div>
                    <div><span>Auto-Healed Blocks:</span> <strong>{jobSnapshot?.purity.healed || 0}</strong></div>
                  </div>
                </div>

                {/* Fallback alerts if model switched */}
                {jobSnapshot && jobSnapshot.modelSwitches.length > 0 && (
                  <div className="switch-banner">
                    <AlertTriangle size={14} />
                    <span>
                      Fallback Triggered: Switched from {jobSnapshot.modelSwitches[0].from} to {jobSnapshot.modelSwitches[0].to} ({jobSnapshot.modelSwitches[0].reason}).
                    </span>
                  </div>
                )}

                {/* Waiting countdown indicator */}
                {jobSnapshot?.waiting && (
                  <div className="pacing-banner">
                    <Clock3 size={13} />
                    <span>Rate Limiter Pacing: {jobSnapshot.waiting.reason} ({Math.max(0, Math.ceil((jobSnapshot.waiting.until - Date.now()) / 1000))}s remaining)</span>
                  </div>
                )}
              </div>
            </section>

            {/* Live Subtitle Dialogue Preview */}
            <section className="panel preview-panel" aria-labelledby="preview-title">
              <div className="panel-head">
                <div className="panel-title">
                  <FileText size={15} />
                  <span id="preview-title">Live Sinhala Dialogue Output</span>
                </div>
                <span className="step">
                  {jobSnapshot?.recent?.length ? `LATEST ${jobSnapshot.recent.length}` : 'AWAITING RUN'}
                </span>
              </div>

              <div className="preview-body">
                <div className="preview-toolbar">
                  <span>English Source</span>
                  <span>Spoken Sinhala (කතා කරන සිංහල)</span>
                </div>

                {jobSnapshot?.recent && jobSnapshot.recent.length > 0 ? (
                  <div className="preview-list">
                    {jobSnapshot.recent.map(c => (
                      <article className="cue-row" key={c.index}>
                        <div className="cue-number">{c.index.padStart(2, '0')}</div>
                        <div>
                          <div className="cue-time">{c.timestamp}</div>
                          <div className="cue-copy original">{c.source}</div>
                          <div className="translation-separator">
                            TRANSLATED {c.healed ? '· [AUTO-HEALED]' : ''}
                          </div>
                          <div className="cue-copy translated">{c.translation}</div>
                        </div>
                      </article>
                    ))}
                  </div>
                ) : (
                  <div className="preview-empty">
                    <Sparkles size={19} />
                    <strong>Translated dialogues appear here in real time</strong>
                    <span>Start a translation to inspect spoken phrasing and Unicode integrity.</span>
                  </div>
                )}

                <div className="preview-footer">
                  <span>
                    {jobSnapshot?.translatedBlocks
                      ? `${jobSnapshot.translatedBlocks} cues translated & validated`
                      : 'Structure locked: Timestamps & numbering 100% preserved'}
                  </span>
                  {jobSnapshot && jobSnapshot.translatedBlocks > 0 && (
                    <button type="button" onClick={downloadSrt}>
                      Export .SRT (UTF-8 BOM) <ArrowDownToLine size={11} style={{ verticalAlign: '-2px' }} />
                    </button>
                  )}
                </div>
              </div>
            </section>
          </div>
        </div>
      </main>
    </div>
  );
}

function Router() {
  return (
    <RoutedErrorBoundary>
      <Switch>
        <Route path="/" component={Home} />
        <Route component={NotFound} />
      </Switch>
    </RoutedErrorBoundary>
  );
}

function RoutedErrorBoundary({ children }: { children: ReactNode }) {
  const [location] = useLocation();
  return <ErrorBoundary resetKey={location}>{children}</ErrorBoundary>;
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, '')}>
          <Router />
        </WouterRouter>
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
