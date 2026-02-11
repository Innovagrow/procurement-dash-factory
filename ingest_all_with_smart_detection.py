"""
Try smart ingestion on ALL datasets to find which ones work
WARNING: This will take 2-4 hours to test 7,616 datasets
"""
import duckdb
from eurodash.config import Config
from eurodash.smart_ingest import smart_ingest_dataset
from eurodash.ingest import upsert_fact
import time

cfg = Config.load('config.yml')
con = duckdb.connect(cfg.get('warehouse', 'duckdb_path'), read_only=True)

# Get all datasets we haven't tried yet
already_have = con.execute('SELECT DISTINCT dataset_code FROM fact_observations').df()['dataset_code'].tolist()
all_datasets = con.execute('SELECT dataset_code FROM catalog_registry').df()['dataset_code'].tolist()
con.close()

to_try = [d for d in all_datasets if d not in already_have]

print(f"Already have data for: {len(already_have)} datasets")
print(f"Need to test: {len(to_try)} datasets")
print(f"Estimated time: {len(to_try) * 2 / 60:.0f} minutes")
print("=" * 60)

success_count = 0
fail_count = 0

for idx, dataset_code in enumerate(to_try, 1):
    print(f"\n[{idx}/{len(to_try)}] Testing: {dataset_code}")
    
    try:
        df = smart_ingest_dataset(cfg, dataset_code)
        
        if df.empty:
            print(f"  [NO DATA]")
            fail_count += 1
        else:
            print(f"  [SUCCESS] {len(df)} rows - SAVING TO DB")
            upsert_fact(cfg, df, dataset_code)
            success_count += 1
        
        # Progress update every 50
        if idx % 50 == 0:
            print("\n" + "=" * 60)
            print(f"PROGRESS: {idx}/{len(to_try)} tested")
            print(f"Success: {success_count}, Failed: {fail_count}")
            print(f"Success rate: {success_count/(success_count+fail_count)*100:.1f}%")
            print("=" * 60)
        
        time.sleep(0.5)  # Don't hammer Eurostat API
        
    except Exception as e:
        print(f"  [ERROR] {str(e)[:50]}")
        fail_count += 1
        time.sleep(0.5)

print("\n" + "=" * 60)
print("FINAL RESULTS:")
print(f"Total tested: {len(to_try)}")
print(f"With data: {success_count}")
print(f"No data: {fail_count}")
print(f"Success rate: {success_count/(success_count+fail_count)*100:.1f}%")
print("\nTotal datasets with data: " + str(len(already_have) + success_count))
print("=" * 60)
