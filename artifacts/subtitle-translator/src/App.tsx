import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent, type DragEvent, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ErrorBoundary } from '@/components/error-boundary';
import { Toaster } from '@/components/ui/toaster';
import { TooltipProvider } from '@/components/ui/tooltip';
import NotFound from '@/pages/not-found';
import { Activity, AlertCircle, ArrowDownToLine, AudioLines, Check, CheckCircle2, Clock3, FileAudio2, FileText, KeyRound, LockKeyhole, Pause, Play, RotateCcw, ShieldCheck, Sparkles, Square, UploadCloud, Eye, EyeOff } from 'lucide-react';
import {
  Route,
  Switch,
  useLocation,
  Router as WouterRouter,
} from 'wouter';

const queryClient = new QueryClient();

type Cue = { id: string; timestamp: string; text: string; index: number };
type RunState = 'idle' | 'running' | 'paused' | 'failed' | 'cancelled' | 'complete';
const MODEL_OPTIONS = [
  ['gemini-3.5-flash-lite', 'Gemini 3.5 Flash Lite'],
  ['gemini-3.1-flash-lite', 'Gemini 3.1 Flash Lite'],
  ['gemini-3.8-flash', 'Gemini 3.8 Flash'],
  ['gemini-3.7-flash', 'Gemini 3.7 Flash'],
  ['gemini-2.5-flash', 'Gemini 2.5 Flash'],
];
const LANGUAGES = [
  'Sinhala (සිංහල - Natural Spoken/Conversational)',
  'Sinhala (Formal)',
  'Tamil',
  'Hindi',
  'Spanish',
  'French',
  'Custom language…',
];

