import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import './App.css';
import { DiffView, type DiffHunk } from './DiffView';
import { CvPreview } from './CvPreview';
import { jobActionFor } from './jobAction';

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

/**
 * The workflow state as a person would say it. The stored values are identifiers, and a list
 * rendered from them showed a column of "in_review" with nothing to tell one application
 * from another.
 */
const STATE_LABELS: Record<string, string> = {
  generating: 'Generating',
  in_review: 'Awaiting your review',
  approved: 'Approved',
  sent: 'Sent',
  generation_failed: 'Generation failed',
};
const stateLabel = (state: string) => STATE_LABELS[state] ?? state.replace(/_/g, ' ');

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
  const [revision, setRevision] = useState<Row | null>(null);
  const [manualMarkdown, setManualMarkdown] = useState('');
  const [diff, setDiff] = useState<Row | null>(null);
  const [cvView, setCvView] = useState<'preview' | 'markdown' | 'diff'>('preview');
  const [instruction, setInstruction] = useState('');
  const [questions, setQuestions] = useState('');

  const run = async (work: () => Promise<void>, working = 'Working on it, please wait...') => {
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
      const master = await api<{ markdown?: string; version?: number }>('/api/master', token);
      // Coerced, not trusted: `markdown` feeds a controlled textarea and `markdown.trim()`,
      // so a missing field would throw during render and blank the whole workspace.
      setMarkdown(master.markdown ?? ''); setMasterVersion(master.version ?? null);
    } catch (cause) {
      if ((cause as ApiError).status !== 404) throw cause;
      setMarkdown(''); setMasterVersion(null);
    }
  };
  const loadApplications = async () => setApplications(await api<Row[]>('/api/applications', token));
  const loadApplication = async (application: Row) => {
    const id = String(application.id);
    const [current, rows] = await Promise.all([api<Row>(`/api/applications/${id}`, token), api<Row[]>(`/api/applications/${id}/renders`, token)]);
    // The single-application route returns the entity, which carries no job identity; the
    // list row does. Carried across so the review header can name the position rather than
    // repeat a state the badge already shows.
    setSelected({ ...current, jobTitle: application.jobTitle ?? null, jobCompany: application.jobCompany ?? null });
    if (rows.length) await chooseRevision(current, rows[rows.length - 1]);
  };
  const chooseRevision = async (application: Row, render: Row) => {
    setRevision(render); setManualMarkdown(String(render.markdown ?? ''));
    setDiff(await api<Row>(`/api/applications/${application.id}/renders/${render.revisionNo}/diff`, token));
  };

  useEffect(() => {
    if (!token) return;
    run(async () => { await loadWorkspace(); await loadApplications(); }, 'Loading your workspace...');
  }, [token]);
  useEffect(() => {
    if (!token || tab !== 'dashboard') return;
    run(async () => setDashboard(await api<Row>('/api/dashboard', token)), 'Loading your dashboard...');
  }, [tab, token]);

  const grantConsent = () => run(async () => { await api('/api/master/consent', token, { method: 'POST' }); setConsent(true); }, 'Recording your consent...');
  const saveMaster = (event: FormEvent) => { event.preventDefault(); run(async () => { await api('/api/master', token, { method: 'POST', body: JSON.stringify({ markdown }) }); await loadWorkspace(); }, 'Saving your master CV and extracting its facts...'); };
  const uploadMaster = (event: FormEvent<HTMLFormElement>) => { event.preventDefault(); const form = event.currentTarget; const file = new FormData(form).get('file'); if (!(file instanceof File) || !file.size) { setError('Choose a CV file first.'); return; } run(async () => { await api('/api/master/import/upload', token, { method: 'POST', body: new FormData(form) }); setSelectedFile(false); form.reset(); await loadWorkspace(); }, 'File received. Reading the document and extracting its facts. A scan is recognised with OCR, which takes longer.'); };
  const importGoogleDoc = (event: FormEvent) => { event.preventDefault(); run(async () => { await api('/api/master/import/gdocs', token, { method: 'POST', body: JSON.stringify({ url: gdocsUrl }) }); setGdocsUrl(''); await loadWorkspace(); }, 'Link received. Fetching your Google Doc and extracting its facts, please wait...'); };
  const addJob = (event: FormEvent) => { event.preventDefault(); run(async () => {
    const pasted = jobText.trim();
    await api(pasted ? '/api/jobs/text' : '/api/jobs', token, { method: 'POST', body: JSON.stringify(pasted ? { text: pasted, ...(jobUrl.trim() ? { url: jobUrl } : {}) } : { url: jobUrl }) });
    setJobText(''); setJobUrl(''); await loadWorkspace();
  }, jobText.trim()
    ? 'Job description received. Reading it and mapping its requirements to your facts...'
    : 'Job link received. Fetching the posting and mapping its requirements to your facts. This can take up to a minute...'); };
  const createApplication = (jobId: string) => run(async () => { await api('/api/applications', token, { method: 'POST', body: JSON.stringify({ jobId }) }); await loadApplications(); setTab('applications'); }, 'Building your tailored CV: matching your facts to the requirements and checking every claim. This takes a minute or two...');
  const decide = (bulletId: string, decision: 'confirm' | 'drop') => run(async () => { if (!selected || !revision) return; await api(`/api/applications/${selected.id}/renders/${revision.revisionNo}/confirm-claim`, token, { method: 'POST', body: JSON.stringify({ bulletId, decision }) }); await loadApplication(selected); }, 'Recording your decision and re-checking the claim...');
  const revise = (event: FormEvent) => { event.preventDefault(); run(async () => { if (!selected) return; await api(`/api/applications/${selected.id}/revise`, token, { method: 'POST', body: JSON.stringify({ instruction, inputMode: 'text' }) }); setInstruction(''); await loadApplication(selected); }, 'Revising in your voice and re-checking every claim against your facts. This takes a minute...'); };
  const dictate = () => {
    const Recognition = (window as Window & { webkitSpeechRecognition?: new () => SpeechRecognition }).webkitSpeechRecognition;
    if (!Recognition) { setError('Speech recognition is not available in this browser. Type your revision instead.'); return; }
    const recognition = new Recognition(); recognition.lang = 'en-US'; recognition.interimResults = false;
    recognition.onresult = (event) => setInstruction(event.results[0][0].transcript); recognition.onerror = () => setError('Speech recognition could not understand that request.'); recognition.start();
  };
  const mutate = (path: string, body?: Row, working?: string) => run(async () => { if (!selected) return; await api(`/api/applications/${selected.id}/${path}`, token, { method: 'POST', ...(body ? { body: JSON.stringify(body) } : {}) }); await loadApplication(selected); await loadApplications(); }, working ?? 'Updating this application...');
  const saveManualEdit = () => run(async () => { if (!selected) return; await api(`/api/applications/${selected.id}/edit`, token, { method: 'POST', body: JSON.stringify({ markdown: manualMarkdown }) }); await loadApplication(selected); await loadApplications(); }, 'Saving your manual CV edit...');
  const download = (kind: 'pdf' | 'docx') => run(async () => { if (!selected || !revision) return; const response = await fetch(`/api/applications/${selected.id}/renders/${revision.revisionNo}/download/${kind}`, { headers: { authorization: `Bearer ${token}` } }); if (!response.ok) throw new Error(await response.text()); const url = URL.createObjectURL(await response.blob()); const link = document.createElement('a'); link.href = url; link.download = `cv-r${revision.revisionNo}.${kind}`; link.click(); URL.revokeObjectURL(url); }, 'Preparing your file for download...');
  const supplement = (kind: 'cover-letter' | 'screening') => mutate(
    kind,
    kind === 'screening' ? { questions: questions.split('\n').map((value) => value.trim()).filter(Boolean) } : { tone: 'plain' },
    kind === 'screening' ? 'Drafting screening answers from your facts...' : 'Drafting your cover letter from your facts...',
  );

  if (!token) return <main className="landing-shell">
    <header className="landing-nav"><span className="brand">CV TUNING</span><div><button className="text-button" onClick={() => startHostedAuth('login')}>Sign in</button><button onClick={() => startHostedAuth('register')}>Start tailoring</button></div></header>
    <section className="hero"><div className="orb orb-one" /><div className="orb orb-two" /><p className="eyebrow">EVIDENCE-FIRST APPLICATIONS</p><h1>Land better roles without inventing a different you.</h1><p className="hero-copy">CV Tuning turns your proven experience into a position-specific CV, then shows every change, source fact, and uncertain claim before you send it.</p><div className="hero-actions"><button onClick={() => startHostedAuth('register')}>Build my first tailored CV <span aria-hidden="true">→</span></button><button className="secondary" onClick={() => startHostedAuth('login')}>I already have an account</button></div><p className="fine-print">No password is entered here. Secure sign-in and registration happen at Alfares Auth.</p><div className="product-preview" aria-label="Preview of the CV Tuning review workflow"><div className="preview-topbar"><span className="preview-logo">CV</span><span>Product Marketing Lead</span><span className="preview-status"><i /> Ready for review</span></div><div className="preview-main"><section className="preview-cv"><p className="preview-label">TAILORED CV · REVISION 01</p><div className="preview-name">Alex Morgan</div><div className="preview-role">Growth & product marketing</div><div className="preview-rule" /><div className="preview-line long" /><div className="preview-line medium" /><div className="preview-line short" /><div className="preview-highlight"><span>+</span> Led cross-functional launches with measurable adoption</div><div className="preview-line long" /></section><aside className="evidence-panel"><p className="preview-label">CLAIM REVIEW</p><div className="evidence-score"><span>94</span><small>fit score</small><svg viewBox="0 0 42 42" aria-hidden="true"><circle cx="21" cy="21" r="16" /><circle className="progress" cx="21" cy="21" r="16" /></svg></div><div className="evidence-card supported"><b>Supported</b><p>Led cross-functional launches</p><small>Source: Product lead · 2022–24</small></div><div className="evidence-card"><b>Targeted to requirement</b><p>Positioning, launch strategy, adoption</p></div><button className="preview-export" tabIndex={-1}>Review before export <span>→</span></button></aside></div><div className="floating-tag tag-voice"><span>◌</span> Revise in your voice</div></div></section>
    <section className="proof-strip"><div><strong>1 master CV</strong><span>Your source of truth</span></div><div><strong>Every role, tailored</strong><span>Against the real job description</span></div><div><strong>Every claim reviewed</strong><span>Before download or submission</span></div></section>
    <section className="value-section"><div><p className="eyebrow">WHY IT WORKS</p><h2>Recruiters can spot generic AI. You should be able to spot every sentence too.</h2></div><div className="feature-grid"><article><h3>Grounded, not generated from thin air</h3><p>Every tailored bullet is bound to a fact from your master CV. Unsupported and overreaching claims are visibly flagged instead of quietly exported.</p></article><article><h3>Review the actual change</h3><p>See a git-style diff from your source CV, targeted requirement by requirement. Keep what sounds like you, revise what does not.</p></article><article><h3>Apply with momentum</h3><p>Bring a job URL or paste the description. Get a fit report, tailored CV, cover letter, screening answers, and an outcome tracker in one focused workflow.</p></article></div></section>
    <section className="workflow"><p className="eyebrow">THE WORKFLOW</p><h2>Proof in. Better application out.</h2><ol><li><strong>Bring your CV.</strong><span>Paste, upload, or import the record of work you can stand behind.</span></li><li><strong>Add a position.</strong><span>We map its requirements to your real experience and show the gaps.</span></li><li><strong>Review, revise, approve.</strong><span>Use voice or text, confirm every disputed claim, then download when it is truly yours.</span></li></ol></section>
    <section className="closing"><p className="eyebrow">READY WHEN YOU ARE</p><h2>Your next application should sound like your best work, not like a prompt.</h2><button onClick={() => startHostedAuth('register')}>Start with your master CV</button><p className="fine-print">Account access is managed by Alfares Auth. CV Tuning never collects your password.</p></section>
  </main>;

  const openApplication = (application: Row) => run(async () => { await loadApplication(application); setTab('applications'); }, 'Opening this application...');

  const jobAction = (job: Row) => {
    const action = jobActionFor({
      jobId: String(job.id),
      parsed: Boolean(job.parsed),
      consent: consent === true,
      applications: applications.map((application) => ({ jobId: String(application.jobId), state: String(application.state) })),
    });
    const existing = applications.find((application) => String(application.jobId) === String(job.id));
    return { ...action, act: () => (action.creates || !existing ? createApplication(String(job.id)) : openApplication(existing)) };
  };

  /**
   * Claims still awaiting a decision, as the SERVER resolved them. It cannot be derived from
   * `verdict`: confirming carries the bullet forward unchanged, so a confirmed claim stays
   * `overreach` forever and a verdict-only reading re-offered a decision the user had already
   * made — each press minting another revision.
   */
  const pendingClaims = new Set(((revision?.needsConfirmation as Row[] | undefined) ?? []).map((bullet) => String(bullet.bulletId)));

  const bullets = (revision?.provenance as Row | undefined)?.bullets as Row[] | undefined;
  // Only an unresolved overreach ever needs a person's attention (spec: approval is gated on
  // exactly these). A decided one, or a claim already supported by the master CV, is resolved
  // and showing it again would be noise with nothing left to do about it.
  const pendingOverreachBullets = (bullets ?? []).filter(
    (bullet) => bullet.verdict === 'overreach' && pendingClaims.has(String(bullet.bulletId)),
  );
  const hunks = diff?.hunks as DiffHunk[] | undefined;
  return <main className="app-shell"><header><div><p className="eyebrow">CV TUNING</p><h1>Evidence-first application workspace</h1></div><button className="secondary" onClick={logout}>Sign out</button></header><nav>{(['workspace', 'applications', 'dashboard'] as Tab[]).map((item) => <button key={item} className={tab === item ? 'active' : ''} onClick={() => setTab(item)}>{item}</button>)}</nav>{error && <p className="notice error error-banner" role="alert">{error}</p>}{progress && <div className="progress-banner" role="status" aria-live="polite" aria-busy="true"><span className="progress-spinner" /><span>{progress}</span></div>}
  {tab === 'workspace' && <section className="grid"><article className="panel"><h2>1. Consent and master CV</h2>{consent === false && <div className="notice"><p>AI processing requires your explicit consent.</p><button disabled={busy} onClick={grantConsent}>Grant CV-processing consent</button></div>}{consent && <><form onSubmit={saveMaster}><p className="muted">{masterVersion ? `Current master CV: version ${masterVersion}.` : 'Paste your first master CV.'}</p><label>Master CV<textarea rows={14} required value={markdown} onChange={(event) => setMarkdown(event.target.value)} placeholder="# Your name\n\n## Experience..." /></label><button disabled={busy || !markdown.trim()}>Save and extract facts</button></form><form className="compact-form" onSubmit={importGoogleDoc}><label>Import from Google Docs URL<input type="url" required value={gdocsUrl} onChange={(event) => setGdocsUrl(event.target.value)} placeholder="https://docs.google.com/document/d/..." /></label><p className="field-help">In Google Docs, choose <strong>Share → Anyone with the link → Viewer</strong>. The document is imported as your master CV.</p><button disabled={busy || !gdocsUrl.trim()}>Import Google Doc</button></form><form className="compact-form" onSubmit={uploadMaster}><label>Or import PDF, DOCX, text, a photo or scan of your CV, or a LinkedIn archive<input name="file" type="file" accept=".pdf,.docx,.txt,.zip,.png,.jpg,.jpeg,.tiff,.webp" onChange={(event) => setSelectedFile(Boolean(event.target.files?.length))} /></label><button disabled={busy || !selectedFile}>Upload and extract</button></form></>}</article><article className="panel"><h2>2. Add a job</h2><form onSubmit={addJob}><label>Job posting URL<input type="url" value={jobUrl} onChange={(event) => setJobUrl(event.target.value)} placeholder="https://company.example/careers/role" /></label><label>Paste the posting<textarea rows={8} value={jobText} onChange={(event) => setJobText(event.target.value)} placeholder="Paste it here when automatic retrieval is blocked..." /></label><button disabled={busy || (!jobUrl.trim() && !jobText.trim())}>Add job</button></form><h3>Saved jobs</h3><div className="list">{jobs.length ? jobs.map((job) => { const action = jobAction(job); return <div className="row" key={String(job.id)}><div><strong>{String(job.title ?? 'Untitled position')}</strong><span>{String(job.company ?? job.fetchStatus ?? '')}</span>{job.fetchStatus !== 'ok' && <span className="warning">Posting needs pasted text: {String(job.fetchReason ?? 'not retrievable')}</span>}</div><button disabled={busy || action.disabled} onClick={action.act}>{action.label}</button></div>; }) : <p className="muted">No jobs yet.</p>}</div></article></section>}
  {tab === 'applications' && <section className="applications-layout"><article className="panel application-list"><h2>Applications</h2>{applications.length ? applications.map((application) => <button className={`application ${selected?.id === application.id ? 'selected' : ''}`} key={String(application.id)} onClick={() => run(() => loadApplication(application), 'Loading this application...')}><strong>{String(application.jobTitle ?? 'Untitled position')}</strong><span>{[application.jobCompany ? String(application.jobCompany) : '', stateLabel(String(application.state)), String(application.renderLanguage).toUpperCase() + ' · ' + Number(application.revisionCount) + ' revisions'].filter(Boolean).join(' · ')}</span>{Boolean(application.stateError) && <span className="error">{String(application.stateError)}</span>}</button>) : <p className="muted">Create an application from a saved job.</p>}</article><article className="panel review">{!selected ? <p className="muted">Choose an application to review its evidence and revisions.</p> : <><div className="review-head"><div><h2>{selected.jobTitle ? String(selected.jobTitle) : 'Review and approval'}</h2>{Boolean(selected.jobCompany) && <p className="muted">{String(selected.jobCompany)}</p>}<p className="muted">Every generated claim is tied to a master-CV fact. Non-supported claims require an explicit decision.</p></div><span className="badge">{stateLabel(String(selected.state))}</span></div>{Boolean(revision?.degraded) && <p className="notice warning">Generated using fallback model {String(revision?.modelUsed)}. Review with extra care.</p>}<div className={`review-grid${pendingOverreachBullets.length === 0 ? ' review-grid-single' : ''}`}><section>{Boolean(selected.jobTitle) && <p className="cv-view-position">Applying for: {String(selected.jobTitle)}{selected.jobCompany ? ` · ${String(selected.jobCompany)}` : ''}</p>}<div className="cv-view-tabs"><button className={cvView === 'preview' ? 'active' : ''} onClick={() => setCvView('preview')}>Preview</button><button className="secondary" disabled={busy} onClick={() => setCvView('markdown')}>Edit</button><button className={cvView === 'markdown' ? 'active' : ''} onClick={() => setCvView('markdown')}>Markdown</button>{!Boolean(diff?.noBaseline) && <button className={cvView === 'diff' ? 'active' : ''} onClick={() => setCvView('diff')}>Diff from revision {String(diff?.baselineRevisionNo)}</button>}</div>{cvView === 'preview' && <CvPreview markdown={String(revision?.markdown ?? '')} />}{cvView === 'markdown' && <div className="manual-markdown-editor"><label>CV markdown<textarea rows={20} value={manualMarkdown} onChange={(event) => setManualMarkdown(event.target.value)} /></label><p className="field-help">Manual edits are saved exactly as written. Keep the H1, H2, H3, and bullet structure so exports retain your intended layout.</p><button disabled={busy || !manualMarkdown.trim()} onClick={saveManualEdit}>Save edit</button></div>}{cvView === 'diff' && !Boolean(diff?.noBaseline) && <DiffView hunks={hunks} />}</section>{pendingOverreachBullets.length > 0 && <section><h3>Claims needing your decision</h3><p className="muted">Every generated claim is checked against your master CV. Only a claim that reaches beyond it — an “overreach” — ever needs a decision here: confirm it if it is true, or drop it. Once you decide, it stops appearing.</p>{pendingOverreachBullets.map((bullet) => <div className="claim overreach" key={String(bullet.bulletId)}><p>{String(bullet.text)}</p><small>Source fact: {String(bullet.sourceFactId)}{bullet.targetRequirement ? ` · targets ${String(bullet.targetRequirement)}` : ''}</small><div><button disabled={busy} onClick={() => decide(String(bullet.bulletId), 'confirm')}>Confirm claim</button><button className="secondary" disabled={busy} onClick={() => decide(String(bullet.bulletId), 'drop')}>Drop claim</button></div></div>)}</section>}</div><form className="revision-form" onSubmit={revise}><h3>Revise in your voice</h3><textarea required value={instruction} onChange={(event) => setInstruction(event.target.value)} placeholder="Ask for a change. Unsupported requests remain blocked by evidence checks." /><div><button type="button" className="secondary" onClick={dictate}>Use microphone</button><button disabled={busy}>Create revision</button></div></form><div className="actions"><button disabled={busy || selected.state !== 'in_review'} onClick={() => mutate('approve')}>Approve after review</button><button className="secondary" disabled={busy || !revision} onClick={() => download('pdf')}>Download PDF</button><button className="secondary" disabled={busy || !revision} onClick={() => download('docx')}>Download DOCX</button><button className="secondary" disabled={busy} onClick={() => mutate('mark-sent')}>Mark as sent</button></div><div className="supplements"><h3>Application supplements</h3><button className="secondary" disabled={busy} onClick={() => supplement('cover-letter')}>Generate cover letter</button><label>Screening questions (one per line)<textarea rows={3} value={questions} onChange={(event) => setQuestions(event.target.value)} /></label><button className="secondary" disabled={busy} onClick={() => supplement('screening')}>Generate screening answers</button></div><div className="outcomes"><span>Outcome:</span>{['interview', 'offer', 'rejected', 'ghosted'].map((outcome) => <button className="secondary" disabled={busy} key={outcome} onClick={() => mutate('outcome', { outcome })}>{outcome}</button>)}</div></>}</article></section>}
  {tab === 'dashboard' && <section className="panel"><h2>Application outcomes</h2>{dashboard ? <div className="metrics">{Object.entries((dashboard.funnel as Record<string, number>) ?? {}).map(([label, value]) => <div className="metric" key={label}><span>{label.replace('_', ' ')}</span><strong>{String(value)}</strong></div>)}<div className="metric"><span>Interview rate</span><strong>{dashboard.interviewRate == null ? '—' : `${Math.round(Number(dashboard.interviewRate) * 100)}%`}</strong></div><div className="metric"><span>Median reply days</span><strong>{String(dashboard.medianReplyDays ?? '—')}</strong></div></div> : <p className="muted">Loading dashboard...</p>}</section>}</main>;
}
interface SpeechRecognition { lang: string; interimResults: boolean; onresult: ((event: { results: { [index: number]: { [index: number]: { transcript: string } } } }) => void) | null; onerror: (() => void) | null; start(): void; }
export default App;
