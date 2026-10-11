# Singapore Clinical Trial Site Operations

**Singapore - Island-wide Trial Site Network**
Use case: Enrollment tracking and risk-based site monitoring

> Site operations for 40 trial sites run by a fictional Singapore contract research organisation, Straits Meridian Clinical Research, across 5 planning areas: dynamic tables, a holdout-evaluated important-deviation classifier, an enrollment forecast and grounded AI answers. Synthetic, site-level data only; no patient records.

## Why Snowflake

- **Dynamic tables** reconcile enrollment against plan, screen failures, monitoring signals, important deviations and monitoring visit compliance from RAW site data, with checks in `run_core.py`
- **Important-deviation classification** gives a holdout-evaluated next-7-day probability per site
- **Enrollment forecast** projects 14 days of network-wide enrollment with prediction intervals, for recruitment planning
- **Grounded AI**: the Cortex Agent (Analyst over a semantic view, plus Search over SOPs) shows its SQL and SOP citations
- **Live visit records**: a native simulator (Snowflake only) or Amazon Data Firehose, S3 and Snowpipe (AWS build), then an alert and email

## What is built

| | |
|---|---|
| Dimension table | `RAW.SITES` (40 rows) |
| Fact table | `RAW.SITE_DAILY` (3,600 site-days, 90 days) |
| Curated layer | `CURATED.KPI_SUMMARY`, `PERFORMANCE_SUMMARY`, `SIGNAL_SUMMARY`, `TREND_ANALYSIS` |
| ML | `ML.DEVIATION_RISK_SCORES`, `ML.DEVIATION_RISK_HOLDOUT_METRICS`, `ML.ENROLLMENT_FORECAST`, `ML.QUERY_RATE_ANOMALIES` |

Planning areas (8 sites each): Novena, Outram, Queenstown, Jurong East, Tampines.
Therapeutic areas: Oncology (15 sites), Cardiology (10), Respiratory (5), Neurology (5), Metabolic (5).

## KPI cards (live from `CURATED.KPI_SUMMARY`; no fallback values)

| Card | Value from the seeded data |
|---|---|
| Enrollment vs Plan | 92.5% |
| Participants Enrolled | 4,876 |
| Screen Failure Rate | 26.2% |
| Signal Confirmation Rate | 33.4% |
| Monitoring Signals | 611 |
| Important Deviations | 204 |
| CAPAs Opened | 101 |
| Monitoring Visit Compliance | 73.1% |
| Sites Active | 40 |
| Essential Document Coverage | 68.6% |
| Essential Documents Pending | 22 |

Values are synthetic. A rebuild reproduces them because the data is HASH-seeded; dates are relative to the build day.

## Demo flow

1. Executive Cockpit: KPIs, daily enrollment against monitoring signals, signals and important deviations by signal type, site table with planning area
2. Predictive: holdout metrics, risk bands, 14-day enrollment forecast, data query rate anomalies
3. Site Monitoring: monitoring visit compliance, essential document coverage and pending documents, monitoring compliance against important deviations, then generate the action memo for Joanne Koh
4. Live Visits: run `CALL APP.SIMULATE_VISITS(20)` (Snowflake only) or `python aws/publish_visits.py --count 20` (AWS build). Then run `EXECUTE ALERT APP.LIVE_VISIT_ALERT` and show the alert log and email.
5. Ask AI: ask "What is enrollment vs plan by planning area?". The Cortex Agent answers through the semantic view and cites SOPs from Cortex Search. The SQL is shown.
6. QuickSight (AWS build): the same Snowflake tables through DIRECT_QUERY
7. Architecture: both builds side by side

## Talking points

- The network is at 92.5% of its 90-day enrollment plan, and 8 sites are below 80% of plan. Queenstown is closest to plan (875 of 887) but has the most important deviations (66).
- About one monitoring signal in three is confirmed as an important deviation (33.4%). Visit window signals produce the most important deviations (57 of 186). Area EDC outage signals hit every site in a planning area at once (Jurong East and Tampines) and are never confirmed.
- The risk model is evaluated on a time-based holdout: precision 0.52 and recall 0.56 at 0.5, against a 0.18 base rate. Present it as triage for monitoring effort, not a verdict on a site.
- Area EDC outages are excluded from model training, because they are not site-driven.
- This is operational data only. It makes no clinical, safety, efficacy or regulatory claims and contains no patient records.

## Business impact

Use only the sourced references in `README.md` (Business Impact).
