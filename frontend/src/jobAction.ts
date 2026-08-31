/**
 * What the button on a saved job offers, derived from the workflow state of the application
 * that job already produced.
 *
 * Extracted from App so it can be verified on its own. A fixed "Create tailored CV" label
 * both misreported work that was already done and let a second press mint a duplicate
 * application for the same position; the label is now the workflow's own answer.
 *
 * `state` values mirror ApplicationState in src/applications/application.types.ts. An
 * unrecognised one falls through to a neutral "open" rather than being treated as absent —
 * a state this file has not heard of still means an application exists.
 */
export interface JobActionInput {
  jobId: string;
  parsed: boolean;
  consent: boolean;
  applications: { jobId: string; state: string }[];
}

export interface JobAction {
  label: string;
  disabled: boolean;
  /** Whether pressing it creates a new application, as opposed to opening the existing one. */
  creates: boolean;
}

export function jobActionFor({ jobId, parsed, consent, applications }: JobActionInput): JobAction {
  const existing = applications.find((application) => String(application.jobId) === String(jobId));

  if (!existing) {
    // Without consent or parsed requirements the generation cannot start, so the button says
    // what it will do and refuses rather than failing after the press.
    return { label: 'Create tailored CV', disabled: !consent || !parsed, creates: true };
  }

  switch (String(existing.state)) {
    case 'generating':
      return { label: 'Generating...', disabled: true, creates: false };
    case 'in_review':
      return { label: 'Review and approve', disabled: false, creates: false };
    case 'approved':
      return { label: 'Review and download', disabled: false, creates: false };
    case 'sent':
      return { label: 'Open sent application', disabled: false, creates: false };
    case 'generation_failed':
      return { label: 'Open failed attempt', disabled: false, creates: false };
    default:
      return { label: 'Open application', disabled: false, creates: false };
  }
}
