from eurodash.config import Config
from eurodash.db import connect

cfg = Config.load('config.yml')
con = connect(cfg.get('warehouse','duckdb_path'))
result = con.execute("SELECT dataset_code, last_update_data FROM catalog_registry WHERE dataset_code = 'prc_hicp_midx'").df()
print("prc_hicp_midx search:")
print(result)
print("\nAll prc_hicp datasets:")
result2 = con.execute("SELECT dataset_code, last_update_data FROM catalog_registry WHERE dataset_code LIKE 'prc_hicp%' LIMIT 30").df()
print(result2)
print(result)
con.close()
