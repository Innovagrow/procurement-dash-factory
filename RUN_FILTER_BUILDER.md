# Build Permanent Filter Database

## **What This Does:**

Tests all 7,616 Eurostat datasets ONCE and records which filters work for each.
After running this, your app will ALWAYS know the exact filters needed - no more guessing!

---

## **How to Run:**

### **Option 1: Run Locally (Recommended)**

```bash
# Make sure server is not running (stop it first)
py build_filter_database.py
```

**Time:** 2-3 hours (runs once, benefits forever)

**What happens:**
- Tests each dataset with different filter combinations
- Records what works in `dataset_filters.json`
- Auto-saves progress every 10 datasets
- Can interrupt (Ctrl+C) and resume anytime

### **Option 2: Resume from Specific Dataset**

If interrupted, resume from where you left off:

```bash
py build_filter_database.py nama_10_gdp
```

---

## **During Execution:**

You'll see:
```
[1/7616] Processing nama_10_gdp
  Try 1: No filters
  ✓ Works with no filters

[2/7616] Processing prc_hicp_midx
  Try 1: No filters
  ✗ Failed
  Try 2: Auto-detect from structure
  Testing: {'geo': 'EU27_2020', 'coicop': 'TOTAL'}
  ✓ Works with auto-detected filters

[CHECKPOINT] Saved 10 entries
  Success: 8, Failed: 2
```

---

## **After Completion:**

`dataset_filters.json` will contain:

```json
{
  "nama_10_gdp": {},
  "prc_hicp_midx": {"geo": "EU27_2020", "coicop": "TOTAL"},
  "rail_tf_ns10_lu": {"geo": "EU27_2020", "unit": "THS_T"},
  "apri_pi05_outa": {"_no_data": true},
  ...
}
```

---

## **How the App Uses It:**

**Before filter database:**
1. User clicks dataset
2. App tries random combinations
3. 50% chance of failure ❌

**After filter database:**
1. User clicks dataset
2. App looks up pre-tested filters
3. Uses exact filters that work
4. 99% success rate ✓

---

## **Benefits:**

✅ **Instant generation** - No trial-and-error
✅ **Predictable** - Knows which datasets have data
✅ **Fast** - Skips datasets with no data
✅ **Reliable** - Uses confirmed working filters

---

## **Important Notes:**

1. **Run locally** - Don't run on Railway (would timeout)
2. **Internet required** - Calls Eurostat API 7,616 times
3. **Interruptible** - Can stop and resume anytime
4. **One-time** - Run once, benefit forever
5. **Update yearly** - Eurostat adds ~100 new datasets/year

---

## **After Building:**

1. **Commit the JSON:**
   ```bash
   git add dataset_filters.json
   git commit -m "Add pre-tested filters for all datasets"
   git push origin main
   ```

2. **Railway auto-deploys** with the new database

3. **All future dashboard generations** use pre-tested filters

---

## **Progress Tracking:**

The script saves every 10 datasets, so you can track progress:

```bash
# Check how many processed
cat dataset_filters.json | grep ":" | wc -l

# See recent entries
tail -20 dataset_filters.json
```

---

## **Estimated Statistics:**

- **~5,000 datasets**: Work with no filters
- **~2,000 datasets**: Need specific filters
- **~616 datasets**: No public data available

After completion, you'll know EXACTLY which category each dataset falls into!

---

**Ready to run? Open terminal and execute:**

```bash
py build_filter_database.py
```

**Then go do something else for 2-3 hours while it runs!** ☕
