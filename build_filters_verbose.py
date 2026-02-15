"""
Verbose filter builder with immediate output and progress tracking
"""
import json
import requests
from pathlib import Path
import sys

# Force output flushing
sys.stdout.reconfigure(line_buffering=True)

print("Filter Database Builder - Verbose Mode", flush=True)
print("=" * 60, flush=True)

# Load catalog
catalog_path = Path('site/_site/catalog.json')
catalog = json.loads(catalog_path.read_text())
all_datasets = [ds['code'] for ds in catalog['datasets']]

# Load existing database
db_path = Path('dataset_filters.json')
if db_path.exists():
    filter_db = json.loads(db_path.read_text())
else:
    filter_db = {}

print(f"Total: {len(all_datasets)} | Already done: {len(filter_db)} | Remaining: {len(all_datasets) - len(filter_db)}", flush=True)
print("=" * 60, flush=True)
print("", flush=True)

def test_dataset(code, filters={}):
    """Test if dataset returns data"""
    url = f"https://ec.europa.eu/eurostat/api/dissemination/statistics/1.0/data/{code}"
    params = {'format': 'JSON', 'compressed': 'false'}
    params.update(filters)
    
    try:
        r = requests.get(url, params=params, timeout=5)
        if r.status_code == 200:
            data = r.json()
            if 'value' in data and len(data['value']) > 0:
                return True
    except:
        pass
    return False

# Process datasets
success = 0
failed = 0
skipped = 0

for i, code in enumerate(all_datasets, 1):
    # Skip if already done
    if code in filter_db:
        skipped += 1
        continue
    
    print(f"[{i}/{len(all_datasets)}] {code}...", end=' ', flush=True)
    
    # Try filters
    if test_dataset(code):
        filter_db[code] = {}
        success += 1
        print("OK (no filters)", flush=True)
    elif test_dataset(code, {'geo': 'EU27_2020'}):
        filter_db[code] = {'geo': 'EU27_2020'}
        success += 1
        print("OK (geo=EU27_2020)", flush=True)
    elif test_dataset(code, {'geo': 'TOTAL'}):
        filter_db[code] = {'geo': 'TOTAL'}
        success += 1
        print("OK (geo=TOTAL)", flush=True)
    else:
        filter_db[code] = {'_no_data': True}
        failed += 1
        print("NO DATA", flush=True)
    
    # Save every 25
    if (i - skipped) % 25 == 0:
        db_path.write_text(json.dumps(filter_db, indent=2))
        print(f"\n[SAVED] Progress: {len(filter_db)}/{len(all_datasets)} | Data:{success} NoData:{failed} Skip:{skipped}\n", flush=True)

# Final save
db_path.write_text(json.dumps(filter_db, indent=2))

print("", flush=True)
print("=" * 60, flush=True)
print(f"COMPLETE! Data:{success} NoData:{failed} Total:{len(filter_db)}", flush=True)
print("=" * 60, flush=True)
