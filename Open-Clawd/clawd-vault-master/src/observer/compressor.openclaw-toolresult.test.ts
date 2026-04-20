import { afterEach, describe, expect, it } from 'vitest';
import { Compressor } from './compressor.js';

const originalAnthropic = process.env.ANTHROPIC_API_KEY;
const originalOpenAI = process.env.OPENAI_API_KEY;
const originalGemini = process.env.GEMINI_API_KEY;
const originalNoLlm = process.env.CLAWVAULT_NO_LLM;

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}

afterEach(() => {
  restoreEnv('ANTHROPIC_API_KEY', originalAnthropic);
  restoreEnv('OPENAI_API_KEY', originalOpenAI);
  restoreEnv('GEMINI_API_KEY', originalGemini);
  restoreEnv('CLAWVAULT_NO_LLM', originalNoLlm);
});

describe('Compressor (OpenClaw toolresult noise)', () => {
  it('drops toolresult:-prefixed structured payloads in fallback mode (OpenClaw transcripts)', async () => {
    process.env.ANTHROPIC_API_KEY = '';
    process.env.OPENAI_API_KEY = '';
    process.env.GEMINI_API_KEY = '';
    process.env.CLAWVAULT_NO_LLM = ''; // allow fallback

    const compressor = new Compressor({
      now: () => new Date('2026-03-05T12:00:00.000Z')
    });

    const output = await compressor.compress(
      [
        // Typical OpenClaw tool plumbing line (not a role)
        'toolresult: {"status":"error","tool":"exec","error":"EACCES: permission denied"}',
        'assistant: We should follow official documentation by default.',
        'user: OK'
      ],
      ''
    );

    expect(output).toContain('follow official documentation');
    expect(output).not.toContain('toolresult:');
    expect(output).not.toContain('EACCES: permission denied');
  });
});
