"""
FAST parallel filter database builder - tests all datasets in ~1 hour
"""
import json
import requests
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor, as_completed
from threading import Lock

print("FAST Filter Database Builder")
print("=" * 60)

# Load catalog
catalog_path = Path('site/_site/catalog.json')
catalog = json.loads(catalog_path.read_text())
all_datasets = [ds['code'] for ds in catalog['datasets']]

# Load existing database
db_path = Path('dataset_filters.json')
if db_path.exists():
    filter_db = json.loads(db_path.read_text())
    print(f"Loaded {len(filter_db)} existing entries")
else:
    filter_db = {}

print(f"Total datasets: {len(all_datasets)}")
print(f"Remaining: {len(all_datasets) - len(filter_db)}")
print("=" * 60)

# Thread-safe lock for updating database
db_lock = Lock()
save_counter = 0

def test_dataset(code, filters={}):
    """Quick test if dataset returns data"""
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

def process_dataset(code):
    """Process a single dataset"""
    global save_counter
    
    # Skip if already done
    if code in filter_db:
        return None
    
    # Try filters in order
    if test_dataset(code):
        result = {}
    elif test_dataset(code, {'geo': 'EU27_2020'}):
        result = {'geo': 'EU27_2020'}
    elif test_dataset(code, {'geo': 'TOTAL'}):
        result = {'geo': 'TOTAL'}
    else:
        result = {'_no_data': True}
    
    # Thread-safe update
    with db_lock:
        filter_db[code] = result
        save_counter += 1
        
        # Save every 50 datasets
        if save_counter % 50 == 0:
            db_path.write_text(json.dumps(filter_db, indent=2))
            has_data = sum(1 for v in filter_db.values() if not v.get('_no_data'))
            no_data = sum(1 for v in filter_db.values() if v.get('_no_data'))
            print(f"[PROGRESS] {len(filter_db)}/{len(all_datasets)} | Data: {has_data} | No Data: {no_data}")
    
    return code

# Process in parallel with 20 workers
print("\nProcessing with 20 parallel workers...")
print()

try:
    with ThreadPoolExecutor(max_workers=20) as executor:
        futures = {executor.submit(process_dataset, code): code for code in all_datasets}
        
        completed = 0
        for future in as_completed(futures):
            completed += 1
            if completed % 100 == 0:
                print(f"Completed: {completed}/{len(all_datasets)}")
    
except KeyboardInterrupt:
    print("\n\nInterrupted! Saving...")

# Final save
db_path.write_text(json.dumps(filter_db, indent=2))

# Calculate stats
has_data = sum(1 for v in filter_db.values() if not v.get('_no_data'))
no_data = sum(1 for v in filter_db.values() if v.get('_no_data'))

print("\n" + "=" * 60)
print("COMPLETE!")
print("=" * 60)
print(f"Total datasets: {len(filter_db)}")
print(f"With data: {has_data} ({has_data/len(filter_db)*100:.1f}%)")
print(f"No data: {no_data} ({no_data/len(filter_db)*100:.1f}%)")
print("=" * 60)
