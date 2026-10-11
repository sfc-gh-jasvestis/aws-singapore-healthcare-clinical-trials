-- ============================================================================
-- 06_INTELLIGENCE.SQL - search, anomaly detection, semantic view, agent,
-- live visit-record alert and on-demand refresh DAG.
-- Run with snowflake/run_intelligence.py (substitutes validated __DEMO_DB__ /
-- __DEMO_WH__ / __ALERT_EMAIL__). Requires 00-05, plus 08 (Snowflake only) or
-- aws/setup_aws.py (AWS build) for RAW.LIVE_VISITS.
-- Alerts and tasks are created SUSPENDED; run them with EXECUTE ALERT / EXECUTE TASK.
-- ============================================================================
USE DATABASE __DEMO_DB__;
CREATE SCHEMA IF NOT EXISTS SEARCH;
CREATE SCHEMA IF NOT EXISTS APP;

-- ---------- Synthetic site-management knowledge base (clearly synthetic SOPs) ----------
CREATE OR REPLACE TABLE SEARCH.SITE_SOP_DOCS AS
WITH signals AS (
  SELECT DISTINCT r.SIGNAL_TYPE, s.CATEGORY
  FROM RAW.SITE_DAILY r JOIN RAW.SITES s ON s.ID = r.ENTITY_ID
  WHERE r.CONFIRMED_COUNT > 0
)
SELECT
  'SOP-' || LPAD(ROW_NUMBER() OVER (ORDER BY CATEGORY, SIGNAL_TYPE)::VARCHAR, 3, '0') AS DOC_ID,
  'SOP' AS DOC_TYPE,
  CATEGORY,
  SIGNAL_TYPE,
  CATEGORY || ' - ' || SIGNAL_TYPE || ' deviation follow-up' AS TITLE,
  'Synthetic demo SOP for site operations; not clinical or regulatory guidance. Therapeutic area: ' || CATEGORY
  || '. Monitoring signal: ' || SIGNAL_TYPE || '. '
  || 'Step 1: log the signal in the site issue tracker and notify the assigned clinical research associate within 2 business days. '
  || 'Step 2: ' || CASE
       WHEN SIGNAL_TYPE = 'Visit window' THEN 'list visits completed outside the protocol window over the last 30 days and check the site scheduling process and reminder calls.'
       WHEN SIGNAL_TYPE = 'Eligibility criteria' THEN 'compare the eligibility checklist with source documents for recently enrolled participants and confirm investigator sign-off before enrollment.'
       WHEN SIGNAL_TYPE = 'Informed consent' THEN 'check that the current approved consent version was used and that signatures and dates are complete for every participant consented in the window.'
       WHEN SIGNAL_TYPE = 'IP handling' THEN 'reconcile the investigational product accountability log against dispensing records and temperature logs for the window.'
       WHEN SIGNAL_TYPE = 'Lab sample handling' THEN 'review sample collection, processing and shipment times against the laboratory manual and confirm courier records.'
       ELSE 'review the flagged records against the site profile and escalate if unexplained.'
     END
  || ' Step 3: if the data query rate stays above 6 per 100 data points or data entry lags more than 5 days after follow-up, schedule an on-site or remote monitoring visit. '
  || 'Step 4: record the root cause; if the deviation is confirmed as important, open a corrective and preventive action (CAPA) for the clinical operations lead to approve.' AS CONTENT
FROM signals;

CREATE OR REPLACE CORTEX SEARCH SERVICE SEARCH.SITE_SOP_SEARCH
  ON CONTENT
  ATTRIBUTES CATEGORY, SIGNAL_TYPE
  WAREHOUSE = __DEMO_WH__
  TARGET_LAG = '7 days'
AS (SELECT DOC_ID, TITLE, CATEGORY, SIGNAL_TYPE, CONTENT FROM SEARCH.SITE_SOP_DOCS);

-- ---------- Data query rate anomaly detection (train first 75 days, detect last 15) ----------
CREATE OR REPLACE VIEW ML.QUERY_RATE_SERIES AS
SELECT ENTITY_ID, EVENT_DATE::TIMESTAMP_NTZ AS TS, QUERY_RATE_PCT::FLOAT AS QUERY_RATE
FROM RAW.SITE_DAILY;
CREATE OR REPLACE VIEW ML.QUERY_RATE_TRAIN AS
SELECT * FROM ML.QUERY_RATE_SERIES WHERE TS < (SELECT DATEADD(day, -15, MAX(TS)) FROM ML.QUERY_RATE_SERIES);
CREATE OR REPLACE VIEW ML.QUERY_RATE_DETECT AS
SELECT * FROM ML.QUERY_RATE_SERIES WHERE TS >= (SELECT DATEADD(day, -15, MAX(TS)) FROM ML.QUERY_RATE_SERIES);

