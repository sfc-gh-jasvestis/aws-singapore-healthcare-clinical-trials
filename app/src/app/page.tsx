'use client';

import { useEffect, useState } from 'react';
import { AppLayout } from '@/components/AppLayout';
import { KPICard } from '@/components/KPICard';
import { Chart } from '@/components/Chart';
import { DataTable } from '@/components/DataTable';
import { AskAI } from '@/components/AskAI';
import { ActionMemo } from '@/components/ActionMemo';

interface TrialOpsData {
  platform: 'snowflake' | 'aws';
  kpiCards: { title: string; value: string }[];
  timeseries: { period: string; enrolled: number | null; signals: number | null; confirmed: number | null }[];
  categories: { category: string; signals: number | null; confirmed: number | null }[];
  entities: Record<string, string | number | null>[];
  monitoringRisk: { name: string; compliance: number; confirmed: number }[];
  sourceWatermark: string | null;
  rawWatermark: string | null;
  requestedAt: string;
  stale: boolean;
  pipelineBehind: boolean;
  risk: Record<string, string | number | null>[];
  holdout: { n: number | null; baseRate: number | null; precision: number | null; recall: number | null } | null;
  forecast: { period: string; value: number | null; lower: number | null; upper: number | null }[];
  live: Record<string, string | number | null>[];
  liveSummary: { n: number | null; alerts: number | null; lastLoaded: string | null; medianLagSeconds: number | null };
  anomalies: Record<string, string | number | null>[];
  alerts: Record<string, string | number | null>[];
}

const pct = (value: number | null) => (value === null ? 'n/a' : `${(value * 100).toFixed(0)}%`);

