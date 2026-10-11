import { NextResponse } from 'next/server';
import { demoPlatform } from '@/lib/platform';
import { executeQuery } from '@/lib/snowflake';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function GET() {
  try {
    const [kpis, trend, signals, sites, freshness, risk, holdout, forecast, live, liveSummary, anomalies, alerts] = await Promise.all([
      executeQuery<{ TITLE: string; DISPLAY: string; STATUS: string }>(
        'SELECT TITLE, DISPLAY, STATUS FROM CURATED.KPI_SUMMARY ORDER BY SORT_ORDER'),
      executeQuery<{ PERIOD: string; ENROLLED: number | null; SIGNALS: number | null; CONFIRMED: number | null }>(`
        SELECT TO_CHAR(METRIC_DATE, 'YYYY-MM-DD') AS PERIOD,
               ENROLLED_COUNT AS ENROLLED, SIGNAL_COUNT AS SIGNALS, CONFIRMED_COUNT AS CONFIRMED
        FROM CURATED.TREND_ANALYSIS ORDER BY METRIC_DATE`),
      executeQuery<{ SIGNAL: string; SIGNALS: number; CONFIRMED: number }>(`
        SELECT SIGNAL_TYPE AS SIGNAL, SIGNAL_COUNT AS SIGNALS, CONFIRMED_COUNT AS CONFIRMED
        FROM CURATED.SIGNAL_SUMMARY ORDER BY CONFIRMED_COUNT DESC, SIGNAL_COUNT DESC`),
      executeQuery<Record<string, string | number | null>>(`
        SELECT ENTITY_ID, ENTITY_NAME, REGION, CATEGORY, MONITORING_TIER, EVENT_COUNT, ENROLLED_COUNT, ENROLLMENT_TARGET_90D,
               ENROLLMENT_VS_PLAN_PCT, SCREEN_FAILURE_PCT, SIGNAL_COUNT, CONFIRMED_COUNT, CAPA_COUNT, MONITORING_COMPLIANCE_PCT
        FROM CURATED.PERFORMANCE_SUMMARY ORDER BY ENTITY_ID LIMIT 200`),
      executeQuery<{ RAW_WATERMARK: string | null; CURATED_WATERMARK: string | null }>(`
        SELECT (SELECT TO_CHAR(MAX(EVENT_DATE), 'YYYY-MM-DD') FROM RAW.SITE_DAILY) AS RAW_WATERMARK,
               (SELECT TO_CHAR(MAX(METRIC_DATE), 'YYYY-MM-DD') FROM CURATED.TREND_ANALYSIS) AS CURATED_WATERMARK`),
      executeQuery<Record<string, string | number | null>>(`
        SELECT ENTITY_ID, TO_CHAR(SCORED_AS_OF, 'YYYY-MM-DD') AS SCORED_AS_OF, DEVIATION_PROB_7D, RISK_BAND
        FROM ML.DEVIATION_RISK_SCORES ORDER BY DEVIATION_PROB_7D DESC`),
      executeQuery<Record<string, string | number | null>>(
        'SELECT N, BASE_RATE, PRECISION_AT_50, RECALL_AT_50 FROM ML.DEVIATION_RISK_HOLDOUT_METRICS'),
      executeQuery<Record<string, string | number | null>>(`
        SELECT TO_CHAR(FORECAST_DATE, 'YYYY-MM-DD') AS PERIOD, ENROLLED_COUNT, LOWER_BOUND, UPPER_BOUND
        FROM ML.ENROLLMENT_FORECAST ORDER BY FORECAST_DATE`),
      executeQuery<Record<string, string | number | null>>(`
        SELECT SITE_ID, TO_CHAR(EVENT_TS, 'YYYY-MM-DD HH24:MI:SS') AS EVENT_TS, ROUND(ENTRY_LAG_HOURS, 1) AS ENTRY_LAG_HOURS,
               QUERY_RATE_PCT, STATUS, TO_CHAR(LOADED_AT, 'YYYY-MM-DD HH24:MI:SS TZH:TZM') AS LOADED_AT
        FROM RAW.LIVE_VISITS ORDER BY EVENT_TS DESC LIMIT 25`),
      executeQuery<Record<string, string | number | null>>(`
        SELECT COUNT(*) AS N, COUNT_IF(STATUS = 'ALERT') AS ALERTS,
               TO_CHAR(MAX(LOADED_AT), 'YYYY-MM-DD HH24:MI:SS TZH:TZM') AS LAST_LOADED,
               ROUND(MEDIAN(DATEDIFF('second', SENT_TS, CONVERT_TIMEZONE('UTC', LOADED_AT)::TIMESTAMP_NTZ)), 0) AS MEDIAN_LAG_S
        FROM RAW.LIVE_VISITS`),
      executeQuery<Record<string, string | number | null>>(`
        SELECT ENTITY_ID, TO_CHAR(EVENT_DATE, 'YYYY-MM-DD') AS EVENT_DATE, ROUND(QUERY_RATE, 2) AS QUERY_RATE,
               ROUND(EXPECTED, 2) AS EXPECTED, ROUND(UPPER_BOUND, 2) AS UPPER_BOUND
        FROM ML.QUERY_RATE_ANOMALIES WHERE IS_ANOMALY ORDER BY EVENT_DATE DESC, ENTITY_ID LIMIT 50`),
      executeQuery<Record<string, string | number | null>>(`
        SELECT SITE_ID, TO_CHAR(EVENT_TS, 'YYYY-MM-DD HH24:MI:SS') AS EVENT_TS, ROUND(ENTRY_LAG_HOURS, 1) AS ENTRY_LAG_HOURS,
               QUERY_RATE_PCT, SOP_HINT
        FROM APP.ALERT_LOG ORDER BY ALERTED_AT DESC, EVENT_TS DESC LIMIT 25`),
    ]);
    const numberOrNull = (value: unknown): number | null => {
      if (value === null || value === undefined) return null;
      const numeric = Number(value);
      if (!Number.isFinite(numeric)) throw new Error('Non-numeric measure in curated contract');
      return numeric;
    };
    const watermark = freshness[0]?.CURATED_WATERMARK ?? null;
    const ageDays = watermark ? (Date.now() - Date.parse(`${watermark}T00:00:00Z`)) / 86400000 : null;
    return NextResponse.json({
      platform: demoPlatform(),
      kpiCards: kpis.map((row) => ({ title: row.TITLE, value: row.DISPLAY, status: row.STATUS })),
      timeseries: trend.map((row) => ({
        period: row.PERIOD, enrolled: numberOrNull(row.ENROLLED), signals: numberOrNull(row.SIGNALS), confirmed: numberOrNull(row.CONFIRMED),
      })),
      categories: signals.map((row) => ({ category: row.SIGNAL, signals: numberOrNull(row.SIGNALS), confirmed: numberOrNull(row.CONFIRMED) })),
      entities: sites.map((row) => ({
        id: row.ENTITY_ID, name: row.ENTITY_NAME, region: row.REGION, category: row.CATEGORY, tier: row.MONITORING_TIER,
        enrolled: numberOrNull(row.ENROLLED_COUNT), target: numberOrNull(row.ENROLLMENT_TARGET_90D),
        vsPlan: numberOrNull(row.ENROLLMENT_VS_PLAN_PCT), screenFail: numberOrNull(row.SCREEN_FAILURE_PCT),
        signals: numberOrNull(row.SIGNAL_COUNT), confirmed: numberOrNull(row.CONFIRMED_COUNT), capas: numberOrNull(row.CAPA_COUNT),
        monitoring: numberOrNull(row.MONITORING_COMPLIANCE_PCT), events: numberOrNull(row.EVENT_COUNT),
      })),
      monitoringRisk: sites.map((row) => ({
        name: row.ENTITY_NAME, compliance: numberOrNull(row.MONITORING_COMPLIANCE_PCT), confirmed: numberOrNull(row.CONFIRMED_COUNT),
      })).filter((row) => row.compliance !== null && row.confirmed !== null),
      sourceWatermark: watermark,
      rawWatermark: freshness[0]?.RAW_WATERMARK ?? null,
      stale: ageDays === null || ageDays > 2,
      pipelineBehind: freshness[0]?.RAW_WATERMARK !== watermark,
      requestedAt: new Date().toISOString(),
      synthetic: true,
      risk: risk.map((row) => ({
        id: row.ENTITY_ID, scoredAsOf: row.SCORED_AS_OF,
        probability: numberOrNull(row.DEVIATION_PROB_7D), band: row.RISK_BAND,
      })),
      holdout: holdout[0] ? {
        n: numberOrNull(holdout[0].N), baseRate: numberOrNull(holdout[0].BASE_RATE),
        precision: numberOrNull(holdout[0].PRECISION_AT_50), recall: numberOrNull(holdout[0].RECALL_AT_50),
      } : null,
      forecast: forecast.map((row) => ({
        period: row.PERIOD, value: numberOrNull(row.ENROLLED_COUNT),
        lower: numberOrNull(row.LOWER_BOUND), upper: numberOrNull(row.UPPER_BOUND),
      })),
      modelStatus: holdout[0] ? 'holdout_evaluated' : 'missing',
      live: live.map((row) => ({
        id: row.SITE_ID, eventTs: row.EVENT_TS, entryLag: numberOrNull(row.ENTRY_LAG_HOURS),
        queryRate: numberOrNull(row.QUERY_RATE_PCT), status: row.STATUS, loadedAt: row.LOADED_AT,
      })),
      liveSummary: {
        n: numberOrNull(liveSummary[0]?.N), alerts: numberOrNull(liveSummary[0]?.ALERTS),
        lastLoaded: liveSummary[0]?.LAST_LOADED ?? null, medianLagSeconds: numberOrNull(liveSummary[0]?.MEDIAN_LAG_S),
      },
      anomalies: anomalies.map((row) => ({
        id: row.ENTITY_ID, date: row.EVENT_DATE, queryRate: numberOrNull(row.QUERY_RATE),
        expected: numberOrNull(row.EXPECTED), upper: numberOrNull(row.UPPER_BOUND),
      })),
      alerts: alerts.map((row) => ({
        id: row.SITE_ID, eventTs: row.EVENT_TS, entryLag: numberOrNull(row.ENTRY_LAG_HOURS),
        queryRate: numberOrNull(row.QUERY_RATE_PCT), hint: row.SOP_HINT,
      })),
    }, { headers: { 'Cache-Control': 'no-store' } });
  } catch {
    return NextResponse.json({ error: 'Site operations data is unavailable. Verify the core deployment and application role.' },
      { status: 503, headers: { 'Cache-Control': 'no-store' } });
  }
}