CREATE OR REPLACE SNOWFLAKE.ML.ANOMALY_DETECTION ML.QUERY_RATE_ANOMALY_MODEL(
  INPUT_DATA => SYSTEM$REFERENCE('VIEW', 'ML.QUERY_RATE_TRAIN'),
  SERIES_COLNAME => 'ENTITY_ID', TIMESTAMP_COLNAME => 'TS', TARGET_COLNAME => 'QUERY_RATE',
  LABEL_COLNAME => '');

CREATE OR REPLACE TABLE ML.QUERY_RATE_ANOMALIES AS
SELECT SERIES::VARCHAR AS ENTITY_ID, TS::DATE AS EVENT_DATE, Y AS QUERY_RATE, FORECAST AS EXPECTED,
       LOWER_BOUND, UPPER_BOUND, IS_ANOMALY, PERCENTILE
FROM TABLE(ML.QUERY_RATE_ANOMALY_MODEL!DETECT_ANOMALIES(
  INPUT_DATA => SYSTEM$REFERENCE('VIEW', 'ML.QUERY_RATE_DETECT'),
  SERIES_COLNAME => 'ENTITY_ID', TIMESTAMP_COLNAME => 'TS', TARGET_COLNAME => 'QUERY_RATE'));

-- ---------- Semantic view ----------
CREATE OR REPLACE SEMANTIC VIEW APP.TRIAL_OPS_ANALYTICS
  TABLES (
    sites AS CURATED.PERFORMANCE_SUMMARY PRIMARY KEY (ENTITY_ID)
      COMMENT = 'One row per trial site, 90-day totals',
    risk AS ML.DEVIATION_RISK_SCORES PRIMARY KEY (ENTITY_ID)
      COMMENT = 'Latest next-7-day important-deviation probability per site',
    signals AS CURATED.SIGNAL_SUMMARY PRIMARY KEY (SIGNAL_TYPE)
      COMMENT = 'Monitoring signals, confirmed important deviations and CAPAs by signal type, 90 days',
    daily AS CURATED.TREND_ANALYSIS PRIMARY KEY (METRIC_DATE)
      COMMENT = 'Portfolio-wide totals per day'
  )
  RELATIONSHIPS (risk_site AS risk (ENTITY_ID) REFERENCES sites)
  FACTS (
    sites.screened_f AS SCREENED_COUNT,
    sites.enrolled_f AS ENROLLED_COUNT,
    sites.target_f AS ENROLLMENT_TARGET_90D,
    sites.signals_f AS SIGNAL_COUNT,
    sites.confirmed_f AS CONFIRMED_COUNT,
    sites.capas_f AS CAPA_COUNT,
    sites.visits_due_f AS MONITORING_DUE,
    sites.visits_done_f AS MONITORING_COMPLETED,
    risk.deviation_prob_f AS DEVIATION_PROB_7D,
    signals.type_signals_f AS SIGNAL_COUNT,
    signals.type_confirmed_f AS CONFIRMED_COUNT,
    signals.type_capas_f AS CAPA_COUNT,
    daily.day_screened_f AS SCREENED_COUNT,
    daily.day_enrolled_f AS ENROLLED_COUNT,
    daily.day_signals_f AS SIGNAL_COUNT
  )
  DIMENSIONS (
    sites.site_id AS ENTITY_ID WITH SYNONYMS = ('site', 'site number'),
    sites.site_name AS ENTITY_NAME,
    sites.planning_area AS REGION WITH SYNONYMS = ('planning area', 'area', 'district', 'region') COMMENT = 'Singapore planning area where the site is located',
    sites.therapeutic_area AS CATEGORY WITH SYNONYMS = ('therapeutic area', 'indication area', 'TA'),
    sites.monitoring_tier AS MONITORING_TIER COMMENT = 'Risk-based monitoring tier 1 (low) to 3 (high)',
    risk.risk_band AS RISK_BAND COMMENT = 'High >= 0.5, Medium >= 0.25, else Low',
    risk.scored_as_of AS SCORED_AS_OF,
    signals.signal_type AS SIGNAL_TYPE WITH SYNONYMS = ('signal', 'deviation category', 'key risk indicator'),
    daily.metric_date AS METRIC_DATE
  )
  METRICS (
    sites.total_enrolled AS SUM(sites.enrolled_f) WITH SYNONYMS = ('enrollment', 'participants enrolled', 'randomized'),
    sites.total_screened AS SUM(sites.screened_f) WITH SYNONYMS = ('screened', 'participants screened'),
    sites.enrollment_vs_plan_pct AS 100 * SUM(sites.enrolled_f) / NULLIF(SUM(sites.target_f), 0)
      COMMENT = 'Participants enrolled / planned enrollment for the 90-day window',
    sites.screen_failure_pct AS 100 * (SUM(sites.screened_f) - SUM(sites.enrolled_f)) / NULLIF(SUM(sites.screened_f), 0)
      COMMENT = 'Screened but not enrolled / screened',
    sites.signal_confirmation_pct AS 100 * SUM(sites.confirmed_f) / NULLIF(SUM(sites.signals_f), 0)
      COMMENT = 'Confirmed important deviations / monitoring signals raised',
    sites.monitoring_signals AS SUM(sites.signals_f) WITH SYNONYMS = ('signals', 'flags'),
    sites.important_deviations AS SUM(sites.confirmed_f) WITH SYNONYMS = ('confirmed deviations', 'protocol deviations'),
    sites.capas_opened AS SUM(sites.capas_f) WITH SYNONYMS = ('CAPAs', 'corrective actions'),
    sites.monitoring_compliance_pct AS 100 * SUM(sites.visits_done_f) / NULLIF(SUM(sites.visits_due_f), 0)
      COMMENT = 'Monitoring visits completed / monitoring visits due',
    risk.avg_deviation_prob AS AVG(risk.deviation_prob_f),
    signals.type_signals AS SUM(signals.type_signals_f),
    signals.type_confirmed AS SUM(signals.type_confirmed_f),
    signals.type_capas AS SUM(signals.type_capas_f),
    signals.type_confirmation_pct AS 100 * SUM(signals.type_confirmed_f) / NULLIF(SUM(signals.type_signals_f), 0),
    daily.daily_screened AS SUM(daily.day_screened_f),
    daily.daily_enrolled AS SUM(daily.day_enrolled_f),
    daily.daily_signals AS SUM(daily.day_signals_f)
  )
  COMMENT = 'Synthetic clinical trial site operations analytics (demo; no patient data)';

