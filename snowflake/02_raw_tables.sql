-- Synthetic site-day operations data for a fictional Singapore contract research organisation (40 sites in 5 planning areas).
-- Site-level aggregate counts only: there are no patient records, no patient
-- identifiers and no clinical outcomes. Nothing is seeded as a prediction.
-- Randomness is HASH-seeded, so every rebuild is reproducible: per-site
-- deviation propensity, drift between monitoring visits, missed monitoring
-- visits, therapeutic-area-weighted monitoring signals, signals that are not
-- confirmed on review, and two planning-area EDC outages.
USE DATABASE IDENTIFIER($DEMO_DB);
USE SCHEMA RAW;
USE WAREHOUSE IDENTIFIER($DEMO_WH);

CREATE TABLE RAW.SITES AS
WITH sites AS (
  SELECT ROW_NUMBER() OVER (ORDER BY SEQ4()) - 1 AS SITE_INDEX
  FROM TABLE(GENERATOR(ROWCOUNT => 40))
), draws AS (
  SELECT SITE_INDEX,
         MOD(ABS(HASH(SITE_INDEX, 'sg-experience')), 1000000) / 1e6 AS U_EXPERIENCE,
         MOD(ABS(HASH(SITE_INDEX, 'sg-deviation')), 1000000) / 1e6 AS U_RATE,
         MOD(ABS(HASH(SITE_INDEX, 'sg-monitoring')), 1000000) / 1e6 AS U_MONITORING,
         MOD(ABS(HASH(SITE_INDEX, 'sg-discipline')), 1000000) / 1e6 AS U_DISCIPLINE,
         MOD(ABS(HASH(SITE_INDEX, 'sg-tier')), 1000000) / 1e6 AS U_TIER,
         MOD(ABS(HASH(SITE_INDEX, 'sg-screening')), 1000000) / 1e6 AS U_SCREEN,
         MOD(ABS(HASH(SITE_INDEX, 'sg-plan')), 1000000) / 1e6 AS U_PLAN
  FROM sites
), sized AS (
  SELECT *,
         -- Deterministic spread (5 and 8 are coprime): every planning area and
         -- therapeutic area is present.
         CASE MOD(SITE_INDEX, 5) WHEN 0 THEN 'Novena' WHEN 1 THEN 'Outram'
              WHEN 2 THEN 'Queenstown' WHEN 3 THEN 'Jurong East' ELSE 'Tampines' END AS REGION,
         CASE MOD(SITE_INDEX, 8) WHEN 0 THEN 'Oncology' WHEN 1 THEN 'Oncology' WHEN 2 THEN 'Oncology'
              WHEN 3 THEN 'Cardiology' WHEN 4 THEN 'Cardiology' WHEN 5 THEN 'Respiratory'
              WHEN 6 THEN 'Neurology' ELSE 'Metabolic' END AS CATEGORY,
         -- Mean participants screened per day at the site.
         0.6 + U_SCREEN * 2.4 AS SCREEN_RATE
  FROM draws
)
SELECT 'SITE-' || LPAD(SITE_INDEX::VARCHAR, 4, '0') AS ID,
       'Synthetic site ' || LPAD(SITE_INDEX::VARCHAR, 4, '0') AS NAME,
       REGION, CATEGORY, SITE_INDEX,
       1 + FLOOR(U_TIER * 3) AS MONITORING_TIER,
       ROUND(0.2 + U_EXPERIENCE * 5.8, 1) AS YEARS_ACTIVE,
       SCREEN_RATE,
       -- Planned enrollments for the 90-day window (synthetic plan).
       ROUND(SCREEN_RATE * 90 * 0.72 * (0.9 + 0.4 * U_PLAN)) AS ENROLLMENT_TARGET_90D,
       -- Base daily probability of an important protocol deviation 0.4%-3%;
       -- ~15% of sites are persistent outliers (x3).
       (0.004 + U_RATE * 0.026) * IFF(U_RATE > 0.85, 3, 1) AS BASE_DEVIATION_RATE,
       7 * (1 + FLOOR(U_MONITORING * 3)) AS MONITORING_INTERVAL_DAYS,
       0.55 + U_DISCIPLINE * 0.45 AS MONITORING_COMPLETION_PROB,
       'Active' AS STATUS
