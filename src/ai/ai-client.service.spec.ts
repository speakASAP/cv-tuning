import { AiClientService } from './ai-client.service';

const CHEAP_MODEL = 'openrouter/google/gemma-4-26b-a4b-it:free';
const SMART_MODEL = 'openrouter/google/gemma-4-31b-it:free';
const SMART_FALLBACK = 'openrouter/nvidia/nemotron-3-super-120b-a12b:free';
const OLLAMA_CODE_MODEL = 'ollama/qwen2.5-coder:0.5b';

describe('AiClientService', () => {
  let fetchMock: jest.Mock;
  let client: AiClientService;

  beforeEach(() => {
    fetchMock = jest.fn();
    client = new AiClientService('http://ai-microservice:3380', 'test-secret', fetchMock as unknown as typeof fetch);
  });

  it('returns the completion and the served model', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ text: 'hello', model_used: SMART_MODEL }),
    });

    const result = await client.complete({ tier: 'smart', systemPrompt: 's', userPrompt: 'x' });

    expect(result.text).toBe('hello');
    expect(result.modelUsed).toBe(SMART_MODEL);
    expect(result.degraded).toBe(false);
  });

  it('accepts the cheap tier being served by its own model', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({ text: 'hi', model_used: CHEAP_MODEL }) });

    expect((await client.complete({ tier: 'cheap', systemPrompt: 's', userPrompt: 'x' })).degraded).toBe(false);
  });

  it('marks a response degraded when a fallback model served it', async () => {
    // smart -> smart-fallback silently returns a different model with a well-formed
    // response. For prose generation that is a quality collapse, not a retry detail.
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ text: 'hello', model_used: SMART_FALLBACK }),
    });

    expect((await client.complete({ tier: 'smart', systemPrompt: 's', userPrompt: 'x' })).degraded).toBe(true);
  });

  it('marks degraded when the 0.5B code model served a prose request', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ text: 'hello', model_used: OLLAMA_CODE_MODEL }),
    });

    expect((await client.complete({ tier: 'smart', systemPrompt: 's', userPrompt: 'x' })).degraded).toBe(true);
  });

  it('marks degraded when ai-microservice reports model_resolved=false', async () => {
    // The exact response that blocked the Phase 3 eval baseline on 2026-08-23: the tier
    // name "smart" arrived in model_used because LiteLLM returned no model id. The
    // model_resolved flag is what makes that distinguishable from a real model.
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ text: 'hello', model_used: 'smart', tier_used: 'smart', model_resolved: false }),
    });

    expect((await client.complete({ tier: 'smart', systemPrompt: 's', userPrompt: 'x' })).degraded).toBe(true);
  });

  it('does not mark degraded when model_resolved=true and the model is expected', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ text: 'hello', model_used: SMART_MODEL, tier_used: 'smart', model_resolved: true }),
    });

    expect((await client.complete({ tier: 'smart', systemPrompt: 's', userPrompt: 'x' })).degraded).toBe(false);
  });

  it('marks degraded when a LiteLLM fallback served the call', async () => {
    // LiteLLM echoes the alias "smart" whether smart or smart-fallback answered, so the
    // served_by_fallback flag is the only signal that the model silently changed.
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        text: 'hello',
        model_used: SMART_FALLBACK,
        tier_used: 'smart',
        model_resolved: true,
        served_by_fallback: true,
      }),
    });

    expect((await client.complete({ tier: 'smart', systemPrompt: 's', userPrompt: 'x' })).degraded).toBe(true);
  });

  it('accepts a resolved expected model that was not a fallback', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        text: 'hello',
        model_used: SMART_MODEL,
        tier_used: 'smart',
        model_resolved: true,
        served_by_fallback: false,
      }),
    });

    const result = await client.complete({ tier: 'smart', systemPrompt: 's', userPrompt: 'x' });
    expect(result.degraded).toBe(false);
    expect(result.modelUsed).toBe(SMART_MODEL);
  });

  it('marks degraded when the served model is unknown', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({ text: 'hello' }) });

    expect((await client.complete({ tier: 'smart', systemPrompt: 's', userPrompt: 'x' })).degraded).toBe(true);
  });

  it('raises on an HTTP error with status and body in the message', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 503, text: async () => 'upstream down' });

    await expect(client.complete({ tier: 'cheap', systemPrompt: 's', userPrompt: 'x' })).rejects.toThrow(/503[\s\S]*upstream down/);
  });

  it('raises rather than returning empty text when the response has no text', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({ model_used: CHEAP_MODEL }) });

    await expect(client.complete({ tier: 'cheap', systemPrompt: 's', userPrompt: 'x' })).rejects.toThrow(/empty/i);
  });

  it('raises when the text is only whitespace', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ text: '   ', model_used: CHEAP_MODEL }),
    });

    await expect(client.complete({ tier: 'cheap', systemPrompt: 's', userPrompt: 'x' })).rejects.toThrow(/empty/i);
  });

  it('raises on a transport failure naming ai-microservice', async () => {
    fetchMock.mockRejectedValue(new Error('ECONNREFUSED'));

    await expect(client.complete({ tier: 'cheap', systemPrompt: 's', userPrompt: 'x' })).rejects.toThrow(/ai-microservice/);
  });

  it('requests the tier it was asked for', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({ text: 'x', model_used: SMART_MODEL }) });

    await client.complete({ tier: 'smart', systemPrompt: 'sys', userPrompt: 'the prompt' });

    const body = JSON.parse((fetchMock.mock.calls[0][1] as { body: string }).body);
    expect(body.model_tier).toBe('smart');
    expect(body.system_prompt).toBe('sys');
    expect(body.user_prompt).toBe('the prompt');
  });

  it('never uses the free tier, which is a code model unusable for prose', () => {
    // Compile-time guard made explicit: 'free' is not an accepted tier.
    expect(AiClientService.ALLOWED_TIERS).toEqual(['cheap', 'smart']);
  });

  it('sends a bearer token whose issuer is ai-microservice, as ServiceAuthGuard requires', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({ text: 'x', model_used: SMART_MODEL }) });

    await client.complete({ tier: 'smart', systemPrompt: 's', userPrompt: 'x' });

    const headers = (fetchMock.mock.calls[0][1] as { headers: Record<string, string> }).headers;
    const token = headers.authorization.replace('Bearer ', '');
    const claims = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString());
    expect(claims.iss).toBe('ai-microservice');
    expect(claims.serviceId).toBe('cv-tuning');
  });

  it('raises rather than calling unauthenticated when no secret is configured', async () => {
    const unconfigured = new AiClientService('http://ai:3380', '', fetchMock as unknown as typeof fetch);

    await expect(unconfigured.complete({ tier: 'cheap', systemPrompt: 's', userPrompt: 'x' })).rejects.toThrow(
      /JWT_SECRET/,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('raises on an error envelope even when the HTTP status is 200', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ error_code: 'AI_PROVIDER_ERROR', error_message: 'upstream refused' }),
    });

    await expect(client.complete({ tier: 'cheap', systemPrompt: 's', userPrompt: 'x' })).rejects.toThrow(
      /AI_PROVIDER_ERROR/,
    );
  });

  it('serialises the output schema into the prompt, since it never reaches the provider', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({ text: 'x', model_used: CHEAP_MODEL }) });

    await client.complete({
      tier: 'cheap',
      systemPrompt: 's',
      userPrompt: 'extract',
      outputSchema: { facts: 'array' },
    });

    const body = JSON.parse((fetchMock.mock.calls[0][1] as { body: string }).body);
    expect(body.user_prompt).toContain('facts');
    expect(body.output_schema).toEqual({ facts: 'array' });
  });
});
