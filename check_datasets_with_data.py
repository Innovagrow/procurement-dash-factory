"""
Check which datasets from Eurostat catalog actually have data
"""
import duckdb
from eurodash.config import Config
from eurodash.ingest import ingest_dataset
import time

cfg = Config.load('config.yml')
con = duckdb.connect(cfg.get('warehouse', 'duckdb_path'), read_only=True)

# Get all datasets
df = con.execute("""
    SELECT dataset_code, title 
    FROM catalog_registry 
    ORDER BY RANDOM()
    LIMIT 50
""").df()
con.close()

print(f"Testing {len(df)} random datasets from catalog...")
print("=" * 60)

datasets_with_data = []
datasets_no_data = []

for idx, row in df.iterrows():
    code = row['dataset_code']
    print(f"\n[{idx+1}/50] Testing: {code}")
    
    try:
        data = ingest_dataset(cfg, code)
        
        if data.empty:
            print(f"  [NO DATA] {code}")
            datasets_no_data.append(code)
        else:
            print(f"  [HAS DATA] {code} - {len(data)} rows")
            datasets_with_data.append((code, len(data), row['title']))
        
        time.sleep(0.5)  # Don't hammer the API
        
    except Exception as e:
        error = str(e)
        if 'No data' in error or '404' in error:
            print(f"  [NO DATA] {code} - {error[:50]}")
            datasets_no_data.append(code)
        else:
            print(f"  [ERROR] {code} - {error[:50]}")
            datasets_no_data.append(code)
        
        time.sleep(0.5)

print("\n" + "=" * 60)
print(f"RESULTS (from 50 random samples):")
print(f"  WITH DATA: {len(datasets_with_data)}")
print(f"  NO DATA:   {len(datasets_no_data)}")
print(f"  Success rate: {len(datasets_with_data)/50*100:.1f}%")

print("\n" + "=" * 60)
print("DATASETS WITH DATA:")
print("=" * 60)
for code, rows, title in datasets_with_data[:20]:
    print(f"{code:20} {rows:>8} rows - {title[:50]}")

# Estimate total
total_in_catalog = 7616
estimated_with_data = int((len(datasets_with_data) / 50) * total_in_catalog)
print("\n" + "=" * 60)
print(f"ESTIMATE:")
print(f"  Out of {total_in_catalog} datasets in catalog")
print(f"  Approximately {estimated_with_data} may have data")
print(f"  ({len(datasets_with_data)/50*100:.1f}% success rate)")
print("=" * 60)
