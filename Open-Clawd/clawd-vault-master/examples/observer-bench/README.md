# Observer Memory Quality Benchmark

Parallel model comparison for ClawVault's observational memory pipeline.

## What This Tests

The observer compresses raw session transcripts into durable observations. But are those observations *useful*? This harness measures:

- **Precision** — How much noise? (routine confirmations, CLI errors, retries)
- **Recall** — Did it catch decisions, commitments, milestones, blockers?
- **Keyword preservation** — Can you search for the observation later? Or did the LLM rewrite key terms?
- **Type accuracy** — Are `[decision]` tags actually decisions? Are `[todo]` tags actionable?
- **Importance calibration** — Are i-scores meaningful? Do 0.80+ observations actually matter more?

## Running

```bash
# Prerequisites: Docker, claw CLI
claw up -f claw-pod.yml

# Results land in ./results/ with per-model JSON + comparison.md
```

## Fixtures

Each fixture in `fixtures/` contains:
- `transcript.md` — Raw session input
- `expected.md` — Annotated ground truth observations
- `config.json` — Optional observer config overrides

## Adding Fixtures

Best fixtures come from real sessions. Export a transcript, manually annotate what *should* have been observed, and save as a new fixture directory.

## Models Tested

| Service | Provider | Model | Cost Tier |
|---------|----------|-------|-----------|
| gemini-flash | Gemini | gemini-2.0-flash | $ |
| haiku | Anthropic | claude-3-5-haiku | $ |
| gpt4o-mini | OpenAI | gpt-4o-mini | $ |
| sonnet | Anthropic | claude-sonnet-4 | $$$ |
| ollama | Local | llama3.2 | Free |
