/**
 * BENCHMARK FIXTURE LOADER — schema and validation only, no network calls.
 *
 * Phase 8 (spec §8.2) requires the tailoring/validation workload run "on five real CVs".
 * Real, consented CV content must never be hardcoded or committed to this repository (see
 * `docs/evals/2026-08-28-phase-8-benchmark.md` for the consent requirement), so fixtures are
 * supplied at RUNTIME as external JSON files, in a directory the caller points at via
 * `CV_BENCHMARK_FIXTURES_DIR`. This module only knows how to read and validate that
 * directory's shape; it never contains a single real name, email, employer, or bullet.
 *
 * The shape deliberately mirrors `FactSnapshot` / `TailorPromptInput` (application.types.ts,
 * tailor.prompt.ts) rather than raw CV markdown: the benchmark measures the SAME tailoring
 * prompt the eval harness (`run-eval.ts`) and production `TailorService` use, so the input it
 * takes has to be facts + requirements, not free text a second extraction step would have to
 * turn into facts (extraction is its own LLM call with its own error surface — folding it in
 * would make a benchmark failure ambiguous between "extraction is bad" and "tailoring is
 * bad"). A fixture author derives this JSON from a real CV once, by hand or via the
 * existing `POST /api/master` → fact-extraction pipeline, entirely outside this repo.
 */
import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { FactSnapshot } from '../application.types';

export interface BenchmarkRequirement {
  text: string;
  kind: 'must' | 'nice';
}

export interface BenchmarkFixture {
  /** Filename (without extension) the fixture was loaded from — for traceability in
   * reports without ever printing CV content. */
  source: string;
  /** A human label for this fixture, e.g. "candidate-a". Never a real name (see the doc). */
  label: string;
  facts: FactSnapshot[];
  requirements: BenchmarkRequirement[];
  jobTitle: string | null;
  company: string | null;
  language: string;
  styleExemplars: string[];
}

const REQUIRED_FIXTURE_COUNT = 5;

function fail(file: string, reason: string): never {
  throw new Error(`benchmark fixture "${file}" is invalid: ${reason}`);
}

function isFactSnapshot(value: unknown, file: string, index: number): FactSnapshot {
  if (typeof value !== 'object' || value === null) {
    fail(file, `facts[${index}] is not an object`);
  }
  const fact = value as Record<string, unknown>;

  if (typeof fact.factId !== 'string' || !fact.factId.trim()) {
    fail(file, `facts[${index}].factId must be a non-empty string`);
  }
  if (typeof fact.text !== 'string' || !fact.text.trim()) {
    fail(file, `facts[${index}].text must be a non-empty string`);
  }
  if (typeof fact.kind !== 'string' || !fact.kind.trim()) {
    fail(file, `facts[${index}].kind must be a non-empty string`);
  }

  const optionalString = (key: string): string | null => {
    const raw = fact[key];
    if (raw === undefined || raw === null) return null;
    if (typeof raw !== 'string') fail(file, `facts[${index}].${key} must be a string or null`);
    return raw;
  };

  return {
    factId: fact.factId as string,
    text: fact.text as string,
    kind: fact.kind as string,
    section: optionalString('section'),
    title: optionalString('title'),
    org: optionalString('org'),
    period: optionalString('period'),
  };
}

function isRequirement(value: unknown, file: string, index: number): BenchmarkRequirement {
  if (typeof value !== 'object' || value === null) {
    fail(file, `requirements[${index}] is not an object`);
  }
  const requirement = value as Record<string, unknown>;

  if (typeof requirement.text !== 'string' || !requirement.text.trim()) {
    fail(file, `requirements[${index}].text must be a non-empty string`);
  }
  if (requirement.kind !== 'must' && requirement.kind !== 'nice') {
    fail(file, `requirements[${index}].kind must be "must" or "nice"`);
  }

  return { text: requirement.text as string, kind: requirement.kind };
}

/**
 * Parses and validates one fixture file's contents. Exported separately from the directory
 * loader so a single malformed fixture can be unit-tested without touching the filesystem.
 */
export function parseBenchmarkFixture(raw: string, file: string): BenchmarkFixture {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    fail(file, `not valid JSON: ${message}`);
  }

  if (typeof parsed !== 'object' || parsed === null) {
    fail(file, 'root value must be a JSON object');
  }
  const body = parsed as Record<string, unknown>;

  if (typeof body.label !== 'string' || !body.label.trim()) {
    fail(file, '"label" must be a non-empty string');
  }
  if (!Array.isArray(body.facts) || body.facts.length === 0) {
    fail(file, '"facts" must be a non-empty array');
  }
  if (!Array.isArray(body.requirements)) {
    fail(file, '"requirements" must be an array (may be empty)');
  }

  const facts = body.facts.map((f, i) => isFactSnapshot(f, file, i));
  const requirements = body.requirements.map((r, i) => isRequirement(r, file, i));

  const optionalString = (key: string): string | null => {
    const value = body[key];
    if (value === undefined || value === null) return null;
    if (typeof value !== 'string') fail(file, `"${key}" must be a string or null`);
    return value;
  };

  const styleExemplars = body.styleExemplars;
  if (styleExemplars !== undefined && !Array.isArray(styleExemplars)) {
    fail(file, '"styleExemplars" must be an array of strings when present');
  }

  return {
    source: file,
    label: body.label as string,
    facts,
    requirements,
    jobTitle: optionalString('jobTitle'),
    company: optionalString('company'),
    language: typeof body.language === 'string' && body.language.trim() ? body.language : 'en',
    styleExemplars: Array.isArray(styleExemplars) ? (styleExemplars as unknown[]).map((s) => String(s)) : [],
  };
}

/**
 * Loads every `*.json` file directly under `dir`, sorted by filename for a deterministic
 * run order, and requires EXACTLY `REQUIRED_FIXTURE_COUNT` of them — spec §8.2 calls for
 * five real CVs, not "up to five" or "at least five"; a benchmark run over a different
 * count is not the measurement the spec asked for and should fail loudly rather than
 * silently report a partial result.
 */
export function loadBenchmarkFixtures(dir: string, requiredCount = REQUIRED_FIXTURE_COUNT): BenchmarkFixture[] {
  let entries: string[];
  try {
    entries = readdirSync(dir).filter((name) => name.endsWith('.json')).sort();
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    throw new Error(`could not read CV_BENCHMARK_FIXTURES_DIR "${dir}": ${message}`);
  }

  if (entries.length !== requiredCount) {
    throw new Error(
      `expected exactly ${requiredCount} fixture files in "${dir}", found ${entries.length} ` +
        `(${entries.join(', ') || 'none'}); Phase 8 (spec §8.2) benchmarks five real CVs, ` +
        'not a placeholder count',
    );
  }

  return entries.map((name) => {
    const raw = readFileSync(join(dir, name), 'utf8');
    return parseBenchmarkFixture(raw, name);
  });
}
