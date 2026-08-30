import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import './App.css';

type Tab = 'workspace' | 'applications' | 'dashboard';
type Row = Record<string, unknown>;
type ApiError = Error & { status?: number };
const TOKEN_KEY = 'cv_tuning_access_token';

async function api<T>(path: string, token: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(path, {
    ...options,
    headers: {
      ...(options.body && !(options.body instanceof FormData) ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...options.headers,
    },
  });
  if (!response.ok) {
    const error = new Error((await response.text()) || `Request failed (${response.status})`) as ApiError;
    error.status = response.status;
    throw error;
  }
  return response.json() as Promise<T>;
}

function errorMessage(error: unknown) {
  if (!(error instanceof Error)) return 'Something went wrong. Please try again.';
  try {
    const body = JSON.parse(error.message) as { message?: string | string[] };
    return Array.isArray(body.message) ? body.message.join(', ') : body.message || error.message;
  } catch { return error.message; }
}

function App() {
  const [token, setToken] = useState(() => sessionStorage.getItem(TOKEN_KEY) ?? '');
  const [tab, setTab] = useState<Tab>('workspace');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [consent, setConsent] = useState<boolean | null>(null);
  const [markdown, setMarkdown] = useState('');
  const [masterVersion, setMasterVersion] = useState<number | null>(null);
  const [jobUrl, setJobUrl] = useState('');
  const [jobText, setJobText] = useState('');
  const [jobs, setJobs] = useState<Row[]>([]);
  const [applications, setApplications] = useState<Row[]>([]);
  const [dashboard, setDashboard] = useState<Row | null>(null);
  const [selected, setSelected] = useState<Row | null>(null);
  const [renders, setRenders] = useState<Row[]>([]);
  const [revision, setRevision] = useState<Row | null>(null);
  const [diff, setDiff] = useState<Row | null>(null);
  const [instruction, setInstruction] = useState('');
  const [questions, setQuestions] = useState('');

  const run = async (work: () => Promise<void>) => {
    setBusy(true); setError('');
    try { await work(); } catch (cause) { setError(errorMessage(cause)); } finally { setBusy(false); }
  };
  const logout = () => { sessionStorage.removeItem(TOKEN_KEY); setToken(''); setSelected(null); setRevision(null); };
  const loadWorkspace = async () => {
    const jobRows = await api<Row[]>("/api/jobs", token);
    try {
      const consentResult = await api<{ consentVersion: string | null }>("/api/master/consent", token);
      setConsent(consentResult.consentVersion === "2026-08-27");
    } catch (cause) {
      if ((cause as ApiError).status !== 404) throw cause;
      setConsent(false);
    }
    setJobs(jobRows);
    try {
      const master = await api<{ markdown: string; version: number }>('/api/master', token);
      setMarkdown(master.markdown); setMasterVersion(master.version);
    } catch (cause) {
      if ((cause as ApiError).status !== 404) throw cause;
      setMarkdown(''); setMasterVersion(null);
    }
  };
  const loadApplications = async () => setApplications(await api<Row[]>('/api/applications', token));
  const loadApplication = async (application: Row) => {
    const id = String(application.id);
    const [current, rows] = await Promise.all([api<Row>(`/api/applications/${id}`, token), api<Row[]>(`/api/applications/${id}/renders`, token)]);
    setSelected(current); setRenders(rows);
    if (rows.length) await chooseRevision(current, rows[rows.length - 1]);
  };
  const chooseRevision = async (application: Row, render: Row) => {
    setRevision(render);
    setDiff(await api<Row>(`/api/applications/${application.id}/renders/${render.revisionNo}/diff`, token));
  };

  useEffect(() => {
    if (!token) return;
    run(async () => { await loadWorkspace(); await loadApplications(); });
  }, [token]);
  useEffect(() => {
    if (!token || tab !== 'dashboard') return;
    run(async () => setDashboard(await api<Row>('/api/dashboard', token)));
  }, [tab, token]);

  const login = (event: FormEvent) => { event.preventDefault(); run(async () => {
    const result = await api<{ accessToken: string }>('/auth/login', '', { method: 'POST', body: JSON.stringify({ email, password, client_id: 'cv-tuning' }) });
    sessionStorage.setItem(TOKEN_KEY, result.accessToken); setToken(result.accessToken); setPassword('');
  }); };
  const grantConsent = () => run(async () => { await api('/api/master/consent', token, { method: 'POST' }); setConsent(true); });
  const saveMaster = (event: FormEvent) => { event.preventDefault(); run(async () => { await api('/api/master', token, { method: 'POST', body: JSON.stringify({ markdown }) }); await loadWorkspace(); }); };
  const uploadMaster = (event: FormEvent<HTMLFormElement>) => { event.preventDefault(); const form = event.currentTarget; const file = new FormData(form).get('file'); if (!(file instanceof File) || !file.size) { setError('Choose a CV file first.'); return; } run(async () => { await api('/api/master/import/upload', token, { method: 'POST', body: new FormData(form) }); await loadWorkspace(); }); };
  const addJob = (event: FormEvent) => { event.preventDefault(); run(async () => {
    const pasted = jobText.trim();
    await api(pasted ? '/api/jobs/text' : '/api/jobs', token, { method: 'POST', body: JSON.stringify(pasted ? { text: pasted, ...(jobUrl.trim() ? { url: jobUrl } : {}) } : { url: jobUrl }) });
    setJobText(''); setJobUrl(''); await loadWorkspace();
  }); };
  const createApplication = (jobId: string) => run(async () => { await api('/api/applications', token, { method: 'POST', body: JSON.stringify({ jobId }) }); await loadApplications(); setTab('applications'); });
  const decide = (bulletId: string, decision: 'confirm' | 'drop') => run(async () => { if (!selected || !revision) return; await api(`/api/applications/${selected.id}/renders/${revision.revisionNo}/confirm-claim`, token, { method: 'POST', body: JSON.stringify({ bulletId, decision }) }); await loadApplication(selected); });
  const revise = (event: FormEvent) => { event.preventDefault(); run(async () => { if (!selected) return; await api(`/api/applications/${selected.id}/revise`, token, { method: 'POST', body: JSON.stringify({ instruction, inputMode: 'text' }) }); setInstruction(''); await loadApplication(selected); }); };
  const dictate = () => {
    const Recognition = (window as Window & { webkitSpeechRecognition?: new () => SpeechRecognition }).webkitSpeechRecognition;
    if (!Recognition) { setError('Speech recognition is not available in this browser. Type your revision instead.'); return; }
    const recognition = new Recognition(); recognition.lang = 'en-US'; recognition.interimResults = false;
    recognition.onresult = (event) => setInstruction(event.results[0][0].transcript); recognition.onerror = () => setError('Speech recognition could not understand that request.'); recognition.start();
  };
  const mutate = (path: string, body?: Row) => run(async () => { if (!selected) return; await api(`/api/applications/${selected.id}/${path}`, token, { method: 'POST', ...(body ? { body: JSON.stringify(body) } : {}) }); await loadApplication(selected); await loadApplications(); });
  const download = (kind: 'pdf' | 'docx') => run(async () => { if (!selected || !revision) return; const response = await fetch(`/api/applications/${selected.id}/renders/${revision.revisionNo}/download/${kind}`, { headers: { authorization: `Bearer ${token}` } }); if (!response.ok) throw new Error(await response.text()); const url = URL.createObjectURL(await response.blob()); const link = document.createElement('a'); link.href = url; link.download = `cv-r${revision.revisionNo}.${kind}`; link.click(); URL.revokeObjectURL(url); });
  const supplement = (kind: 'cover-letter' | 'screening') => mutate(kind, kind === 'screening' ? { questions: questions.split('\n').map((value) => value.trim()).filter(Boolean) } : { tone: 'plain' });

  if (!token) return <main className="auth-shell"><section className="auth-card"><p className="eyebrow">CV TUNING</p><h1>Tailor your work, not your truth.</h1><p>Grounded CV tailoring with fact-level review before anything is exported.</p>{error && <p className="notice error">{error}</p>}<form onSubmit={login}><label>Email<input type="email" required value={email} onChange={(event) => setEmail(event.target.value)} autoComplete="email" /></label><label>Password<input type="password" required value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="current-password" /></label><button disabled={busy}>{busy ? 'Signing in...' : 'Sign in'}</button></form><p className="muted">Use your Alfares account. The access token stays only in this tab.</p></section></main>;

  const bullets = (revision?.provenance as Row | undefined)?.bullets as Row[] | undefined;
  const hunks = diff?.hunks as Array<{ type?: string; value?: string; lines?: string[] }> | undefined;
  return <main className="app-shell"><header><div><p className="eyebrow">CV TUNING</p><h1>Evidence-first application workspace</h1></div><button className="secondary" onClick={logout}>Sign out</button></header><nav>{(['workspace', 'applications', 'dashboard'] as Tab[]).map((item) => <button key={item} className={tab === item ? 'active' : ''} onClick={() => setTab(item)}>{item}</button>)}</nav>{error && <p className="notice error">{error}</p>}
  {tab === 'workspace' && <section className="grid"><article className="panel"><h2>1. Consent and master CV</h2>{consent === false && <div className="notice"><p>AI processing requires your explicit consent.</p><button disabled={busy} onClick={grantConsent}>Grant CV-processing consent</button></div>}{consent && <><form onSubmit={saveMaster}><p className="muted">{masterVersion ? `Current master CV: version ${masterVersion}.` : 'Paste your first master CV.'}</p><label>Master CV<textarea rows={14} required value={markdown} onChange={(event) => setMarkdown(event.target.value)} placeholder="# Your name\n\n## Experience..." /></label><button disabled={busy}>Save and extract facts</button></form><form className="compact-form" onSubmit={uploadMaster}><label>Or import PDF, DOCX, text, or LinkedIn archive<input name="file" type="file" accept=".pdf,.docx,.txt,.zip" /></label><button className="secondary" disabled={busy}>Upload and extract</button></form></>}</article><article className="panel"><h2>2. Add a job</h2><form onSubmit={addJob}><label>Job posting URL<input type="url" value={jobUrl} onChange={(event) => setJobUrl(event.target.value)} placeholder="https://company.example/careers/role" /></label><label>Paste the posting<textarea rows={8} value={jobText} onChange={(event) => setJobText(event.target.value)} placeholder="Paste it here when automatic retrieval is blocked..." /></label><button disabled={busy || (!jobUrl.trim() && !jobText.trim())}>Add job</button></form><h3>Saved jobs</h3><div className="list">{jobs.length ? jobs.map((job) => <div className="row" key={String(job.id)}><div><strong>{String(job.title ?? 'Untitled position')}</strong><span>{String(job.company ?? job.fetchStatus ?? '')}</span>{job.fetchStatus !== 'ok' && <span className="warning">Posting needs pasted text: {String(job.fetchReason ?? 'not retrievable')}</span>}</div><button disabled={busy || !consent || !job.parsed} onClick={() => createApplication(String(job.id))}>Create tailored CV</button></div>) : <p className="muted">No jobs yet.</p>}</div></article></section>}
  {tab === 'applications' && <section className="applications-layout"><article className="panel application-list"><h2>Applications</h2>{applications.length ? applications.map((application) => <button className={`application ${selected?.id === application.id ? 'selected' : ''}`} key={String(application.id)} onClick={() => run(() => loadApplication(application))}><strong>{String(application.state)}</strong><span>{String(application.renderLanguage).toUpperCase()} · {Number(application.revisionCount)} revisions</span>{Boolean(application.stateError) && <span className="error">{String(application.stateError)}</span>}</button>) : <p className="muted">Create an application from a saved job.</p>}</article><article className="panel review">{!selected ? <p className="muted">Choose an application to review its evidence and revisions.</p> : <><div className="review-head"><div><h2>Review and approval</h2><p className="muted">Every generated claim is tied to a master-CV fact. Non-supported claims require an explicit decision.</p></div><span className="badge">{String(selected.state)}</span></div>{Boolean(revision?.degraded) && <p className="notice warning">Generated using fallback model {String(revision?.modelUsed)}. Review with extra care.</p>}<div className="revision-tabs">{renders.map((render) => <button key={String(render.id)} className={revision?.id === render.id ? 'active' : ''} onClick={() => run(() => chooseRevision(selected, render))}>Revision {String(render.revisionNo)}</button>)}</div><div className="review-grid"><section><h3>Tailored CV</h3><pre className="markdown">{String(revision?.markdown ?? '')}</pre><h3>Diff from {diff?.baselineRevisionNo ? `revision ${diff.baselineRevisionNo}` : 'master CV'}</h3><pre className="diff">{hunks?.map((hunk, index) => <span className={hunk.type === 'added' ? 'added' : hunk.type === 'removed' ? 'removed' : ''} key={index}>{(hunk.lines ?? [String(hunk.value ?? '')]).join('\n')}\n</span>)}</pre></section><section><h3>Claim provenance</h3>{bullets?.map((bullet) => <div className={`claim ${String(bullet.verdict)}`} key={String(bullet.bulletId)}><strong>{String(bullet.verdict)}</strong><p>{String(bullet.text)}</p><small>Source fact: {String(bullet.sourceFactId)}{bullet.targetRequirement ? ` · targets ${String(bullet.targetRequirement)}` : ''}</small>{bullet.verdict === 'overreach' && <div><button disabled={busy} onClick={() => decide(String(bullet.bulletId), 'confirm')}>Confirm claim</button><button className="secondary" disabled={busy} onClick={() => decide(String(bullet.bulletId), 'drop')}>Drop claim</button></div>}</div>)}</section></div><form className="revision-form" onSubmit={revise}><h3>Revise in your voice</h3><textarea required value={instruction} onChange={(event) => setInstruction(event.target.value)} placeholder="Ask for a change. Unsupported requests remain blocked by evidence checks." /><div><button type="button" className="secondary" onClick={dictate}>Use microphone</button><button disabled={busy}>Create revision</button></div></form><div className="actions"><button disabled={busy || selected.state !== 'in_review'} onClick={() => mutate('approve')}>Approve after review</button><button className="secondary" disabled={busy || !revision} onClick={() => download('pdf')}>Download PDF</button><button className="secondary" disabled={busy || !revision} onClick={() => download('docx')}>Download DOCX</button><button className="secondary" disabled={busy} onClick={() => mutate('mark-sent')}>Mark as sent</button></div><div className="supplements"><h3>Application supplements</h3><button className="secondary" disabled={busy} onClick={() => supplement('cover-letter')}>Generate cover letter</button><label>Screening questions (one per line)<textarea rows={3} value={questions} onChange={(event) => setQuestions(event.target.value)} /></label><button className="secondary" disabled={busy} onClick={() => supplement('screening')}>Generate screening answers</button></div><div className="outcomes"><span>Outcome:</span>{['interview', 'offer', 'rejected', 'ghosted'].map((outcome) => <button className="secondary" disabled={busy} key={outcome} onClick={() => mutate('outcome', { outcome })}>{outcome}</button>)}</div></>}</article></section>}
  {tab === 'dashboard' && <section className="panel"><h2>Application outcomes</h2>{dashboard ? <div className="metrics">{Object.entries((dashboard.funnel as Record<string, number>) ?? {}).map(([label, value]) => <div className="metric" key={label}><span>{label.replace('_', ' ')}</span><strong>{String(value)}</strong></div>)}<div className="metric"><span>Interview rate</span><strong>{dashboard.interviewRate == null ? '—' : `${Math.round(Number(dashboard.interviewRate) * 100)}%`}</strong></div><div className="metric"><span>Median reply days</span><strong>{String(dashboard.medianReplyDays ?? '—')}</strong></div></div> : <p className="muted">Loading dashboard...</p>}</section>}</main>;
}
interface SpeechRecognition { lang: string; interimResults: boolean; onresult: ((event: { results: { [index: number]: { [index: number]: { transcript: string } } } }) => void) | null; onerror: (() => void) | null; start(): void; }
export default App;