function parseSrt(contents: string): Cue[] {
  const normalized = contents.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').trim();
  if (!normalized) throw new Error('This file is empty. Choose an SRT file with subtitle cues.');
  const blocks = normalized.split(/\n[ \t]*\n+/);
  const cues: Cue[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < blocks.length; i += 1) {
    const lines = blocks[i].split('\n');
    if (lines.length < 3 || !lines[0].trim() || !/^\d+$/.test(lines[0].trim())) {
      throw new Error(`Cue ${i + 1} is malformed. Each cue needs a number, timestamp, and dialogue.`);
    }
    const id = lines[0].trim();
    if (seen.has(id)) throw new Error(`Cue number ${id} appears more than once. Duplicate cue numbers cannot be translated safely.`);
    seen.add(id);
    const timestamp = lines[1];
    if (!/^\d{2}:\d{2}:\d{2},\d{3}\s-->\s\d{2}:\d{2}:\d{2},\d{3}(?:\s.*)?$/.test(timestamp)) {
      throw new Error(`Cue ${id} has an invalid timestamp line.`);
    }
    const text = lines.slice(2).join('\n').trimEnd();
    if (!text.trim()) throw new Error(`Cue ${id} has no dialogue text.`);
    cues.push({ id, timestamp, text, index: i });
  }
  if (!cues.length) throw new Error('No valid subtitle cues were found.');
  return cues;
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
  const [model, setModel] = useState('gemini-3.5-flash-lite');
  const [customModel, setCustomModel] = useState('');
  const [language, setLanguage] = useState(LANGUAGES[0]);
  const [customLanguage, setCustomLanguage] = useState('');
  const [chunkSize, setChunkSize] = useState(60);
  const [delaySeconds, setDelaySeconds] = useState(4);
  const [cues, setCues] = useState<Cue[]>([]);
  const [fileName, setFileName] = useState('');
  const [baseName, setBaseName] = useState('subtitles');
  const [translations, setTranslations] = useState<Record<string, string>>({});
  const [runState, setRunState] = useState<RunState>('idle');
  const [activeBatch, setActiveBatch] = useState(0);
  const [failedBatch, setFailedBatch] = useState<number | null>(null);
  const [error, setError] = useState('');
  const [isDragging, setIsDragging] = useState(false);
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const pausedRef = useRef(false);
  const mountedRef = useRef(true);
  const runGenerationRef = useRef(0);
  const fileLoadGenerationRef = useRef(0);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const targetLanguage = language === 'Custom language…' ? customLanguage.trim() : language;
  const modelId = model === 'custom' ? customModel.trim() : model;
  const batchCount = Math.ceil(cues.length / Math.max(1, chunkSize));
  const translatedCount = useMemo(() => cues.reduce((total, cue) => total + (translations[cue.id] !== undefined ? 1 : 0), 0), [cues, translations]);
  const progress = cues.length ? Math.round((translatedCount / cues.length) * 100) : 0;
  const completeBatches = useMemo(() => {
    if (!cues.length) return 0;
    return Math.floor(translatedCount / Math.max(1, chunkSize));
  }, [cues.length, translatedCount, chunkSize]);
  const remaining = translatedCount > 0 ? (elapsed / translatedCount) * (cues.length - translatedCount) : 0;
  const latestCues = useMemo(() => cues.filter((cue) => translations[cue.id] !== undefined).slice(-4).reverse(), [cues, translations]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      abortRef.current?.abort();
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, []);

  useEffect(() => {
    if (!startedAt || runState !== 'running') return;
    timerRef.current = setInterval(() => setElapsed(Math.floor((Date.now() - startedAt) / 1000)), 1000);
    return () => { if (timerRef.current) clearInterval(timerRef.current); };
  }, [startedAt, runState]);

  useEffect(() => {
    try {
      if (persistKey && apiKey) {
        localStorage.setItem('subtitle-translator-api-key', apiKey);
        localStorage.setItem('subtitle-translator-save-key', 'true');
      } else {
        localStorage.removeItem('subtitle-translator-api-key');
        localStorage.setItem('subtitle-translator-save-key', 'false');
      }
    } catch { /* Browser storage may be unavailable; the key remains in memory only. */ }
  }, [apiKey, persistKey]);

  const loadFile = useCallback(async (file: File) => {
    const fileGeneration = ++fileLoadGenerationRef.current;
    setError('');
    if (!file.name.toLowerCase().endsWith('.srt')) {
      setError('That file does not look like an .srt subtitle file. Choose an SRT file to continue.');
      return;
    }
    runGenerationRef.current += 1;
    abortRef.current?.abort();
    pausedRef.current = false;
    setRunState('idle');
    setActiveBatch(0);
    setFailedBatch(null);
    setStartedAt(null);
    setElapsed(0);
    try {
      const parsed = parseSrt(await file.text());
      if (fileGeneration !== fileLoadGenerationRef.current) return;
      setCues(parsed);
      setTranslations({});
      setFileName(file.name);
      setBaseName(file.name.replace(/\.srt$/i, '') || 'subtitles');
    } catch (caught) {
      if (fileGeneration !== fileLoadGenerationRef.current) return;
      setCues([]);
      setTranslations({});
      setFileName('');
      setError(caught instanceof Error ? caught.message : 'Unable to read this SRT file.');
    }
  }, []);

  const requestBatch = useCallback(async (batchIndex: number, signal: AbortSignal): Promise<Record<string, string>> => {
    const batch = cues.slice(batchIndex * chunkSize, (batchIndex + 1) * chunkSize);
    const instruction = `Translate subtitle dialogue into ${targetLanguage}. Use natural, modern conversational language. For Sinhala use කතා බහේ සිංහල suitable for TV and movies. Preserve emotion, register, slang, and all inline tags or symbols such as <i>, </i>, and ♪ exactly where appropriate. Never translate or return cue numbers or timecodes. Return only a valid JSON array matching the exact input ids, with objects shaped as {"id":"...","translatedText":"..."}.`;
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(modelId)}:generateContent`, {
      method: 'POST',
      headers: { 'x-goog-api-key': apiKey.trim(), 'Content-Type': 'application/json' },
      signal,
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: instruction }] },
        contents: [{ role: 'user', parts: [{ text: JSON.stringify(batch.map(({ id, text }) => ({ id, text }))) }] }],
        generationConfig: { responseMimeType: 'application/json' },
      }),
    });
    if (!response.ok) {
      const detail = await response.text();
      const message = `Google API returned ${response.status}${detail ? `: ${detail.slice(0, 240)}` : ''}`;
      const failure = new Error(message) as Error & { status?: number };
      failure.status = response.status;
      throw failure;
    }
    const payload = await response.json();
    const text = payload?.candidates?.[0]?.content?.parts?.map((part: { text?: string }) => part.text || '').join('').trim();
    if (!text) throw new Error('Gemini returned an empty response. Retry this batch or reduce the chunk size.');
    let output: unknown;
    try { output = JSON.parse(text); } catch { throw new Error('Gemini returned malformed JSON. No cues in this batch were accepted. Retry the batch or reduce chunk size.'); }
    if (!Array.isArray(output)) throw new Error('Gemini response was not a JSON array. No cues in this batch were accepted.');
    const expected = new Set(batch.map((cue) => cue.id));
    const accepted: Record<string, string> = {};
    for (const item of output) {
      if (!item || typeof item.id !== 'string' || typeof item.translatedText !== 'string' || !expected.has(item.id) || Object.hasOwn(accepted, item.id)) {
        throw new Error('Gemini returned unexpected or duplicate cue IDs. This batch was not accepted.');
      }
      accepted[item.id] = item.translatedText;
    }
    if (Object.keys(accepted).length !== expected.size || [...expected].some((id) => !Object.hasOwn(accepted, id))) {
      throw new Error('Gemini omitted one or more cue IDs. This batch was not accepted.');
    }
    return accepted;
  }, [apiKey, chunkSize, cues, modelId, targetLanguage]);

  const wait = (ms: number, signal: AbortSignal) => new Promise<void>((resolve, reject) => {
    if (signal.aborted) { reject(new DOMException('Aborted', 'AbortError')); return; }
    const timeout = setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve(); }, ms);
    const onAbort = () => { clearTimeout(timeout); reject(new DOMException('Aborted', 'AbortError')); };
    signal.addEventListener('abort', onAbort, { once: true });
  });

  const runBatches = useCallback(async (startBatch: number) => {
    if (!apiKey.trim()) { setError('Add your Gemini API key before starting translation.'); return; }
    if (!modelId) { setError('Choose or enter a Gemini model ID.'); return; }
    if (!targetLanguage) { setError('Enter the target language to continue.'); return; }
    if (!cues.length) { setError('Upload a valid SRT file before starting.'); return; }
    const runGeneration = ++runGenerationRef.current;
    pausedRef.current = false;
    const controller = new AbortController();
    abortRef.current = controller;
    setError('');
    setRunState('running');
    setFailedBatch(null);
    if (!startedAt) setStartedAt(Date.now() - elapsed * 1000);
    let processingBatch = startBatch;
    try {
      for (let batchIndex = startBatch; batchIndex < batchCount; batchIndex += 1) {
        processingBatch = batchIndex;
        while (pausedRef.current && !controller.signal.aborted) await wait(180, controller.signal);
        if (controller.signal.aborted || runGenerationRef.current !== runGeneration) break;
        setActiveBatch(batchIndex + 1);
        let accepted: Record<string, string> | null = null;
        for (let attempt = 0; attempt < 4; attempt += 1) {
          try {
            accepted = await requestBatch(batchIndex, controller.signal);
            break;
          } catch (caught) {
            if (controller.signal.aborted) throw caught;
            const status = (caught as Error & { status?: number }).status;
            const retryable = status === 429 || (status === undefined && caught instanceof TypeError);
            if (!retryable || attempt === 3) throw caught;
            setError(`Temporary ${status === 429 ? 'rate limit' : 'network'} issue. Retrying batch ${batchIndex + 1} in 15 seconds (${attempt + 1} of 3).`);
            await wait(15000, controller.signal);
            setError('');
          }
        }
        if (accepted) {
          if (runGenerationRef.current !== runGeneration) return;
          setTranslations((previous) => ({ ...previous, ...accepted }));
          setError('');
        }
        if (batchIndex < batchCount - 1 && delaySeconds > 0) await wait(delaySeconds * 1000, controller.signal);
      }
      if (runGenerationRef.current !== runGeneration) return;
      if (controller.signal.aborted) {
        if (mountedRef.current) setRunState('cancelled');
      } else if (mountedRef.current) setRunState('complete');
    } catch (caught) {
      if (!mountedRef.current || runGenerationRef.current !== runGeneration) return;
      if (controller.signal.aborted) {
        setRunState('cancelled');
      } else {
        setFailedBatch(processingBatch);
        setRunState('failed');
        setError(caught instanceof Error ? caught.message : 'Translation stopped unexpectedly.');
      }
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
    }
  }, [apiKey, modelId, targetLanguage, cues.length, batchCount, startedAt, elapsed, requestBatch, delaySeconds]);

  const start = () => {
    const firstPending = cues.findIndex((cue) => translations[cue.id] === undefined);
    runBatches(Math.max(0, Math.floor(firstPending / Math.max(1, chunkSize))));
  };
  const pause = () => { pausedRef.current = true; setRunState('paused'); };
  const resume = () => { if (runState === 'paused') { pausedRef.current = false; setRunState('running'); } };
  const cancel = () => { pausedRef.current = false; abortRef.current?.abort(); setRunState('cancelled'); };
  const retryFailed = () => {
    if (failedBatch === null) return;
    const index = failedBatch;
    setError('');
    runBatches(index);
  };

  const download = () => {
    const translated = cues.filter((cue) => translations[cue.id] !== undefined);
    if (!translated.length) return;
    const content = translated.map((cue) => `${cue.id}\n${cue.timestamp}\n${translations[cue.id]}`).join('\n\n') + '\n';
    const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    const languageSuffix = targetLanguage.startsWith('Sinhala') ? 'Sinhala' : targetLanguage.replace(/[^\p{L}\p{N}-]+/gu, '_').replace(/^_|_$/g, '') || 'Translated';
    anchor.href = url;
    anchor.download = `${baseName}_${languageSuffix}.srt`;
    anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const onFileInput = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (file) void loadFile(file);
    event.target.value = '';
  };
  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault(); setIsDragging(false);
    const file = event.dataTransfer.files?.[0];
    if (file) void loadFile(file);
  };
  const adjustDelay = (value: string) => {
    setModel(value);
    if (value.includes('flash-lite')) setDelaySeconds(4);
    else if (MODEL_OPTIONS.some(([id]) => id === value)) setDelaySeconds(12);
  };
  const statusLabel = runState === 'running' ? 'Translating' : runState === 'paused' ? 'Paused' : runState === 'failed' ? 'Needs attention' : runState === 'cancelled' ? 'Cancelled' : runState === 'complete' ? 'Complete' : cues.length ? 'Ready' : 'Waiting for file';
  const statusClass = runState === 'running' ? 'is-running' : runState === 'complete' ? 'is-done' : '';

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand"><span className="brand-mark"><AudioLines size={17} strokeWidth={1.7} /></span><span>FRAME / TEXT</span></div>
        <div className="top-meta"><span className="live-dot" /><span>Local workspace</span><span>·</span><span>v1.0</span></div>
      </header>
      <main className="workspace">
        <div className="page-heading">
          <div><div className="eyebrow">POST-PRODUCTION TOOLKIT / 01</div><h1>Subtitle translator</h1><p>Translate dialogue. Keep every frame in sync.</p></div>
          <div className="heading-index">SRT → {targetLanguage.startsWith('Sinhala') ? 'SINHALA' : (targetLanguage || 'TARGET').toLocaleUpperCase()}</div>
        </div>
        <div className="workspace-grid">
          <div>
            <section className="panel" aria-labelledby="settings-title">
              <div className="panel-head"><div className="panel-title"><KeyRound size={15} /><span id="settings-title">Translation setup</span></div><span className="step">01 — CONFIGURE</span></div>
              <div className="panel-body">
                <form className="field-block" autoComplete="off" onSubmit={(event) => event.preventDefault()}>
                  <label className="field-label" htmlFor="api-key">Gemini API key <span className="field-hint">REQUIRED</span></label>
                  <div className="input-wrap"><input id="api-key" className="field-control" data-testid="input-api-key" type={showKey ? 'text' : 'password'} autoComplete="off" placeholder="Paste your Google AI Studio key" value={apiKey} onChange={(event) => setApiKey(event.target.value)} /><button type="button" aria-label={showKey ? 'Hide API key' : 'Reveal API key'} className="icon-button" data-testid="toggle-api-key-visibility" onClick={() => setShowKey((visible) => !visible)}>{showKey ? <EyeOff size={15} /> : <Eye size={15} />}</button></div>
                  <label className="toggle-row"><input type="checkbox" data-testid="checkbox-persist-key" checked={persistKey} onChange={(event) => setPersistKey(event.target.checked)} /><span>Remember on this device <span className="field-hint">(optional)</span></span></label>
                  <div className="privacy-note"><LockKeyhole size={13} /><span>Your key is sent directly to Google for translation and stays in this browser. It is never saved unless you opt in above.</span></div>
                </form>
                <div className="field-row">
                  <div className="field-block"><label className="field-label" htmlFor="model-select">Gemini model</label><select id="model-select" className="select-control" data-testid="select-model" value={model} onChange={(event) => adjustDelay(event.target.value)}>{MODEL_OPTIONS.map(([id, label]) => <option key={id} value={id}>{label}</option>)}<option value="custom">Custom model ID</option></select></div>
                  <div className="field-block"><label className="field-label" htmlFor="language-select">Translate into</label><select id="language-select" className="select-control" data-testid="select-language" value={language} onChange={(event) => setLanguage(event.target.value)}>{LANGUAGES.map((item) => <option key={item} value={item}>{item}</option>)}</select></div>
                </div>
                {(model === 'custom' || language === 'Custom language…') && <div className="field-row">
                  {model === 'custom' && <div className="field-block"><label className="field-label" htmlFor="custom-model">Model ID</label><input id="custom-model" className="field-control" data-testid="input-custom-model" placeholder="e.g. gemini-2.5-flash" value={customModel} onChange={(event) => setCustomModel(event.target.value)} /></div>}
                  {language === 'Custom language…' && <div className="field-block"><label className="field-label" htmlFor="custom-language">Target language</label><input id="custom-language" className="field-control" data-testid="input-custom-language" placeholder="Enter a language" value={customLanguage} onChange={(event) => setCustomLanguage(event.target.value)} /></div>}
                </div>}
                <div className="field-row">
                  <div className="field-block"><label className="field-label" htmlFor="chunk-size">Cue blocks per batch <span className="field-hint">1–200</span></label><input id="chunk-size" className="field-control" data-testid="input-chunk-size" type="number" min="1" max="200" value={chunkSize} onChange={(event) => setChunkSize(Math.max(1, Math.min(200, Number(event.target.value) || 1)))} /></div>
                  <div className="field-block"><label className="field-label" htmlFor="delay">Delay between batches <span className="field-hint">SECONDS</span></label><input id="delay" className="field-control" data-testid="input-delay" type="number" min="0" max="120" value={delaySeconds} onChange={(event) => setDelaySeconds(Math.max(0, Math.min(120, Number(event.target.value) || 0)))} /></div>
                </div>
              </div>
            </section>
            <section className="panel" style={{ marginTop: 17 }} aria-labelledby="source-title">
              <div className="panel-head"><div className="panel-title"><FileAudio2 size={15} /><span id="source-title">Source subtitle file</span></div><span className="step">02 — IMPORT</span></div>
              <div className="panel-body">
                <input ref={fileInputRef} type="file" accept=".srt,application/x-subrip,text/plain" className="sr-only" data-testid="input-srt-file" onChange={onFileInput} />
                <div className={`dropzone ${isDragging ? 'dragging' : ''}`} data-testid="dropzone-srt" role="button" tabIndex={0} onClick={() => fileInputRef.current?.click()} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') fileInputRef.current?.click(); }} onDragOver={(event) => { event.preventDefault(); setIsDragging(true); }} onDragLeave={() => setIsDragging(false)} onDrop={onDrop}>
                  <span className="upload-icon"><UploadCloud size={17} /></span><span className="drop-title">{fileName ? 'Replace subtitle file' : 'Drop your .srt file here'}</span><span className="drop-sub">or browse files · UTF-8 subtitle format</span>
                </div>
                {fileName && <div className="file-summary" data-testid="text-file-summary"><div className="file-name"><CheckCircle2 size={15} /><span title={fileName}>{fileName}</span></div><span className="file-count">{cues.length.toLocaleString()} CUES</span></div>}
                <div className="summary-strip" aria-live="polite">
                  <div className="summary-cell"><div className="summary-value" data-testid="text-cue-count">{cues.length ? cues.length.toLocaleString() : '—'}</div><div className="summary-label">Subtitle cues</div></div>
                  <div className="summary-cell"><div className="summary-value" data-testid="text-batch-count">{cues.length ? batchCount.toLocaleString() : '—'}</div><div className="summary-label">Estimated batches</div></div>
                  <div className="summary-cell"><div className="summary-value">EN</div><div className="summary-label">Source language</div></div>
                </div>
                {error && <div className="inline-error" role="alert" data-testid="status-error"><AlertCircle size={14} style={{ verticalAlign: '-3px', marginRight: 6 }} />{error}</div>}
                <div className="runbar">
                  {runState === 'running' ? <><button className="button button-secondary" data-testid="button-pause" onClick={pause}><Pause size={13} />Pause</button><button className="button button-danger" data-testid="button-cancel" onClick={cancel}><Square size={12} />Cancel</button></> :
                    runState === 'paused' ? <><button className="button button-primary" data-testid="button-resume" onClick={resume}><Play size={13} />Resume translation</button><button className="button button-danger" data-testid="button-cancel" onClick={cancel}><Square size={12} />Cancel</button></> :
                      runState === 'failed' ? <><button className="button button-primary" data-testid="button-retry-failed" onClick={retryFailed}><RotateCcw size={13} />Retry failed batch</button><button className="button button-secondary" data-testid="button-continue" onClick={start}><Play size={13} />Continue remaining</button></> :
                        <button className="button button-primary full-width" data-testid="button-start" disabled={!cues.length || runState === 'complete'} onClick={start}>{runState === 'complete' ? <><Check size={14} />Translation complete</> : <><Play size={13} />{translatedCount ? 'Continue translation' : 'Start translation'}</>}</button>}
                  {translatedCount > 0 && <button className="button button-secondary" data-testid="button-download" onClick={download}><ArrowDownToLine size={14} />Download .SRT</button>}
                </div>
              </div>
            </section>
            <div className="footer-note"><ShieldCheck size={13} /><span>Original cue numbering and timecodes are locked throughout translation.</span></div>
          </div>
          <div>
            <section className="panel" aria-labelledby="progress-title">
              <div className="panel-head"><div className="panel-title"><Activity size={15} /><span id="progress-title">Translation run</span></div><span className={`status-chip ${statusClass}`} data-testid="status-run"><span className="status-light" />{statusLabel}</span></div>
              <div className="panel-body">
                <div className="progress-meta"><span>Overall progress</span><strong data-testid="text-progress">{progress}%</strong></div>
                <div className="progress-track" role="progressbar" aria-valuenow={progress} aria-valuemin={0} aria-valuemax={100} aria-label="Translation progress"><div className="progress-fill" style={{ width: `${progress}%` }} /></div>
                <div className="progress-meta"><span data-testid="text-current-batch">{cues.length ? `Batch ${Math.min(activeBatch || (completeBatches + 1), batchCount)} of ${batchCount}` : 'No active batches'}</span><span>{translatedCount.toLocaleString()} / {cues.length.toLocaleString()} cues</span></div>
                <div className="progress-stats"><div className="stat"><label>Elapsed</label><span data-testid="text-elapsed">{formatTime(elapsed)}</span></div><div className="stat"><label>Est. remaining</label><span data-testid="text-remaining">{translatedCount === cues.length && cues.length ? '0:00' : formatTime(remaining)}</span></div><div className="stat"><label>Batch size</label><span>{chunkSize} cues</span></div></div>
                {runState === 'paused' && <div className="inline-error" role="status" data-testid="status-paused">Translation paused. Completed cues are saved in this session. Resume when you are ready.</div>}
                {runState === 'cancelled' && <div className="inline-error" role="status" data-testid="status-cancelled">Run cancelled. Your translated cues are still available to download or continue.</div>}
                {runState === 'complete' && <div className="privacy-note" role="status" data-testid="status-complete"><CheckCircle2 size={14} /><span>All {cues.length.toLocaleString()} cues translated. Your SRT is ready to download.</span></div>}
              </div>
            </section>
            <section className="panel preview-panel" aria-labelledby="preview-title">
              <div className="panel-head"><div className="panel-title"><FileText size={15} /><span id="preview-title">Live cue preview</span></div><span className="step">{latestCues.length ? `LATEST ${latestCues.length}` : 'AWAITING OUTPUT'}</span></div>
              <div className="preview-body">
                <div className="preview-toolbar"><span>Original / translated</span><span>{targetLanguage.startsWith('Sinhala') ? 'SINHALA' : (targetLanguage || 'TARGET').toLocaleUpperCase()}</span></div>
                {latestCues.length ? <div className="preview-list" data-testid="list-preview-cues">{latestCues.map((cue) => <article className="cue-row" key={cue.id} data-testid={`cue-preview-${cue.id}`}><div className="cue-number">{cue.id.padStart(2, '0')}</div><div><div className="cue-time">{cue.timestamp}</div><div className="cue-copy original">{cue.text}</div><div className="translation-separator">TRANSLATED</div><div className="cue-copy translated">{translations[cue.id]}</div></div></article>)}</div> :
                  <div className="preview-empty"><Sparkles size={19} /><strong>Your translated cues will appear here</strong><span>Upload an SRT and start a run to see the latest output.</span></div>}
                <div className="preview-footer"><span data-testid="text-preview-count">{translatedCount ? `${translatedCount} translated cue${translatedCount === 1 ? '' : 's'} in this session` : 'Cue order and timecodes remain unchanged'}</span>{translatedCount > 0 && <button type="button" data-testid="button-download-preview" onClick={download}>Export partial <ArrowDownToLine size={11} style={{ verticalAlign: '-2px' }} /></button>}</div>
              </div>
            </section>
            <div className="footer-note"><Clock3 size={12} /><span>Translation requests run in batches with a {delaySeconds}s interval.</span></div>
          </div>
        </div>
      </main>
    </div>
  );
}

function Router() {
  return (
    // Keep a shared shell (sidebar, navbar) outside the boundary so it
    // survives a page crash.
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
