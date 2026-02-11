"""
Ingest popular Eurostat datasets that are likely to have data
"""
from eurodash.config import Config
from eurodash.ingest import ingest_dataset, upsert_fact
import time

# Popular datasets across different categories
POPULAR_DATASETS = [
    # National Accounts (GDP)
    'nama_10_gdp',      # Already have
    'nama_10_a10',      # Already have
    'nama_10_a64',      # GDP by industry (detailed)
    'namq_10_gdp',      # Quarterly GDP
    
    # Prices & Inflation
    'prc_hicp_midx',    # HICP monthly index
    'prc_hicp_manr',    # HICP annual rate
    'prc_hicp_aind',    # HICP annual index
    
    # Unemployment
    'une_rt_m',         # Unemployment rate monthly
    'une_rt_a',         # Unemployment rate annual
    'une_nb_m',         # Unemployment numbers monthly
    
    # Employment
    'lfsq_egan',        # Employment by sex and age
    'lfsq_ergan',       # Employment rate
    
    # Population
    'demo_pjan',        # Population on 1 January
    'demo_gind',        # Demographic indicators
    
    # Trade
    'ext_lt_intratrd',  # Intra-EU trade
    'ext_lt_intercc',   # Extra-EU trade
    
    # Government Finance
    'gov_10q_ggdebt',   # Government debt quarterly
    'gov_10a_main',     # Government finance main
    
    # Production
    'sts_inpr_m',       # Production in industry monthly
    'sts_inpr_a',       # Production in industry annual
    
    # Energy
    'nrg_bal_c',        # Energy balance
    
    # Digital Economy
    'isoc_ci_ifp_iu',   # Internet usage
    
    # Labor costs
    'lc_lci_r2_a',      # Labor cost index annual
    
    # Education
    'educ_uoe_enra00',  # Education enrollment
]

def ingest_with_retry(cfg, dataset_code, max_retries=2):
    """Try to ingest a dataset, skip if it fails"""
    for attempt in range(max_retries):
        try:
            print(f"\n[{dataset_code}] Attempting to fetch data...")
            df = ingest_dataset(cfg, dataset_code)
            
            if df.empty:
                print(f"  [WARN] No data returned, trying without filters...")
                df = ingest_dataset(cfg, dataset_code, filters={})
            
            if df.empty:
                print(f"  [SKIP] No data available")
                return False
            
            print(f"  [OK] Got {len(df)} rows, saving to database...")
            upsert_fact(cfg, df, dataset_code)
            print(f"  [SUCCESS] {len(df)} rows")
            return True
            
        except Exception as e:
            error_msg = str(e)
            if 'No data' in error_msg or '404' in error_msg:
                print(f"  [SKIP] {error_msg}")
                return False
            if attempt < max_retries - 1:
                print(f"  [RETRY] {attempt + 1}/{max_retries}...")
                time.sleep(2)
            else:
                print(f"  [FAILED] {error_msg}")
                return False
    
    return False

if __name__ == '__main__':
    cfg = Config.load('config.yml')
    
    print("=" * 60)
    print("INGESTING POPULAR EUROSTAT DATASETS")
    print("=" * 60)
    
    success_count = 0
    skip_count = 0
    
    for i, dataset in enumerate(POPULAR_DATASETS, 1):
        print(f"\n[{i}/{len(POPULAR_DATASETS)}] {dataset}")
        
        if ingest_with_retry(cfg, dataset):
            success_count += 1
        else:
            skip_count += 1
        
        # Don't hammer the API
        time.sleep(1)
    
    print("\n" + "=" * 60)
    print(f"COMPLETE: {success_count} succeeded, {skip_count} skipped")
    print("=" * 60)
    
    print("\nNow regenerating catalog...")
    from eurodash.catalog_browser import generate_catalog_json
    from pathlib import Path
    
    catalog = generate_catalog_json(
        cfg.get('warehouse', 'duckdb_path'),
        Path('site/_site/catalog.json')
    )
    
    print(f"\n[OK] Catalog updated: {catalog['total']} datasets available")
