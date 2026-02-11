# PERMANENT FIXES - DO NOT REPEAT THESE MISTAKES

## Problem 1: Landing Page Shows Escaped HTML

### Symptom:
Landing page shows `<h1><i class="fas fa-chart-line"></i> Eurostat AI Dashboards</h1>` as text instead of rendering

### Root Cause:
Quarto regenerates `site/_site/index.html` from `site/index.qmd` and escapes all HTML

### Solution:
```bash
# 1. Delete Quarto source
Remove-Item site\index.qmd -Force

# 2. Delete Quarto output
Remove-Item site\_site\index.html -Force

# 3. Create clean static HTML (use the file in this document below)
# Copy the CLEAN HTML section to site/_site/index.html
```

### Prevention:
- NEVER create `site/index.qmd`
- Keep `site/_site/index.html` as static HTML
- Add to `.gitignore`: `!site/_site/index.html` (force track it)

---

## Problem 2: Only 2 Datasets Showing

### Symptom:
Catalog shows only 2 datasets instead of 7,616

### Root Cause:
`catalog_browser.py` was filtering to only show datasets with pre-ingested data

### Solution:
In `eurodash/catalog_browser.py`:
```python
# WRONG - only shows pre-ingested data:
"""
SELECT DISTINCT c.dataset_code, c.title
FROM catalog_registry c
INNER JOIN fact_observations f ON c.dataset_code = f.dataset_code
"""

# CORRECT - shows all datasets (data fetched on-demand):
"""
SELECT dataset_code, title
FROM catalog_registry
ORDER BY last_update_data DESC
"""
```

### Prevention:
- Catalog = metadata only (all 7,616 datasets)
- Data = fetched on-demand when user clicks
- NO pre-ingestion required

---

## Problem 3: Reports Stuck at 95%

### Symptom:
Loading screen shows 95% and never completes

### Root Causes:
1. Dataset has no data available
2. Quarto output path is wrong
3. Backend doesn't detect errors properly

### Solution:
In `api_server.py`:
```python
# 1. Detect "no data" errors
output_combined = result.stdout + result.stderr
if 'ERROR' in output_combined and 'Still no data' in output_combined:
    generation_status[dataset_code]['status'] = 'failed'
    generation_status[dataset_code]['message'] = 'This dataset has no data available. Try a different dataset.'
    return

# 2. Verify QMD file was created
if not qmd_file.exists():
    generation_status[dataset_code]['status'] = 'failed'
    generation_status[dataset_code]['message'] = 'Dashboard template was not created'
    return

# 3. Fix Quarto output path
render_result = subprocess.run(
    ['quarto', 'render', str(qmd_file)],  # Let Quarto use project settings
    ...
)

# 4. Move file if created in wrong location
wrong_location = Path(f'site/_site/dashboards/dashboards/{dataset_code}_ai.html')
correct_location = Path(f'site/_site/dashboards/{dataset_code}_ai.html')
if wrong_location.exists():
    wrong_location.rename(correct_location)

# 5. Verify output exists
if not correct_location.exists():
    generation_status[dataset_code]['status'] = 'failed'
    return
```

---

## Problem 4: Unicode Errors (Emojis)

### Symptom:
```
UnicodeEncodeError: 'charmap' codec can't encode character '\u2713'
```

### Root Cause:
Windows console can't display emojis

### Solution:
Remove ALL emojis from:
- `print()` statements
- `typer.echo()` calls
- Console output

Use instead:
- `[OK]` instead of ✓
- `[ERROR]` instead of ✗
- `[WARN]` instead of ⚠️

---

## Problem 5: Server Not Running

### Symptom:
Browser shows "This site can't be reached"

### Root Cause:
Server process died or wasn't started

### Solution:
```bash
# Check if running
Get-Process python -ErrorAction SilentlyContinue

# Start server
py api_server.py

# Or use
START_SERVER.bat
```

### Prevention:
- Check server logs in terminals folder
- Monitor PID in server output
- Auto-restart on crash (future improvement)

---

## CLEAN HTML TEMPLATE

Save this to `site/_site/index.html`:

```html
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Data Catalog | AI Analytics Platform</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <style>
        @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap');
        body { font-family: 'Inter', sans-serif; }
        .gradient-bg { background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); }
        .card-hover { transition: all 0.3s ease; }
        .card-hover:hover { transform: translateY(-5px); box-shadow: 0 20px 40px -10px rgba(139, 92, 246, 0.3); }
    </style>
</head>
<body class="bg-gray-50">
    <!-- [FULL HTML CONTENT - See site/_site/index.html for complete version] -->
    <script>
        // JavaScript for dynamic catalog loading
        // Fetches catalog.json and renders datasets
    </script>
</body>
</html>
```

---

## CHECKLIST - Before Saying "It's Fixed"

- [ ] Visit http://localhost:5000 in browser
- [ ] Verify landing page shows properly (NO escaped HTML)
- [ ] Check dataset count shows 7,616
- [ ] Click a dataset
- [ ] Verify loading screen appears
- [ ] Wait for completion or error message
- [ ] Verify dashboard appears OR clear error shows
- [ ] Test search functionality
- [ ] Test category filtering
- [ ] Check browser console for errors

---

## FILES TO NEVER TOUCH

1. `site/_site/index.html` - Clean static HTML landing page
2. `site/_site/catalog.json` - Generated catalog metadata
3. `site/_site/report.html` - Loading page for on-demand generation

## FILES TO NEVER CREATE

1. `site/index.qmd` - Causes Quarto to regenerate index.html
2. Any QMD files in `site/` root - Keep dashboards in `site/dashboards/` only

---

## QUICK FIX COMMANDS

### Fix Landing Page:
```bash
Remove-Item site\index.qmd -Force -ErrorAction SilentlyContinue
Remove-Item site\_site\index.html -Force
# Then copy clean HTML from this document
```

### Regenerate Catalog:
```bash
py update_catalog.py
```

### Restart Server:
```bash
Get-Process python | Stop-Process -Force
py api_server.py
```

### Test Everything:
```bash
Start-Process "http://localhost:5000"
```

---

**USE THIS DOCUMENT BEFORE SAYING ANYTHING IS FIXED!**
