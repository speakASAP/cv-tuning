/**
 * Removes direct candidate identifiers before text crosses the LLM boundary.
 * Rendering re-inserts the user's contact data locally; models only need the
 * professional facts and requirements to perform tailoring.
 */
export function pseudonymizePrompt(input: string): string {
  let output = input;

  output = output.replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[EMAIL]');
  output = output.replace(/(?:\+?\d[\d ()-]{7,}\d)/g, '[PHONE]');
  output = output.replace(
    /^(\s*(?:name|full name|address|street|city|postcode|postal code|phone|mobile|email)\s*:\s*).+$/gim,
    '$1[REDACTED]',
  );

  return output;
}
