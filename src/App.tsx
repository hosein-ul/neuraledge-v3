'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import { RefreshCw, Share2, Link as LinkIcon, Trash2, Download } from 'lucide-react';
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from 'recharts';

// ---------------------------------
// Config
// ---------------------------------
const PLATFORM_NAME = 'NeuralEdge';
const ALLORA_CHAIN = 'ethereum-11155111'; // internal only, not shown in UI
const ALLORA_V2_API_BASE = (chainId: string) => `https://api.allora.network/v2/allora/consumer/${chainId}`;
const ALLORA_API_KEY = typeof window !== 'undefined' && (window as any).ALLORA_API_KEY
  ? (window as any).ALLORA_API_KEY
  : 'UP-662ebd02310c4509bf66dc1e'; // dev only; use a server proxy for production

const DEFAULT_REFRESH_MS = 30000;
const MAX_POINTS = 1000; // store up to N inference samples per topic

// Topic map (source of truth)
type TopicInfo = { id: number; name: string; coinGeckoId: string };
const TOPIC_CONFIG: Record<string, Record<string, TopicInfo>> = {
  'BTC/USD': {
    '1 day': { id: 69, name: 'BTC/USD - 1 Day Prediction', coinGeckoId: 'bitcoin' },
    '8h': { id: 42, name: 'BTC/USD - 8 Hour Prediction', coinGeckoId: 'bitcoin' },
    '5min': { id: 14, name: 'BTC/USD - 5 Minute Prediction', coinGeckoId: 'bitcoin' },
  },
  'ETH/USD': {
    '8h': { id: 41, name: 'ETH/USD - 8 Hour Prediction', coinGeckoId: 'ethereum' },
    '5min': { id: 13, name: 'ETH/USD - 5 Minute Prediction', coinGeckoId: 'ethereum' },
  },
  'SOL/USD': {
    '8h': { id: 38, name: 'SOL/USD - 8 Hour Prediction', coinGeckoId: 'solana' },
    '5min': { id: 37, name: 'SOL/USD - 5 Minute Prediction', coinGeckoId: 'solana' },
    '10min': { id: 5, name: 'SOL/USD - 10 Minute Prediction', coinGeckoId: 'solana' },
  },
  'ETH/USDC': {
    '6h': { id: 46, name: 'ETH/USDC - 6 Hour Prediction', coinGeckoId: 'ethereum' },
  },
  BNB: {
    '20min': { id: 8, name: 'BNB/USD - 20 Minute Prediction', coinGeckoId: 'binancecoin' },
  },
};