FROM sized;

CREATE TABLE RAW.SITE_DAILY AS
WITH days AS (
  SELECT ROW_NUMBER() OVER (ORDER BY SEQ4()) - 1 AS DAY_INDEX
  FROM TABLE(GENERATOR(ROWCOUNT => 90))
), regional_events AS (
  -- Two planning-area EDC outages; every site in the area raises a data-entry signal.
  SELECT * FROM VALUES (31, 'Jurong East'), (58, 'Tampines') AS o(DAY_INDEX, REGION)
), base AS (
  SELECT s.ID AS ENTITY_ID, s.SITE_INDEX, s.CATEGORY, s.REGION, s.YEARS_ACTIVE, s.SCREEN_RATE,
         s.BASE_DEVIATION_RATE, s.MONITORING_INTERVAL_DAYS, s.MONITORING_COMPLETION_PROB,
         d.DAY_INDEX,
         DATEADD('day', d.DAY_INDEX - 89, CURRENT_DATE()) AS EVENT_DATE,
         MOD(d.DAY_INDEX + s.SITE_INDEX * 5, s.MONITORING_INTERVAL_DAYS) AS DAYS_SINCE_VISIT,
         MOD(ABS(HASH(s.ID, d.DAY_INDEX, 'sg-deviation')), 1000000) / 1e6 AS U_DEV,
         MOD(ABS(HASH(s.ID, d.DAY_INDEX, 'sg-detect')), 1000000) / 1e6 AS U_DETECT,
         MOD(ABS(HASH(s.ID, d.DAY_INDEX, 'sg-unconfirmed')), 1000000) / 1e6 AS U_FP,
         MOD(ABS(HASH(s.ID, d.DAY_INDEX, 'sg-signal')), 1000000) / 1e6 AS U_SIGNAL,
         MOD(ABS(HASH(s.ID, d.DAY_INDEX, 'sg-visit')), 1000000) / 1e6 AS U_DONE,
         MOD(ABS(HASH(s.ID, d.DAY_INDEX, 'sg-screened')), 1000000) / 1e6 AS U_SCREENED,
         MOD(ABS(HASH(s.ID, d.DAY_INDEX, 'sg-enrolled')), 1000000) / 1e6 AS U_ENROLLED,
         MOD(ABS(HASH(s.ID, d.DAY_INDEX, 'sg-noise')), 1000000) / 1e6 AS U_NOISE,
         MOD(ABS(HASH(s.ID, d.DAY_INDEX, 'sg-capa')), 1000000) / 1e6 AS U_CAPA,
         e.REGION IS NOT NULL AS REGIONAL_EVENT
  FROM RAW.SITES s CROSS JOIN days d
  LEFT JOIN regional_events e ON e.DAY_INDEX = d.DAY_INDEX AND e.REGION = s.REGION
), monitoring AS (
  SELECT *,
         IFF(DAYS_SINCE_VISIT = 0, 1, 0) AS MONITORING_DUE,
         IFF(DAYS_SINCE_VISIT = 0 AND U_DONE < MONITORING_COMPLETION_PROB, 1, 0) AS MONITORING_COMPLETED,
         -- Process drift rises between monitoring visits; weak follow-through carries it over.
         DAYS_SINCE_VISIT / MONITORING_INTERVAL_DAYS + (1 - MONITORING_COMPLETION_PROB) AS DRIFT
  FROM base
), deviations AS (
  SELECT *,
         CASE WHEN U_DEV < LEAST(0.5, BASE_DEVIATION_RATE * (0.4 + 1.6 * DRIFT) * (1 + 1 / (1 + YEARS_ACTIVE))) / 4 THEN 2
              WHEN U_DEV < LEAST(0.5, BASE_DEVIATION_RATE * (0.4 + 1.6 * DRIFT) * (1 + 1 / (1 + YEARS_ACTIVE))) THEN 1
              ELSE 0 END AS DEVIATION_EVENTS
  FROM monitoring
), signals AS (
  SELECT *,
         -- Central monitoring catches about 85% of important deviations.
         IFF(REGIONAL_EVENT, 0, IFF(U_DETECT < 0.85, DEVIATION_EVENTS, 0)) AS CONFIRMED_COUNT,
         -- Signals not confirmed on review: higher for complex protocols.
         IFF(REGIONAL_EVENT, 1, IFF(U_FP < CASE CATEGORY WHEN 'Oncology' THEN 0.14
                                                         WHEN 'Cardiology' THEN 0.10
                                                         WHEN 'Neurology' THEN 0.10 ELSE 0.08 END, 1, 0)) AS UNCONFIRMED_COUNT,
         FLOOR(SCREEN_RATE * (0.4 + 1.2 * U_SCREENED) + 0.5) AS SCREENED_COUNT
  FROM deviations
)
SELECT ENTITY_ID || '-' || TO_CHAR(EVENT_DATE, 'YYYYMMDD') AS EVENT_ID,
       ENTITY_ID, EVENT_DATE,
       SCREENED_COUNT,
       FLOOR(SCREENED_COUNT * (0.5 + 0.35 * U_ENROLLED) + 0.5) AS ENROLLED_COUNT,
       CONFIRMED_COUNT + UNCONFIRMED_COUNT AS SIGNAL_COUNT,
       CONFIRMED_COUNT,
       IFF(CONFIRMED_COUNT > 0 AND U_CAPA < 0.6, 1, 0) AS CAPA_OPENED,
       CASE WHEN CONFIRMED_COUNT + UNCONFIRMED_COUNT = 0 THEN 'None'
            WHEN REGIONAL_EVENT THEN 'Area EDC outage'
            WHEN CATEGORY = 'Oncology' THEN IFF(U_SIGNAL < 0.4, 'Eligibility criteria', IFF(U_SIGNAL < 0.75, 'IP handling', 'Visit window'))
            WHEN CATEGORY = 'Cardiology' THEN IFF(U_SIGNAL < 0.45, 'Visit window', IFF(U_SIGNAL < 0.8, 'Informed consent', 'Lab sample handling'))
            WHEN CATEGORY = 'Respiratory' THEN IFF(U_SIGNAL < 0.55, 'Visit window', 'IP handling')
            WHEN CATEGORY = 'Neurology' THEN IFF(U_SIGNAL < 0.45, 'Informed consent', IFF(U_SIGNAL < 0.8, 'Visit window', 'Eligibility criteria'))
            ELSE IFF(U_SIGNAL < 0.5, 'Lab sample handling', IFF(U_SIGNAL < 0.75, 'Visit window', 'Eligibility criteria')) END AS SIGNAL_TYPE,
       MONITORING_DUE, MONITORING_COMPLETED,
       -- Data queries per 100 data points entered, and data-entry lag in days.
       ROUND(1.5 + 2.5 * DRIFT + 4.0 * DEVIATION_EVENTS + U_NOISE * 1.2, 2) AS QUERY_RATE_PCT,
       ROUND(1.0 + 2.0 * DRIFT + 3.0 * DEVIATION_EVENTS + U_NOISE * 1.5, 1) AS ENTRY_LAG_DAYS,
       CURRENT_TIMESTAMP() AS LOADED_AT
FROM signals;

-- Essential (regulatory) document coverage per site (snapshot).
CREATE TABLE RAW.ESSENTIAL_DOCUMENTS AS
SELECT ID AS ENTITY_ID,
       CASE CATEGORY WHEN 'Oncology' THEN 'IP accountability log' WHEN 'Cardiology' THEN 'Delegation log'
                     WHEN 'Respiratory' THEN 'Equipment calibration record'
                     WHEN 'Neurology' THEN 'Investigator GCP training' ELSE 'Laboratory certification' END AS DOC_TYPE,
       1 + MOD(ABS(HASH(ID, 'sg-required')), 4) AS REQUIRED_QTY,
       MOD(ABS(HASH(ID, 'sg-on file')), 5) AS ON_FILE_QTY,
       IFF(MOD(ABS(HASH(ID, 'sg-on file')), 5) < 1 + MOD(ABS(HASH(ID, 'sg-required')), 4),
           MOD(ABS(HASH(ID, 'sg-pending')), 3), 0) AS PENDING_QTY,
       CURRENT_DATE() AS SNAPSHOT_DATE
FROM RAW.SITES;
