import { NextResponse } from 'next/server';
import { executeQuery } from '@/lib/snowflake';
import { demoPlatform } from '@/lib/platform';

export const dynamic = 'force-dynamic';

// Only these fixed, read-only queries can run. The model never writes SQL; it
// only summarises rows returned here, so every answer is traceable to data.
const INTENTS: Record<string, { match: RegExp; sql: string }> = {
  sites: {
    match: /deviation|site|worst|highest|enrol|behind|plan|capa/i,
    sql: `SELECT ENTITY_ID, ENTITY_NAME, REGION, CATEGORY, ENROLLED_COUNT, ENROLLMENT_TARGET_90D, ROUND(ENROLLMENT_VS_PLAN_PCT, 1) AS ENROLLMENT_VS_PLAN_PCT,
       SIGNAL_COUNT, CONFIRMED_COUNT, CAPA_COUNT, ROUND(MONITORING_COMPLIANCE_PCT, 1) AS MONITORING_COMPLIANCE_PCT
FROM CURATED.PERFORMANCE_SUMMARY
QUALIFY DENSE_RANK() OVER (ORDER BY CONFIRMED_COUNT DESC) <= 3
ORDER BY CONFIRMED_COUNT DESC, SIGNAL_COUNT DESC`,
  },
  signals: {
    match: /signal|category|type|why|kri/i,
    sql: `SELECT SIGNAL_TYPE, SIGNAL_COUNT, CONFIRMED_COUNT, CAPA_COUNT, SITES_AFFECTED, ROUND(SIGNAL_CONFIRMATION_PCT, 1) AS SIGNAL_CONFIRMATION_PCT
FROM CURATED.SIGNAL_SUMMARY ORDER BY CONFIRMED_COUNT DESC LIMIT 7`,
  },
  kpis: {
    match: /.*/,
    sql: `SELECT TITLE, DISPLAY, SOURCE_WATERMARK FROM CURATED.KPI_SUMMARY ORDER BY SORT_ORDER`,
  },
};

const DEFINITIONS =
  'Enrollment vs plan = participants enrolled / planned enrollment for the 90-day window. ' +
  'Signal confirmation rate = central-monitoring signals confirmed as important protocol deviations / signals raised. ' +
  'A CAPA is a corrective and preventive action opened after a confirmed deviation. ' +
  'Area EDC outage signals hit every site in a Singapore planning area at once and are never confirmed. ' +
  'All data is synthetic, site-level demo data with no patient records. Do not give medical or clinical advice.';

// provider 'cortex' = Snowflake AI_COMPLETE; 'bedrock' = Amazon Bedrock Claude
// via the external-access UDF APP.BEDROCK_GENERATE (aws/setup_aws.py).
async function summarise(question: string, rows: unknown[], provider: 'cortex' | 'bedrock' = 'cortex'): Promise<string> {
  const prompt =
    'You are a clinical trial operations analyst at a fictional Singapore contract research organisation. Answer ONLY from the JSON rows and definitions below. ' +
    'If the rows do not answer the question, say so. Do not invent numbers. Keep it under 120 words.\n' +
    `Definitions: ${DEFINITIONS}\nRows: ${JSON.stringify(rows)}\nQuestion: ${question}`;
  const out = await executeQuery<{ R: string }>(
    provider === 'bedrock' ? 'SELECT APP.BEDROCK_GENERATE(?) AS R' : `SELECT AI_COMPLETE('claude-sonnet-4-5', ?) AS R`,
    [prompt],
  );
  const raw = String(out[0]?.R ?? '').trim();
  // AI_COMPLETE returns a JSON string literal; decode it when present.
  try {
    const parsed = JSON.parse(raw);
    return typeof parsed === 'string' ? parsed : raw;
  } catch {
    return raw;
  }
}

export async function POST(req: Request) {
  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }
  const question = typeof body?.question === 'string' ? body.question.trim().slice(0, 2000) : '';
  const memo = body?.mode === 'memo';
  if (!memo && !question) return NextResponse.json({ error: 'Question required' }, { status: 400 });

  try {
    if (memo) {
      const provider = demoPlatform() === 'aws' ? 'bedrock' : 'cortex';
      const [kpis, sites, signals, risk, bands] = await Promise.all([
        executeQuery(INTENTS.kpis.sql),
        executeQuery(INTENTS.sites.sql),
        executeQuery(INTENTS.signals.sql),
        executeQuery(`SELECT ENTITY_ID, ROUND(DEVIATION_PROB_7D, 2) AS DEVIATION_PROB_7D, RISK_BAND
FROM ML.DEVIATION_RISK_SCORES ORDER BY DEVIATION_PROB_7D DESC LIMIT 5`),
        executeQuery(`SELECT RISK_BAND, COUNT(*) AS SITES FROM ML.DEVIATION_RISK_SCORES GROUP BY RISK_BAND`),
      ]);
      const rows = { kpis, topDeviationSites: sites, signalTypes: signals, top5ByRisk: risk, sitesPerRiskBand: bands };
      const answer = await summarise(
        'Draft a short operational action memo for the Head of Clinical Operations with 3 prioritised site-management actions, citing the figures.',
        [rows],
        provider,
      );
      return NextResponse.json({ answer, sources: rows, provider: provider === 'bedrock' ? 'Amazon Bedrock (Claude Sonnet 4.5)' : 'Snowflake Cortex AI_COMPLETE (claude-sonnet-4-5)', draft: true, synthetic: true });
    }
    const key = Object.keys(INTENTS).find((k) => INTENTS[k].match.test(question))!;
    const rows = await executeQuery(INTENTS[key].sql);
    const answer = await summarise(question, rows);
    return NextResponse.json({ answer, sql: INTENTS[key].sql, sources: rows, synthetic: true });
  } catch (err) {
    console.error('ask route failed', err);
    return NextResponse.json({ error: 'AI service unavailable' }, { status: 503 });
  }
}
