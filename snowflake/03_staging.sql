-- Validate the producer contract before building downstream objects.
USE DATABASE IDENTIFIER($DEMO_DB);
USE SCHEMA RAW;
USE WAREHOUSE IDENTIFIER($DEMO_WH);

EXECUTE IMMEDIATE $$
DECLARE
  violations INTEGER;
  invalid_source EXCEPTION (-20001, 'Synthetic source failed grain or measure validation');
BEGIN
  SELECT COUNT(*) INTO :violations FROM (
    SELECT ENTITY_ID, EVENT_DATE
    FROM RAW.SITE_DAILY
    GROUP BY ENTITY_ID, EVENT_DATE HAVING COUNT(*) <> 1
    UNION ALL
    SELECT observation.ENTITY_ID, observation.EVENT_DATE
    FROM RAW.SITE_DAILY observation
    LEFT JOIN RAW.SITES site ON site.ID = observation.ENTITY_ID
    WHERE site.ID IS NULL OR observation.SCREENED_COUNT < 0
       OR observation.ENROLLED_COUNT < 0 OR observation.ENROLLED_COUNT > observation.SCREENED_COUNT
       OR observation.CONFIRMED_COUNT < 0 OR observation.CONFIRMED_COUNT > observation.SIGNAL_COUNT
       OR observation.CAPA_OPENED > observation.CONFIRMED_COUNT
       OR observation.MONITORING_COMPLETED > observation.MONITORING_DUE
  );
  IF (violations > 0) THEN
    RAISE invalid_source;
  END IF;
END;
$$;