-- ---------- Cortex Agent ----------
CREATE OR REPLACE AGENT APP.TRIAL_OPS_AGENT
  COMMENT = 'Site operations assistant over a synthetic Singapore clinical trial site network'
  FROM SPECIFICATION
$$
models:
  orchestration: claude-sonnet-4-5
instructions:
  response: "Answer only from tool results. State that data is synthetic. Give site IDs and numbers with units. Do not give medical or clinical advice; this is operational data only."
  orchestration: "Use trial_ops_analyst for enrollment, screening, monitoring signals, important deviations, CAPAs, monitoring visit compliance, sites, planning areas, therapeutic areas and deviation risk. Use sop_search for follow-up procedures."
tools:
  - tool_spec:
      type: cortex_analyst_text_to_sql
      name: trial_ops_analyst
      description: "Enrollment vs plan, screen failures, monitoring signals, important deviations, CAPAs, monitoring visit compliance, signal types and deviation risk scores per site"
  - tool_spec:
      type: cortex_search
      name: sop_search
      description: "Synthetic site-management SOPs by therapeutic area and monitoring signal type"
tool_resources:
  trial_ops_analyst:
    semantic_view: __DEMO_DB__.APP.TRIAL_OPS_ANALYTICS
    execution_environment:
      type: warehouse
      warehouse: __DEMO_WH__
  sop_search:
    name: __DEMO_DB__.SEARCH.SITE_SOP_SEARCH
    max_results: 3
    id_column: DOC_ID
    title_column: TITLE
$$;

-- ---------- Live visit-record alert ----------
CREATE TABLE IF NOT EXISTS APP.ALERT_LOG (
  ALERTED_AT TIMESTAMP_LTZ DEFAULT CURRENT_TIMESTAMP(), SITE_ID VARCHAR,
  EVENT_TS TIMESTAMP_NTZ, ENTRY_LAG_HOURS FLOAT, QUERY_RATE_PCT FLOAT, SOP_HINT VARCHAR);

CREATE OR REPLACE NOTIFICATION INTEGRATION SG_HEALTHCARE_CLINICAL_TRIALS_EMAIL_INT
  TYPE = EMAIL ENABLED = TRUE ALLOWED_RECIPIENTS = ('__ALERT_EMAIL__');

CREATE OR REPLACE PROCEDURE APP.LOG_LIVE_ALERTS()
RETURNS NUMBER
LANGUAGE SQL
EXECUTE AS OWNER
AS
$$
DECLARE
  n NUMBER;
