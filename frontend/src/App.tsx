import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import './App.css';

type Tab = 'workspace' | 'applications' | 'dashboard';
type Row = Record<string, unknown>;
type ApiError = Error & { status?: number };
const TOKEN_KEY = 'cv_tuning_access_token';
const AUTH_STATE_PREFIX = 'cv_tuning_auth_state:';
const AUTH_ORIGIN = 'https://auth.alfares.cz';

function captureHostedAuthToken(): string {
  const url = new URL(window.location.href);
  if (url.pathname !== '/auth/callback') return sessionStorage.getItem(TOKEN_KEY) ?? '';
  const params = new URLSearchParams(url.hash.slice(1));
  const state = params.get('state');
  const token = params.get('access_token');
  const expected = state ? sessionStorage.getItem(AUTH_STATE_PREFIX + state) : null;
  if (state) sessionStorage.removeItem(AUTH_STATE_PREFIX + state);
  window.history.replaceState({}, '', '/');
  if (!token || !expected) return '';
  sessionStorage.setItem(TOKEN_KEY, token);
  return token;
}

function startHostedAuth(mode: 'login' | 'register') {
  const state = crypto.randomUUID();
  sessionStorage.setItem(AUTH_STATE_PREFIX + state, 'pending');
  const url = new URL('/' + mode, AUTH_ORIGIN);
  url.searchParams.set('client_id', 'cv-tuning');
  url.searchParams.set('return_url', window.location.origin + '/auth/callback');
  url.searchParams.set('state', state);
  url.searchParams.set('lang', 'en');
  window.location.assign(url);
}

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
  const [token, setToken] = useState(captureHostedAuthToken);
  const [tab, setTab] = useState<Tab>('workspace');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [progress, setProgress] = useState('');
  const [selectedFile, setSelectedFile] = useState(false);
  const [consent, setConsent] = useState<boolean | null>(null);
  const [markdown, setMarkdown] = useState('');
  const [gdocsUrl, setGdocsUrl] = useState('');
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

  const run = async (work: () => Promise<void>, working = '') => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true); setError(''); setProgress(working);
    try { await work(); } catch (cause) { setError(errorMessage(cause)); } finally { busyRef.current = false; setBusy(false); setProgress(''); }
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

  const grantConsent = () => run(async () => { await api('/api/master/consent', token, { method: 'POST' }); setConsent(true); });
  const saveMaster = (event: FormEvent) => { event.preventDefault(); run(async () => { await api('/api/master', token, { method: 'POST', body: JSON.stringify({ markdown }) }); await loadWorkspace(); }, 'Saving your master CV and extracting its facts...'); };
  const uploadMaster = (event: FormEvent<HTMLFormElement>) => { event.preventDefault(); const form = event.currentTarget; const file = new FormData(form).get('file'); if (!(file instanceof File) || !file.size) { setError('Choose a CV file first.'); return; } run(async () => { await api('/api/master/import/upload', token, { method: 'POST', body: new FormData(form) }); setSelectedFile(false); form.reset(); await loadWorkspace(); }, 'File received. Reading the document and extracting its facts. A scan is recognised with OCR, which takes longer.'); };
  const importGoogleDoc = (event: FormEvent) => { event.preventDefault(); run(async () => { await api('/api/master/import/gdocs', token, { method: 'POST', body: JSON.stringify({ url: gdocsUrl }) }); setGdocsUrl(''); await loadWorkspace(); }, 'Link received. Fetching your Google Doc and extracting its facts, please wait...'); };
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

  if (!token) return <main className="landing-shell">
    <header className="landing-nav"><span className="brand">CV TUNING</span><div><button className="text-button" onClick={() => startHostedAuth('login')}>Sign in</button><button onClick={() => startHostedAuth('register')}>Start tailoring</button></div></header>
    <section className="hero"><div className="orb orb-one" /><div className="orb orb-two" /><p className="eyebrow">EVIDENCE-FIRST APPLICATIONS</p><h1>Land better roles without inventing a different you.</h1><p className="hero-copy">CV Tuning turns your proven experience into a position-specific CV, then shows every change, source fact, and uncertain claim before you send it.</p><div className="hero-actions"><button onClick={() => startHostedAuth('register')}>Build my first tailored CV <span aria-hidden="true">→</span></button><button className="secondary" onClick={() => startHostedAuth('login')}>I already have an account</button></div><p className="fine-print">No password is entered here. Secure sign-in and registration happen at Alfares Auth.</p><div className="product-preview" aria-label="Preview of the CV Tuning review workflow"><div className="preview-topbar"><span className="preview-logo">CV</span><span>Product Marketing Lead</span><span className="preview-status"><i /> Ready for review</span></div><div className="preview-main"><section className="preview-cv"><p className="preview-label">TAILORED CV · REVISION 01</p><div className="preview-name">Alex Morgan</div><div className="preview-role">Growth & product marketing</div><div className="preview-rule" /><div className="preview-line long" /><div className="preview-line medium" /><div className="preview-line short" /><div className="preview-highlight"><span>+</span> Led cross-functional launches with measurable adoption</div><div className="preview-line long" /></section><aside className="evidence-panel"><p className="preview-label">CLAIM REVIEW</p><div className="evidence-score"><span>94</span><small>fit score</small><svg viewBox="0 0 42 42" aria-hidden="true"><circle cx="21" cy="21" r="16" /><circle className="progress" cx="21" cy="21" r="16" /></svg></div><div className="evidence-card supported"><b>Supported</b><p>Led cross-functional launches</p><small>Source: Product lead · 2022–24</small></div><div className="evidence-card"><b>Targeted to requirement</b><p>Positioning, launch strategy, adoption</p></div><button className="preview-export" tabIndex={-1}>Review before export <span>→</span></button></aside></div><div className="floating-tag tag-voice"><span>◌</span> Revise in your voice</div></div></section>
    <section className="proof-strip"><div><strong>1 master CV</strong><span>Your source of truth</span></div><div><strong>Every role, tailored</strong><span>Against the real job description</span></div><div><strong>Every claim reviewed</strong><span>Before download or submission</span></div></section>
    <section className="value-section"><div><p className="eyebrow">WHY IT WORKS</p><h2>Recruiters can spot generic AI. You should be able to spot every sentence too.</h2></div><div className="feature-grid"><article><h3>Grounded, not generated from thin air</h3><p>Every tailored bullet is bound to a fact from your master CV. Unsupported and overreaching claims are visibly flagged instead of quietly exported.</p></article><article><h3>Review the actual change</h3><p>See a git-style diff from your source CV, targeted requirement by requirement. Keep what sounds like you, revise what does not.</p></article><article><h3>Apply with momentum</h3><p>Bring a job URL or paste the description. Get a fit report, tailored CV, cover letter, screening answers, and an outcome tracker in one focused workflow.</p></article></div></section>
    <section className="workflow"><p className="eyebrow">THE WORKFLOW</p><h2>Proof in. Better application out.</h2><ol><li><strong>Bring your CV.</strong><span>Paste, upload, or import the record of work you can stand behind.</span></li><li><strong>Add a position.</strong><span>We map its requirements to your real experience and show the gaps.</span></li><li><strong>Review, revise, approve.</strong><span>Use voice or text, confirm every disputed claim, then download when it is truly yours.</span></li></ol></section>
    <section className="closing"><p className="eyebrow">READY WHEN YOU ARE</p><h2>Your next application should sound like your best work, not like a prompt.</h2><button onClick={() => startHostedAuth('register')}>Start with your master CV</button><p className="fine-print">Account access is managed by Alfares Auth. CV Tuning never collects your password.</p></section>
  </main>;

  const bullets = (revision?.provenance as Row | undefined)?.bullets as Row[] | undefined;
  const hunks = diff?.hunks as Array<{ type?: string; value?: string; lines?: string[] }> | undefined;
  return <main className="app-shell"><header><div><p className="eyebrow">CV TUNING</p><h1>Evidence-first application workspace</h1></div><button className="secondary" onClick={logout}>Sign out</button></header><nav>{(['workspace', 'applications', 'dashboard'] as Tab[]).map((item) => <button key={item} className={tab === item ? 'active' : ''} onClick={() => setTab(item)}>{item}</button>)}</nav>{error && <p className="notice error">{error}</p>}{progress && <p className="notice working">{progress}</p>}
  {tab === 'workspace' && <section className="grid"><article className="panel"><h2>1. Consent and master CV</h2>{consent === false && <div className="notice"><p>AI processing requires your explicit consent.</p><button disabled={busy} onClick={grantConsent}>Grant CV-processing consent</button></div>}{consent && <><form onSubmit={saveMaster}><p className="muted">{masterVersion ? `Current master CV: version ${masterVersion}.` : 'Paste your first master CV.'}</p><label>Master CV<textarea rows={14} required value={markdown} onChange={(event) => setMarkdown(event.target.value)} placeholder="# Your name\n\n## Experience..." /></label><button disabled={busy || !markdown.trim()}>Save and extract facts</button></form><form className="compact-form" onSubmit={importGoogleDoc}><label>Import from Google Docs URL<input type="url" required value={gdocsUrl} onChange={(event) => setGdocsUrl(event.target.value)} placeholder="https://docs.google.com/document/d/..." /></label><p className="field-help">In Google Docs, choose <strong>Share → Anyone with the link → Viewer</strong>. The document is imported as your master CV.</p><button disabled={busy || !gdocsUrl.trim()}>Import Google Doc</button></form><form className="compact-form" onSubmit={uploadMaster}><label>Or import PDF, DOCX, text, a photo or scan of your CV, or a LinkedIn archive<input name="file" type="file" accept=".pdf,.docx,.txt,.zip,.png,.jpg,.jpeg,.tiff,.webp" onChange={(event) => setSelectedFile(Boolean(event.target.files?.length))} /></label><button disabled={busy || !selectedFile}>Upload and extract</button></form></>}</article><article className="panel"><h2>2. Add a job</h2><form onSubmit={addJob}><label>Job posting URL<input type="url" value={jobUrl} onChange={(event) => setJobUrl(event.target.value)} placeholder="https://company.example/careers/role" /></label><label>Paste the posting<textarea rows={8} value={jobText} onChange={(event) => setJobText(event.target.value)} placeholder="Paste it here when automatic retrieval is blocked..." /></label><button disabled={busy || (!jobUrl.trim() && !jobText.trim())}>Add job</button></form><h3>Saved jobs</h3><div className="list">{jobs.length ? jobs.map((job) => <div className="row" key={String(job.id)}><div><strong>{String(job.title ?? 'Untitled position')}</strong><span>{String(job.company ?? job.fetchStatus ?? '')}</span>{job.fetchStatus !== 'ok' && <span className="warning">Posting needs pasted text: {String(job.fetchReason ?? 'not retrievable')}</span>}</div><button disabled={busy || !consent || !job.parsed} onClick={() => createApplication(String(job.id))}>Create tailored CV</button></div>) : <p className="muted">No jobs yet.</p>}</div></article></section>}
  {tab === 'applications' && <section className="applications-layout"><article className="panel application-list"><h2>Applications</h2>{applications.length ? applications.map((application) => <button className={`application ${selected?.id === application.id ? 'selected' : ''}`} key={String(application.id)} onClick={() => run(() => loadApplication(application))}><strong>{String(application.state)}</strong><span>{String(application.renderLanguage).toUpperCase()} · {Number(application.revisionCount)} revisions</span>{Boolean(application.stateError) && <span className="error">{String(application.stateError)}</span>}</button>) : <p className="muted">Create an application from a saved job.</p>}</article><article className="panel review">{!selected ? <p className="muted">Choose an application to review its evidence and revisions.</p> : <><div className="review-head"><div><h2>Review and approval</h2><p className="muted">Every generated claim is tied to a master-CV fact. Non-supported claims require an explicit decision.</p></div><span className="badge">{String(selected.state)}</span></div>{Boolean(revision?.degraded) && <p className="notice warning">Generated using fallback model {String(revision?.modelUsed)}. Review with extra care.</p>}<div className="revision-tabs">{renders.map((render) => <button key={String(render.id)} className={revision?.id === render.id ? 'active' : ''} onClick={() => run(() => chooseRevision(selected, render))}>Revision {String(render.revisionNo)}</button>)}</div><div className="review-grid"><section><h3>Tailored CV</h3><pre className="markdown">{String(revision?.markdown ?? '')}</pre><h3>Diff from {diff?.baselineRevisionNo ? `revision ${diff.baselineRevisionNo}` : 'master CV'}</h3><pre className="diff">{hunks?.map((hunk, index) => <span className={hunk.type === 'added' ? 'added' : hunk.type === 'removed' ? 'removed' : ''} key={index}>{(hunk.lines ?? [String(hunk.value ?? '')]).join('\n')}\n</span>)}</pre></section><section><h3>Claim provenance</h3>{bullets?.map((bullet) => <div className={`claim ${String(bullet.verdict)}`} key={String(bullet.bulletId)}><strong>{String(bullet.verdict)}</strong><p>{String(bullet.text)}</p><small>Source fact: {String(bullet.sourceFactId)}{bullet.targetRequirement ? ` · targets ${String(bullet.targetRequirement)}` : ''}</small>{bullet.verdict === 'overreach' && <div><button disabled={busy} onClick={() => decide(String(bullet.bulletId), 'confirm')}>Confirm claim</button><button className="secondary" disabled={busy} onClick={() => decide(String(bullet.bulletId), 'drop')}>Drop claim</button></div>}</div>)}</section></div><form className="revision-form" onSubmit={revise}><h3>Revise in your voice</h3><textarea required value={instruction} onChange={(event) => setInstruction(event.target.value)} placeholder="Ask for a change. Unsupported requests remain blocked by evidence checks." /><div><button type="button" className="secondary" onClick={dictate}>Use microphone</button><button disabled={busy}>Create revision</button></div></form><div className="actions"><button disabled={busy || selected.state !== 'in_review'} onClick={() => mutate('approve')}>Approve after review</button><button className="secondary" disabled={busy || !revision} onClick={() => download('pdf')}>Download PDF</button><button className="secondary" disabled={busy || !revision} onClick={() => download('docx')}>Download DOCX</button><button className="secondary" disabled={busy} onClick={() => mutate('mark-sent')}>Mark as sent</button></div><div className="supplements"><h3>Application supplements</h3><button className="secondary" disabled={busy} onClick={() => supplement('cover-letter')}>Generate cover letter</button><label>Screening questions (one per line)<textarea rows={3} value={questions} onChange={(event) => setQuestions(event.target.value)} /></label><button className="secondary" disabled={busy} onClick={() => supplement('screening')}>Generate screening answers</button></div><div className="outcomes"><span>Outcome:</span>{['interview', 'offer', 'rejected', 'ghosted'].map((outcome) => <button className="secondary" disabled={busy} key={outcome} onClick={() => mutate('outcome', { outcome })}>{outcome}</button>)}</div></>}</article></section>}
  {tab === 'dashboard' && <section className="panel"><h2>Application outcomes</h2>{dashboard ? <div className="metrics">{Object.entries((dashboard.funnel as Record<string, number>) ?? {}).map(([label, value]) => <div className="metric" key={label}><span>{label.replace('_', ' ')}</span><strong>{String(value)}</strong></div>)}<div className="metric"><span>Interview rate</span><strong>{dashboard.interviewRate == null ? '—' : `${Math.round(Number(dashboard.interviewRate) * 100)}%`}</strong></div><div className="metric"><span>Median reply days</span><strong>{String(dashboard.medianReplyDays ?? '—')}</strong></div></div> : <p className="muted">Loading dashboard...</p>}</section>}</main>;
}
interface SpeechRecognition { lang: string; interimResults: boolean; onresult: ((event: { results: { [index: number]: { [index: number]: { transcript: string } } } }) => void) | null; onerror: (() => void) | null; start(): void; }
export default App;
