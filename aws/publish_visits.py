"""Publish simulated site visit-record events to Amazon Data Firehose (stream <prefix>-visits).

Each event is a site-level eCRF visit-record submission with no patient
identifiers: site, data-entry lag, data query rate and status. Firehose batches
the records into S3 (visits/); Snowpipe loads them into RAW.LIVE_VISITS.
Site IDs come from RAW.SITES (SITE-0000..SITE-0039). Values are seeded random.
"""
import argparse
import json
import random
import time
from datetime import datetime, timezone


def make_event(rng):
    alert = rng.random() < 0.1
    return {'site_id': f'SITE-{rng.randint(0, 39):04d}',
            'event_ts': datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%S.%f')[:-3],
            'entry_lag_hours': round((120 if alert else 18) * rng.lognormvariate(0, 0.5), 1),
            'query_rate_pct': round(max(0.0, rng.gauss(9.5 if alert else 2.5, 1.0)), 2),
            'status': 'ALERT' if alert else 'OK',
            'sent_ms': int(time.time() * 1000)}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--region', default='us-west-2')
    ap.add_argument('--prefix', default='sg-healthcare-clinical-trials')
    ap.add_argument('--count', type=int, default=40)
    ap.add_argument('--seed', type=int)
    args = ap.parse_args()
    import boto3
    firehose = boto3.client('firehose', region_name=args.region)
    stream = f'{args.prefix}-visits'
    rng = random.Random(args.seed)
    records = [{'Data': (json.dumps(make_event(rng)) + '\n').encode()} for _ in range(args.count)]
    for start in range(0, len(records), 500):
        out = firehose.put_record_batch(DeliveryStreamName=stream, Records=records[start:start + 500])
        if out['FailedPutCount']:
            raise RuntimeError(f"{out['FailedPutCount']} records were rejected by Firehose")
    print(f'published {args.count} visit-record events to Firehose stream {stream}; S3 delivery buffers up to 60 s')


if __name__ == '__main__':
    main()