BEGIN
  INSERT INTO APP.ALERT_LOG (SITE_ID, EVENT_TS, ENTRY_LAG_HOURS, QUERY_RATE_PCT, SOP_HINT)
    SELECT v.SITE_ID, v.EVENT_TS, v.ENTRY_LAG_HOURS, v.QUERY_RATE_PCT,
           'Check ' || s.CATEGORY || ' follow-up SOPs; current risk band ' || COALESCE(r.RISK_BAND, 'n/a')
    FROM RAW.LIVE_VISITS v
    JOIN RAW.SITES s ON s.ID = v.SITE_ID
    LEFT JOIN ML.DEVIATION_RISK_SCORES r ON r.ENTITY_ID = v.SITE_ID
    WHERE v.STATUS = 'ALERT'
      AND NOT EXISTS (SELECT 1 FROM APP.ALERT_LOG l WHERE l.SITE_ID = v.SITE_ID AND l.EVENT_TS = v.EVENT_TS);
  n := SQLROWCOUNT;
  IF (n > 0) THEN
    CALL SYSTEM$SEND_EMAIL('SG_HEALTHCARE_CLINICAL_TRIALS_EMAIL_INT', '__ALERT_EMAIL__',
      '[Demo] Trial site operations alert',
      'New visit-record alerts logged in APP.ALERT_LOG: ' || :n || '. Data is synthetic.');
  END IF;
  RETURN n;
END;
$$;

CREATE OR REPLACE ALERT APP.LIVE_VISIT_ALERT
  WAREHOUSE = __DEMO_WH__
  SCHEDULE = '5 MINUTE'
  IF (EXISTS (
    SELECT 1 FROM RAW.LIVE_VISITS v
    WHERE v.STATUS = 'ALERT'
      AND NOT EXISTS (SELECT 1 FROM APP.ALERT_LOG l WHERE l.SITE_ID = v.SITE_ID AND l.EVENT_TS = v.EVENT_TS)))
  THEN CALL APP.LOG_LIVE_ALERTS();

-- ---------- On-demand refresh DAG (suspended; run with EXECUTE TASK APP.TASK_REFRESH_CURATED) ----------
CREATE OR REPLACE PROCEDURE APP.REFRESH_CURATED()
RETURNS VARCHAR
LANGUAGE SQL
EXECUTE AS OWNER
AS
$$
BEGIN
  ALTER DYNAMIC TABLE CURATED.PERFORMANCE_SUMMARY REFRESH;
  ALTER DYNAMIC TABLE CURATED.TREND_ANALYSIS REFRESH;
  ALTER DYNAMIC TABLE CURATED.SIGNAL_SUMMARY REFRESH;
  ALTER DYNAMIC TABLE CURATED.KPI_SUMMARY REFRESH;
  RETURN 'refreshed';
END;
$$;

CREATE OR REPLACE TASK APP.TASK_REFRESH_CURATED
  WAREHOUSE = __DEMO_WH__
AS
  CALL APP.REFRESH_CURATED();

CREATE OR REPLACE TASK APP.TASK_RESCORE_RISK
  WAREHOUSE = __DEMO_WH__
  AFTER APP.TASK_REFRESH_CURATED
AS
  CREATE OR REPLACE TABLE ML.DEVIATION_RISK_SCORES COPY GRANTS AS
  WITH latest AS (
    SELECT * FROM ML.DEVIATION_FEATURES QUALIFY ROW_NUMBER() OVER (PARTITION BY ENTITY_ID ORDER BY EVENT_DATE DESC) = 1
  ), p AS (
    SELECT ENTITY_ID, EVENT_DATE,
           ML.DEVIATION_RISK_MODEL!PREDICT(INPUT_DATA => OBJECT_CONSTRUCT(
             'CATEGORY', CATEGORY, 'MONITORING_TIER', MONITORING_TIER, 'YEARS_ACTIVE', YEARS_ACTIVE,
             'QUERY_RATE_PCT', QUERY_RATE_PCT, 'ENTRY_LAG_DAYS', ENTRY_LAG_DAYS,
             'QUERY_RATE_7D', QUERY_RATE_7D, 'CONFIRMED_30D', CONFIRMED_30D)) AS PRED
    FROM latest
  )
  SELECT ENTITY_ID, EVENT_DATE AS SCORED_AS_OF, ROUND(PRED:probability:DEVIATION::FLOAT, 4) AS DEVIATION_PROB_7D,
         CASE WHEN PRED:probability:DEVIATION::FLOAT >= 0.5 THEN 'High'
              WHEN PRED:probability:DEVIATION::FLOAT >= 0.25 THEN 'Medium' ELSE 'Low' END AS RISK_BAND,
         CURRENT_TIMESTAMP() AS SCORED_AT
  FROM p;
