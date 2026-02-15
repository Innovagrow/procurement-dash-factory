"""
Simple filter database builder - tests datasets and saves working filters
"""
import json
import requests
import time
from pathlib import Path

print("Starting filter database builder...")
print("=" * 60)

# Load catalog
catalog_path = Path('site/_site/catalog.json')
catalog = json.loads(catalog_path.read_text())
all_datasets = [ds['code'] for ds in catalog['datasets']]

print(f"Loaded {len(all_datasets)} datasets from catalog")

# Load or create filter database
db_path = Path('dataset_filters.json')
if db_path.exists():
    filter_db = json.loads(db_path.read_text())
    print(f"Existing database has {len(filter_db)} entries")
else:
    filter_db = {}

print("=" * 60)
print()

def test_dataset(code, filters={}):
    """Quick test if dataset+filters returns data"""
    url = f"https://ec.europa.eu/eurostat/api/dissemination/statistics/1.0/data/{code}"
    
    params = {'format': 'JSON', 'compressed': 'false'}
    params.update(filters)
    
    try:
        r = requests.get(url, params=params, timeout=8)
        if r.status_code == 200:
            data = r.json()
            if 'value' in data and len(data['value']) > 0:
                return True
        return False
    except:
        return False

# Process datasets
success = 0
failed = 0
skipped = 0

for i, code in enumerate(all_datasets, 1):
    # Skip if already done
    if code in filter_db:
        skipped += 1
        if i % 100 == 0:
            print(f"[{i}/{len(all_datasets)}] Skipped {code} (already done)")
        continue
    
    print(f"[{i}/{len(all_datasets)}] {code}")
    
    # Try no filters
    if test_dataset(code):
        filter_db[code] = {}
        success += 1
        print(f"  [OK] No filters")
    # Try geo=EU27_2020
    elif test_dataset(code, {'geo': 'EU27_2020'}):
        filter_db[code] = {'geo': 'EU27_2020'}
        success += 1
        print(f"  [OK] geo=EU27_2020")
    # Try geo=TOTAL
    elif test_dataset(code, {'geo': 'TOTAL'}):
        filter_db[code] = {'geo': 'TOTAL'}
        success += 1
        print(f"  [OK] geo=TOTAL")
    else:
        filter_db[code] = {'_no_data': True}
        failed += 1
        print(f"  [FAIL] No data")
    
    # Save every 10
    if i % 10 == 0:
        db_path.write_text(json.dumps(filter_db, indent=2))
        print(f"\n[SAVED] {i}/{len(all_datasets)} | OK:{success} FAIL:{failed} SKIP:{skipped}\n")
    
    time.sleep(0.3)  # Rate limit

# Final save
db_path.write_text(json.dumps(filter_db, indent=2))

print("\n" + "=" * 60)
print(f"COMPLETE: OK:{success} FAIL:{failed} SKIP:{skipped} Total:{len(filter_db)}")
print("=" * 60)