export default function HomePage() {
  const [data, setData] = useState<TrialOpsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    setData(null);
    fetch('/api/data', { cache: 'no-store', signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error('Data request failed');
        const payload = await response.json();
        if (!Array.isArray(payload.kpiCards) || !Array.isArray(payload.entities)) throw new Error('Invalid contract');
        return payload;
      })
      .then(setData)
      .catch(() => {
        if (!controller.signal.aborted) setError('Snowflake data is unavailable. No fallback values are displayed.');
      })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [attempt]);

  const isAws = (data?.platform ?? 'aws') === 'aws';
  const awsDiagram = { key: 'aws', title: 'AWS + Snowflake', src: '/architecture-aws.html' };
  const sfDiagram = { key: 'snowflake', title: 'Snowflake Only', src: '/architecture-snowflake.html' };
  const diagrams = isAws ? [awsDiagram, sfDiagram] : [sfDiagram, awsDiagram];
  const kpiVal = (title: string) => data?.kpiCards.find((card) => card.title === title)?.value ?? 'Unavailable';
  const executive = (
    <div className="space-y-6">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {['Enrollment vs Plan', 'Participants Enrolled', 'Screen Failure Rate', 'Important Deviations'].map((title) => (
          <KPICard key={title} title={title} value={kpiVal(title)} status="neutral" />
        ))}
      </div>
      <p className="text-sm text-slate-600">Enrollment vs plan = participants enrolled / planned enrollment for the 90-day window. Screen failure rate = screened but not enrolled / screened. An important deviation is a central-monitoring signal confirmed on review. Counts are site-level aggregates; there are no patient records.</p>
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Chart data={data?.timeseries ?? []} type="line" xKey="period"
          yKeys={[{ key: 'enrolled', name: 'Participants enrolled' }, { key: 'signals', name: 'Monitoring signals' }]} title="Daily Enrollment and Monitoring Signals" />
        <Chart data={data?.categories ?? []} type="bar" xKey="category"
          yKeys={[{ key: 'signals', name: 'Signals' }, { key: 'confirmed', name: 'Confirmed' }]} title="Signals and Important Deviations by Signal Type" />
      </div>
      <DataTable columns={[
        { key: 'id', header: 'Site' }, { key: 'region', header: 'Planning area' }, { key: 'category', header: 'Therapeutic area' },
        { key: 'enrolled', header: 'Enrolled' }, { key: 'target', header: 'Plan' }, { key: 'vsPlan', header: 'Vs plan (%)' },
        { key: 'screenFail', header: 'Screen failure (%)' }, { key: 'confirmed', header: 'Important deviations' }, { key: 'capas', header: 'CAPAs' },
      ]} data={data?.entities ?? []} title="Site observations" />
    </div>
  );
  const predictive = (
    <div className="space-y-4">
      <h2 className="font-semibold">7-day important-deviation risk and enrollment forecast</h2>
      <p className="text-sm text-slate-600">
        Snowflake ML classification predicts the probability that a site has a confirmed important protocol deviation in the next 7 days,
        from the data query rate, data-entry lag, recent confirmed deviations, monitoring tier, years active and therapeutic area.
        These are operational site-management scores, not clinical or safety predictions.
      </p>
      {data?.holdout ? (
        <p role="status" className="text-sm text-slate-700">
          Out-of-time holdout ({data.holdout.n} site-days): precision {pct(data.holdout.precision)} and recall{' '}
          {pct(data.holdout.recall)} at a 0.5 threshold, versus a {pct(data.holdout.baseRate)} base rate.
        </p>
      ) : (
        <p role="status">Model outputs are not deployed. Run snowflake/05_ml.sql.</p>
      )}
      <DataTable columns={[
        { key: 'id', header: 'Site' }, { key: 'band', header: 'Risk band' },
        { key: 'probability', header: 'P(important deviation in 7 days)' }, { key: 'scoredAsOf', header: 'Scored as of' },
      ]} data={data?.risk ?? []} title="Important-deviation risk by site" />
      <Chart data={data?.forecast ?? []} type="line" xKey="period"
        yKeys={[{ key: 'value', name: 'Forecast' }, { key: 'lower', name: 'Lower' }, { key: 'upper', name: 'Upper' }]}
        title="Network-wide enrollment forecast, next 14 days (participants per day)" />
      <DataTable columns={[
        { key: 'id', header: 'Site' }, { key: 'date', header: 'Date' }, { key: 'queryRate', header: 'Query rate (per 100 data points)' },
        { key: 'expected', header: 'Expected' }, { key: 'upper', header: 'Upper bound' },
      ]} data={data?.anomalies ?? []} title="Data query rate anomalies, last 15 days (Snowflake ML anomaly detection, trained on the prior 75 days)" />
    </div>
  );
  const liveTab = (
    <div className="space-y-4">
      <h2 className="font-semibold">{isAws ? 'Live visit records: Amazon Data Firehose to S3 to Snowpipe' : 'Live visit records: Snowflake-native simulator'}</h2>
      <p className="text-sm text-slate-600">
        {isAws
          ? 'Simulated site visit-record events are sent to the Firehose stream sg-healthcare-clinical-trials-visits (aws/publish_visits.py). Firehose writes batches to S3, and Snowpipe auto-ingest loads them into RAW.LIVE_VISITS.'
          : 'CALL APP.SIMULATE_VISITS(n) inserts simulated site visit-record events directly into RAW.LIVE_VISITS (or resume APP.TASK_SIMULATE_VISITS for a feed every minute). This simulates an EDC feed; it is not Snowpipe Streaming.'}
        {' '}Events carry no patient identifiers. The alert APP.LIVE_VISIT_ALERT logs ALERT events and emails the central monitoring team.
      </p>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <KPICard title="Visit records loaded" value={String(data?.liveSummary?.n ?? 'n/a')} />
        <KPICard title="ALERT events" value={String(data?.liveSummary?.alerts ?? 'n/a')} />
        <KPICard title={isAws ? 'Median send to table lag (s)' : 'Median generated to table lag (s)'} value={String(data?.liveSummary?.medianLagSeconds ?? 'n/a')} />
        <KPICard title="Last load" value={data?.liveSummary?.lastLoaded ?? 'none'} />
      </div>
      <DataTable columns={[
        { key: 'id', header: 'Site' }, { key: 'eventTs', header: 'Event (UTC)' }, { key: 'entryLag', header: 'Entry lag (h)' },
        { key: 'queryRate', header: 'Query rate (%)' }, { key: 'status', header: 'Status' }, { key: 'loadedAt', header: 'Loaded' },
      ]} data={data?.live ?? []} title="Latest 25 visit-record events" />
      <DataTable columns={[
        { key: 'id', header: 'Site' }, { key: 'eventTs', header: 'Event (UTC)' }, { key: 'entryLag', header: 'Entry lag (h)' },
        { key: 'queryRate', header: 'Query rate (%)' }, { key: 'hint', header: 'Action hint' },
      ]} data={data?.alerts ?? []} title="Alert log" />
    </div>
  );
  const planning = (
    <div className="space-y-6">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <KPICard title="Monitoring Visit Compliance" value={kpiVal('Monitoring Visit Compliance')} />
        <KPICard title="Essential Document Coverage" value={kpiVal('Essential Document Coverage')} />
        <KPICard title="Essential Documents Pending" value={kpiVal('Essential Documents Pending')} />
      </div>
      <Chart data={data?.monitoringRisk ?? []} type="scatter" xKey="compliance" xName="Monitoring visit compliance"
        yKeys={[{ key: 'confirmed', name: 'Important deviations' }]} yDomain={[0, 'auto']}
        title="Monitoring visit compliance (%) vs important deviations by site" />
      <p className="text-sm text-slate-600">Synthetic associations are not evidence that monitoring visits prevented deviations.</p>
      <ActionMemo persona={{ name: 'Joanne Koh', role: 'Head of Clinical Operations (fictional persona)' }} context={{}}
        onGenerate={async () => {
          const r = await fetch('/api/ask', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode: 'memo' }) });
          if (!r.ok) throw new Error('memo failed');
          const j = await r.json();
          return { subject: 'Draft site-management actions (synthetic data, human review required)', body: j.answer, urgency: 'review', actions: [] };
        }} />
      <p role="status" className="text-sm text-slate-600">{isAws ? 'Draft generated by Amazon Bedrock (Claude) through a Snowflake external-access function' : 'Draft generated by Snowflake Cortex AI_COMPLETE (Claude Sonnet 4.5)'}, from the KPI, site, signal-type and risk tables only. No notification is sent.</p>
    </div>
  );
  const ai = (
    <div className="space-y-4">
      <p role="status">Answers come from the Cortex Agent APP.TRIAL_OPS_AGENT. It uses Cortex Analyst over the semantic view APP.TRIAL_OPS_ANALYTICS for metrics, and Cortex Search over synthetic site-management SOPs for procedures. The generated SQL is shown with each answer.</p>
      <div className="h-[500px]">
        <AskAI title="Ask the site operations agent" mode="advisor" sampleQuestions={['Which 3 sites have the most important deviations?', 'Which sites are high risk this week and what SOP applies?', 'What is enrollment vs plan by planning area?']}
          onSubmit={async (question) => {
            const r = await fetch('/api/agent', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ question }) });
            if (!r.ok) throw new Error('agent failed');
            const j = await r.json();
            const cites = j.sops?.length ? `\n\nSOPs: ${j.sops.join(', ')}` : '';
            return { answer: `${j.answer}${cites}`, sql: j.sql ?? undefined };
          }} />
      </div>
    </div>
  );
  const architecture = (
    <div className="space-y-4">
      {diagrams.map((d, i) => (
        <div key={d.key} className="space-y-2">
          <h2 className="font-semibold">Architecture: {d.title}{i === 0 ? ' (this deployment)' : ''}</h2>
          <iframe src={d.src} title={`${d.title} architecture diagram`} className="h-[620px] w-full rounded border border-slate-200" />
          <p className="text-sm text-slate-600">Hover a component for details. <a className="underline" href={d.src} target="_blank" rel="noreferrer">Open full screen</a></p>
        </div>
      ))}
      <h2 className="font-semibold">Implementation status</h2>
      <p>Core source: synthetic trial sites, daily site-level observations and essential documents. There are no patient records. Curated dynamic tables compute numerator/denominator metrics and are suspended after on-demand initialization.</p>
      <p>Application: Next.js server queries the explicit curated contract. Request time and source observation watermark are separate.</p>
      <p>ML: SNOWFLAKE.ML.CLASSIFICATION important-deviation risk model evaluated on a time-based holdout, plus a 14-day enrollment FORECAST with prediction intervals.</p>
      <p>ML: ANOMALY_DETECTION flags data query rate outliers per site over the last 15 days.</p>
      <p>AI: Cortex Agent (Cortex Analyst over a semantic view, plus Cortex Search over SOPs) answers questions. The action memo uses {isAws ? 'Amazon Bedrock Claude through an external-access UDF' : 'Cortex AI_COMPLETE (Claude Sonnet 4.5)'}.</p>
      {isAws ? (
        <>
          <p>AWS ingestion: Amazon Data Firehose to S3 to Snowpipe auto-ingest (SQS) into RAW.LIVE_VISITS, with a Snowflake alert and email on ALERT events.</p>
          <p>QuickSight: Snowflake DIRECT_QUERY dashboard (daily enrollment and signals, important deviations by site, deviation risk) through a PAT-only service user, with a Q topic.</p>
        </>
      ) : (
        <>
          <p>Ingestion: APP.SIMULATE_VISITS inserts simulated visit-record events into RAW.LIVE_VISITS, with a Snowflake alert and email on ALERT events. No AWS account is used.</p>
          <p>BI: this SPCS app is the dashboard; natural-language questions go to the Cortex Agent.</p>
        </>
      )}
      <p>Orchestration: the task graph APP.TASK_REFRESH_CURATED, then TASK_RESCORE_RISK, runs on demand. Alerts and tasks stay suspended between demos.</p>
    </div>
  );
  const tabs = [
    { id: 'executive-cockpit', label: 'Executive Cockpit', icon: '', content: executive },
    { id: 'predictive', label: 'Predictive', icon: '', content: predictive },
    { id: 'planning', label: 'Site Monitoring', icon: '', content: planning },
    { id: 'live', label: 'Live Visits', icon: '', content: liveTab },
    { id: 'ask-ai', label: 'Ask AI', icon: '', content: ai },
    { id: 'architecture', label: 'Architecture & Data', icon: '', content: architecture },
  ].map((tab) => ({ ...tab, content: tab.id === 'architecture' ? tab.content : (
    <div className="space-y-4">
      <p className="text-sm text-slate-600">Synthetic demo data for 40 trial sites of a fictional Singapore contract research organisation: site-level counts only, no patient data and no clinical outcomes. On-demand snapshots are not live trial operations.</p>
      {loading ? <p role="status">Loading Snowflake data...</p> : error ? (
        <div role="alert" className="rounded border border-red-200 p-4">
          <p>{error}</p>
          <button className="mt-3 rounded border px-3 py-2" onClick={() => setAttempt((value) => value + 1)}>Retry data connection</button>
        </div>
      ) : !data?.entities.length ? <p role="status">No site observations are available in this snapshot.</p> : (
        <>
          <p className="text-sm">Observation watermark: {data.sourceWatermark ?? 'Unavailable'}. Request time: {data.requestedAt}.</p>
          {(data.stale || data.pipelineBehind) && <p role="status" className="text-amber-700">Stale or lagging snapshot. Refresh the on-demand pipeline before presenting current results.</p>}
          {tab.content}
        </>
      )}
    </div>
  ) }));
  return <AppLayout title="Singapore Clinical Trial Site Operations" tabs={tabs} />;
}