// ---------------------------------
// Helpers
// ---------------------------------
const fmtUsd = (n: number | null | undefined) => {
  if (n === null || n === undefined || Number.isNaN(n)) return '—';
  try {
    return `$${Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  } catch {
    return `$${n}`;
  }
};

const fmtUsdShort = (n: number | null | undefined) => {
  if (n === null || n === undefined || Number.isNaN(n)) return '—';
  try {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: 'USD',
      notation: 'compact',
      maximumFractionDigits: 2,
    }).format(Number(n));
  } catch {
    return fmtUsd(n as number);
  }
};

const calcChangePct = (live: number | null, pred: number | null) => {
  if (live === null || pred === null) return null;
  if (!Number.isFinite(live) || !Number.isFinite(pred) || live === 0) return null;
  return ((pred - live) / live) * 100;
};

const useInterval = (cb: () => void, delay: number | null) => {
  const saved = useRef(cb);
  useEffect(() => {
    saved.current = cb;
  }, [cb]);
  useEffect(() => {
    if (delay === null) return;
    const id = setInterval(() => saved.current(), delay);
    return () => clearInterval(id);
  }, [delay]);
};

// Generic JSON fetch with timeout (new controller per attempt)
const fetchJsonWithTimeout = async (url: string, init: RequestInit = {}, timeoutMs = 12000) => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    if (!res.ok) {
      const err: any = new Error(`HTTP ${res.status}`);
      err.status = res.status;
      throw err;
    }
    return await res.json();
  } finally {
    clearTimeout(timeout);
  }
};

// Minimal retry with backoff for flaky networks / 429 / 5xx
const withRetry = async <T,>(fn: () => Promise<T>, retries = 1, delayMs = 700): Promise<T> => {
  try {
    return await fn();
  } catch (e: any) {
    if (retries <= 0) throw e;
    // Only retry for network-ish errors or server errors
    const msg = String(e?.message || '').toLowerCase();
    const status = Number(e?.status || 0);
    const retryable = msg.includes('network') || msg.includes('abort') || msg.includes('timeout') || status === 429 || status >= 500;
    if (!retryable) throw e;
    await new Promise((r) => setTimeout(r, delayMs));
    return withRetry(fn, retries - 1, Math.min(delayMs * 2, 3000));
  }
};

const fetchAllora = async (topicId: number) => {
  const apiUrl = `${ALLORA_V2_API_BASE(ALLORA_CHAIN)}?allora_topic_id=${topicId}`;
  const init: RequestInit = { headers: { accept: 'application/json', 'x-api-key': ALLORA_API_KEY }, mode: 'cors', cache: 'no-store' };
  const doFetch = () => fetchJsonWithTimeout(apiUrl, init, 12000);
  const j: any = await withRetry(doFetch, 1, 800);
  const v = j?.data?.inference_data?.network_inference_normalized;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
};

const fetchLivePrice = async (coinGeckoId: string) => {
  const url = `https://api.coingecko.com/api/v3/simple/price?ids=${coinGeckoId}&vs_currencies=usd`;
  const doFetch = () => fetchJsonWithTimeout(url, { mode: 'cors', cache: 'no-store' }, 12000);
  const j: any = await withRetry(doFetch, 1, 800);
  const v = j?.[coinGeckoId]?.usd;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
};

// localStorage persistence per topic (predictions history only)
const storageKey = (topicId: number) => `neuraledge:history:${topicId}`;
const loadHistory = (topicId?: number): { t: number; v: number }[] => {
  if (!topicId && topicId !== 0) return [];
  try {
    const raw = localStorage.getItem(storageKey(topicId));
    if (!raw) return [];
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return arr.filter((x) => Number.isFinite(x?.t) && Number.isFinite(x?.v));
  } catch {
    return [];
  }
};
const saveHistory = (topicId: number, arr: { t: number; v: number }[]) => {
  try {
    localStorage.setItem(storageKey(topicId), JSON.stringify(arr.slice(-MAX_POINTS)));
  } catch {}
};
const clearHistory = (topicId: number) => {
  try {
    localStorage.removeItem(storageKey(topicId));
  } catch {}
};

// Robust clipboard helper with fallback for non-secure contexts/older browsers
const copyToClipboard = async (text: string): Promise<boolean> => {
  try {
    if (window.isSecureContext && navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {}
  // Fallback: hidden textarea + execCommand
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.top = '-1000px';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
};

// Canonical current URL (exact domain + path + query + hash)
const currentUrl = (): string => {
  try { return new URL(window.location.href).toString(); } catch {
    const loc: any = window.location || {};
    return `${loc.origin || ''}${loc.pathname || ''}${loc.search || ''}${loc.hash || ''}`;
  }
};

// ---------------------------------
// UI Bits
// ---------------------------------
function Pill({ active, children, onClick }: { active: boolean; children: any; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className={`px-4 py-2 rounded-xl text-sm font-semibold border transition active:scale-[0.98] ${
        active
          ? 'bg-indigo-600 text-white border-indigo-500 shadow-xl shadow-indigo-600/40 ring-4 ring-indigo-500/20'
          : 'bg-gray-800/70 text-gray-200 border-gray-700 hover:bg-indigo-700/40 hover:text-white'
      }`}
    >
      {children}
    </button>
  );
}

function Stat({ label, value, hint }: { label: string; value: any; hint?: string }) {
  return (
    <div className='p-5 rounded-2xl border border-gray-700 bg-gray-800/70 shadow-lg'>
      <div className='text-sm text-gray-400 mb-1'>{label}</div>
      <div className={`text-4xl font-extrabold`}>{value}</div>
      {hint ? <div className='text-xs text-gray-500 mt-1'>{hint}</div> : null}
    </div>
  );
}

function StatusBanner({ status }: { status: { kind: 'loading' | 'ok' | 'error'; text: string } | null }) {
  if (!status) return null;
  const { kind, text } = status;
  const cls = {
    loading: 'bg-yellow-900 text-yellow-200 border border-yellow-600',
    ok: 'bg-emerald-900 text-emerald-200 border border-emerald-700',
    error: 'bg-rose-900 text-rose-200 border border-rose-700',
  }[kind];
  return <div className={`p-3 rounded-xl text-center text-sm font-medium ${cls}`}>{text}</div>;
}

function LiveVsPredChart({ data }: { data: { t: number; live: number | null; pred: number | null }[] }) {
  const chartData = useMemo(
    () =>
      data.map((d) => ({
        time: new Date(d.t).toLocaleTimeString('en-US', {
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit',
        }),
        Live: d.live,
        Predicted: d.pred,
      })),
    [data]
  );

  return (
    <div className='h-64 md:h-80'>
      <ResponsiveContainer width='100%' height='100%'>
        <LineChart data={chartData} margin={{ left: 8, right: 8, top: 8, bottom: 8 }}>
          <CartesianGrid strokeOpacity={0.15} />
          <XAxis dataKey='time' tick={{ fontSize: 12 }} />
          <YAxis tick={{ fontSize: 12 }} tickFormatter={(v: number) => fmtUsdShort(v)} domain={['dataMin', 'dataMax']} />
          <Tooltip formatter={(v: any) => fmtUsd(Number(v))} labelFormatter={(l) => `Time: ${l}`} />
          <Line type='monotoneX' dataKey='Live' stroke='#10b981' strokeWidth={2} dot={false} />
          <Line type='monotoneX' dataKey='Predicted' stroke='#818cf8' strokeWidth={2} dot={false} />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

function PredictionsHistoryChart({ data }: { data: { t: number; v: number }[] }) {
  const chartData = useMemo(
    () =>
      data.map((d) => ({
        time: new Date(d.t).toLocaleTimeString('en-US', {
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit',
        }),
        value: d.v,
      })),
    [data]
  );

  return (
    <div className='h-64 md:h-80'>
      <ResponsiveContainer width='100%' height='100%'>
        <LineChart data={chartData} margin={{ left: 8, right: 8, top: 8, bottom: 8 }}>
          <CartesianGrid strokeOpacity={0.15} />
          <XAxis dataKey='time' tick={{ fontSize: 12 }} />
          <YAxis tick={{ fontSize: 12 }} tickFormatter={(v: number) => fmtUsdShort(v)} domain={['dataMin', 'dataMax']} />
          <Tooltip formatter={(v: any) => fmtUsd(Number(v))} labelFormatter={(l) => `Time: ${l}`} />
          <Line type='monotoneX' dataKey='value' stroke='#818cf8' strokeWidth={2} dot={false} />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

// ---------------------------------
// Dev Tests (lightweight, run in browser console)
// ---------------------------------
function runDevTests() {
  try {
    console.group('[NeuralEdge] Dev tests');
    console.assert(fmtUsd(1234.5) === '$1,234.50', 'fmtUsd should format dollars');
    console.assert(fmtUsd(null as any) === '—', 'fmtUsd null -> —');
    const up = calcChangePct(100, 110);
    const down = calcChangePct(100, 90);
    console.assert(up && Math.abs(up - 10) < 1e-9, 'calcChangePct up 10%');
    console.assert(down && Math.abs(down + 10) < 1e-9, 'calcChangePct down -10%');
    console.assert(calcChangePct(0, 100) === null, 'calcChangePct returns null when live is 0');
    const tId = 999999;
    clearHistory(tId);
    const empty = loadHistory(tId);
    console.assert(Array.isArray(empty) && empty.length === 0, 'loadHistory empty');
    saveHistory(tId, [{ t: Date.now(), v: 1 }]);
    const loaded = loadHistory(tId);
    console.assert(Array.isArray(loaded) && loaded.length === 1, 'save/load history');
    // Copy helper existence (don’t assert success due to browser permissions)
    console.assert(typeof copyToClipboard === 'function', 'copyToClipboard helper exists');
    const cur = typeof window !== 'undefined' ? currentUrl() : 'http://localhost/';
    console.assert(typeof cur === 'string' && cur.length > 0, 'currentUrl returns a string');
    console.groupEnd();
  } catch (e) {
    console.error('Dev tests failed', e);
  }
}

// ---------------------------------
// Main Component
// ---------------------------------
export default function NeuralEdgeApp() {
  // restore selection from URL
  const urlParams = new URLSearchParams(typeof window !== 'undefined' ? window.location.search : '');
  const urlAsset = urlParams.get('asset');
  const urlTf = urlParams.get('tf');

  const [asset, setAsset] = useState(urlAsset && TOPIC_CONFIG[urlAsset] ? urlAsset : 'BTC/USD');
  const availableTFs = Object.keys(TOPIC_CONFIG[asset] || {});
  const [timeframe, setTimeframe] = useState(urlTf && availableTFs.includes(urlTf) ? urlTf : availableTFs[0]);

  const conf = TOPIC_CONFIG[asset]?.[timeframe] as TopicInfo | undefined;
  const topicId = conf?.id as number | undefined;

  const [status, setStatus] = useState<{ kind: 'loading' | 'ok' | 'error'; text: string } | null>({
    kind: 'loading',
    text: 'Booting NeuralEdge…',
  });
  const [auto, setAuto] = useState(true);
  const [refreshMs, setRefreshMs] = useState(DEFAULT_REFRESH_MS);

  const [latestPred, setLatestPred] = useState<number | null>(null);
  const [livePrice, setLivePrice] = useState<number | null>(null);
  const [changePct, setChangePct] = useState<number | null>(null);

  const [predHistory, setPredHistory] = useState<{ t: number; v: number }[]>([]);
  const [liveHistory, setLiveHistory] = useState<{ t: number; v: number }[]>([]);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);

  useEffect(() => {
    // run light tests in dev/browser
    if (typeof window !== 'undefined') runDevTests();
  }, []);

  // sync URL for shareability
  useEffect(() => {
    const q = new URLSearchParams({ asset, tf: timeframe });
    const newUrl = `${window.location.pathname}?${q.toString()}`;
    window.history.replaceState(null, '', newUrl);
  }, [asset, timeframe]);

  // load persisted prediction history when topic changes
  useEffect(() => {
    if (!topicId && topicId !== 0) return;
    const persisted = loadHistory(topicId);
    setPredHistory(persisted);
    setLiveHistory([]); // reset live history when topic changes
  }, [topicId]);

  const fetchAndAppend = async () => {
    if (!topicId || !conf) return;
    setStatus({ kind: 'loading', text: `Fetching inference for topic ${topicId}…` });
    try {
      const [predVal, liveVal] = await Promise.all([
        fetchAllora(topicId),
        fetchLivePrice(conf.coinGeckoId),
      ]);

      const now = Date.now();
      setLastUpdated(new Date(now));

      // prediction handling (persist)
      if (predVal !== null) {
        setLatestPred(predVal);
        setPredHistory((prev) => {
          const next = [...prev, { t: now, v: predVal }].slice(-MAX_POINTS);
          saveHistory(topicId, next);
          return next;
        });
      } else {
        setLatestPred(null);
      }

      // live price handling (in-memory only)
      if (liveVal !== null) {
        setLivePrice(liveVal);
        setLiveHistory((prev) => [...prev, { t: now, v: liveVal }].slice(-MAX_POINTS));
      } else {
        setLivePrice(null);
      }

      // change pct
      setChangePct(calcChangePct(liveVal, predVal));

      setStatus({ kind: 'ok', text: 'Data updated.' });
    } catch (e: any) {
      console.error(e);
      const msg = (e?.message || '').toLowerCase();
      const human =
        msg.includes('failed to fetch') || msg.includes('network') || msg.includes('abort') || msg.includes('timeout')
          ? 'Network error (CORS/timeout). Data may be stale; retrying…'
          : `Fetch failed: ${e.message}`;
      setStatus({ kind: 'error', text: human });
      // Do not clear last known values; keep UI stale-safe
    }
  };

  useEffect(() => {
    // initial fetch on topic change
    if (!topicId && topicId !== 0) return;
    setPredHistory(loadHistory(topicId));
    setLiveHistory([]);
    fetchAndAppend();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [topicId]);

  useInterval(() => {
    if (auto) fetchAndAppend();
  }, auto ? refreshMs : null);

  const copyLink = async () => {
  const url = currentUrl();
  const ok = await copyToClipboard(url);
  setStatus({ kind: ok ? 'ok' : 'error', text: ok ? 'Link copied.' : 'Copy failed. Long-press or copy from the address bar.' });
};

  const share = async () => {
  const url = currentUrl();
  try {
    const nav: any = navigator;
    if (nav && typeof nav.share === 'function') {
      await nav.share({ title: `${PLATFORM_NAME} • ${asset} • ${timeframe}`, url });
      setStatus({ kind: 'ok', text: 'Share dialog opened.' });
      return;
    }
  } catch (e: any) {
    if (String(e?.message || '').toLowerCase().includes('abort')) {
      setStatus({ kind: 'ok', text: 'Share canceled.' });
      return;
    }
  }
  const ok = await copyToClipboard(url);
  setStatus({ kind: ok ? 'ok' : 'error', text: ok ? 'Link copied (Share not supported).' : 'Unable to share/copy link.' });
};

  const onClear = () => {
    if (!topicId && topicId !== 0) return;
    clearHistory(topicId);
    setPredHistory([]);
    setStatus({ kind: 'ok', text: 'Prediction history cleared for this topic.' });
  };

  const onExport = () => {
    if ((!topicId && topicId !== 0) || predHistory.length === 0) return;
    const header = 'timestamp,value\n';
    const rows = predHistory.map((p) => `${new Date(p.t).toISOString()},${p.v}`).join('\n');
    const blob = new Blob([header + rows], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `neuraledge_topic_${topicId}_predictions.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  // combine series for dual chart (align by index as both append per fetch)
  const combined = useMemo(() => {
    const len = Math.min(liveHistory.length, predHistory.length);
    const out: { t: number; live: number | null; pred: number | null }[] = [];
    for (let i = Math.max(0, len - MAX_POINTS); i < len; i++) {
      out.push({ t: predHistory[i].t, live: liveHistory[i]?.v ?? null, pred: predHistory[i]?.v ?? null });
    }
    return out;
  }, [liveHistory, predHistory]);

  return (
    <div className='min-h-screen w-full bg-gradient-to-br from-gray-900 via-gray-950 to-black text-gray-100'>
      <div className='max-w-7xl mx-auto px-4 py-8'>
        {/* Header */}
        <header className='text-center mb-8'>
          <h1 className='text-5xl md:text-6xl font-extrabold text-transparent bg-clip-text bg-gradient-to-r from-indigo-400 to-indigo-200'>
            NeuralEdge
          </h1>
          <p className='mt-2 text-indigo-300'>Market predictions built on Allora. Real-time view, persistent history, exportable data. Research only.</p>
        </header>

        <div className='grid grid-cols-1 lg:grid-cols-3 gap-6'>
          {/* Controls */}
          <aside className='lg:col-span-1 bg-gray-900/70 backdrop-blur p-6 rounded-2xl border border-gray-800 shadow-2xl space-y-8'>
            <div>
              <h2 className='text-xl font-bold text-indigo-400 border-b border-gray-800 pb-3'>1. Select Asset Pair</h2>
              <div className='mt-4 grid grid-cols-2 gap-2'>
                {Object.keys(TOPIC_CONFIG).map((k) => (
                  <Pill key={k} active={k === asset} onClick={() => setAsset(k)}>
                    {k}
                  </Pill>
                ))}
              </div>
            </div>

            <div>
              <h2 className='text-xl font-bold text-indigo-400 border-b border-gray-800 pb-3'>2. Select Timeframe</h2>
              <div className='mt-4 grid grid-cols-3 gap-2'>
                {Object.keys(TOPIC_CONFIG[asset]).map((tf) => (
                  <Pill key={tf} active={tf === timeframe} onClick={() => setTimeframe(tf)}>
                    {tf}
                  </Pill>
                ))}
              </div>
            </div>

            <div className='bg-black/40 p-4 rounded-xl border border-indigo-700/40'>
              <h3 className='text-sm font-semibold text-indigo-300 mb-2'>Your Selection</h3>
              <div className='text-sm space-y-1'>
                <div>
                  <span className='text-gray-400'>Asset:</span> <span className='font-bold'>{asset}</span>
                </div>
                <div>
                  <span className='text-gray-400'>Timeframe:</span> <span className='font-bold'>{timeframe}</span>
                </div>
                <div className='font-mono text-xs'>
                  <span className='text-gray-400'>Topic ID:</span> {topicId ?? '—'}
                </div>
              </div>
            </div>

            <div className='space-y-3'>
              <h2 className='text-xl font-bold text-indigo-400 border-b border-gray-800 pb-3'>3. Settings</h2>
              <div className='flex items-center justify-between'>
                <label className='text-sm text-gray-300'>Auto refresh</label>
                <button
                  onClick={() => setAuto((a) => !a)}
                  className={`px-3 py-1 rounded-lg border text-sm ${auto ? 'bg-emerald-600/70 border-emerald-500' : 'bg-gray-800 border-gray-700'}`}
                >
                  {auto ? 'On' : 'Off'}
                </button>
              </div>
              <div>
                <label className='text-sm text-gray-300'>Refresh interval: {Math.round(refreshMs / 1000)}s</label>
                <input
                  type='range'
                  min={5}
                  max={120}
                  value={Math.round(refreshMs / 1000)}
                  onChange={(e) => setRefreshMs(Number(e.target.value) * 1000)}
                  className='w-full'
                />
              </div>
              <div className='flex items-center gap-2 flex-wrap'>
                <button onClick={fetchAndAppend} className='px-3 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 active:scale-[0.98] font-semibold flex items-center gap-2'>
                  <RefreshCw className='w-4 h-4' /> Fetch once
                </button>
                <button onClick={onClear} className='px-3 py-2 rounded-xl bg-gray-800 border border-gray-700 hover:bg-gray-700 active:scale-[0.98] font-semibold flex items-center gap-2'>
                  <Trash2 className='w-4 h-4' /> Clear predictions
                </button>
                <button onClick={onExport} className='px-3 py-2 rounded-xl bg-gray-800 border border-gray-700 hover:bg-gray-700 active:scale-[0.98] font-semibold flex items-center gap-2'>
                  <Download className='w-4 h-4' /> Export CSV
                </button>
              </div>
              
            </div>

            <div className='flex items-center gap-2 pt-2 flex-wrap'>
              <button onClick={copyLink} className='px-4 py-2 rounded-xl bg-gray-800 border border-gray-700 hover:bg-gray-700 active:scale-[0.98] font-semibold flex items-center gap-2'>
                <LinkIcon className='w-4 h-4' /> Copy link
              </button>
              <button onClick={share} className='px-4 py-2 rounded-xl bg-gray-800 border border-gray-700 hover:bg-gray-700 active:scale-[0.98] font-semibold flex items-center gap-2'>
                <Share2 className='w-4 h-4' /> Share
              </button>
            </div>
          </aside>

          {/* Data + Charts */}
          <main className='lg:col-span-2 space-y-5'>
            <div className='bg-gray-900/70 p-6 rounded-2xl border-t-4 border-indigo-500 shadow-xl'>
              <h2 className='text-3xl md:text-4xl font-extrabold text-center'>{conf?.name ?? 'Awaiting selection'}</h2>
              <div className='mt-3'>
                <StatusBanner status={status} />
              </div>
            </div>

            <div className='grid grid-cols-1 md:grid-cols-4 gap-4'>
              <Stat
                label='Live Price (USD)'
                value={fmtUsd(livePrice as any)}
                hint={
                  lastUpdated
                    ? `Last updated ${lastUpdated.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`
                    : ''
                }
              />
              <Stat label='Latest Prediction' value={fmtUsd(latestPred as any)} />
              <Stat label='Expected Change' value={changePct === null ? '—' : `${changePct > 0 ? '▲' : '▼'} ${Math.abs(changePct).toFixed(2)}%`} />
              <Stat label='Samples Stored' value={predHistory.length} />
            </div>

            {/* Main combined chart */}
            <div className='p-6 rounded-2xl border border-gray-800 bg-gray-900/70 shadow-lg'>
              <div className='text-sm text-gray-400 mb-3'>Live vs Predicted (recent samples)</div>
              <LiveVsPredChart data={combined} />
            </div>

            {/* Predictions-only history (persisted) */}
            <div className='p-6 rounded-2xl border border-gray-800 bg-gray-900/70 shadow-lg'>
              <div className='text-sm text-gray-400 mb-3'>Past predictions (persisted locally per topic)</div>
              <PredictionsHistoryChart data={predHistory} />
              <div className='text-[10px] text-gray-500 mt-2'>
                Sources: Live price via CoinGecko • Predictions via Allora • Prediction history stored locally per topic.
              </div>
            </div>

            {/* About */}
            <section className='p-5 rounded-2xl border border-gray-800 bg-gray-900/70'>
              <h3 className='text-lg font-semibold text-indigo-300 mb-2'>What is {PLATFORM_NAME}?</h3>
              <p className='text-sm text-gray-300 leading-6'>
                NeuralEdge is a research dashboard built on Allora Network infrastructure. It produces price predictions across multiple horizons and displays them alongside live market prices. The platform retains a history of predictions, visualizes trends, and lets you export data. NeuralEdge is an analytical tool, not financial advice.
              </p>
            </section>

            {/* Footer */}
            <footer className='text-center text-xs text-gray-500 pt-2'>
              <p>
                powered by allora • made with ❤️ by{' '}
                <a className='underline hover:text-indigo-300' href='https://x.com/andy1eth' target='_blank' rel='noreferrer noopener'>
                  @andy1eth
                </a>
              </p>
            </footer>
          </main>
        </div>
      </div>
    </div>
  );
}
