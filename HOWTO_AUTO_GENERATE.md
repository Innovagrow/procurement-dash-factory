# ✅ Auto-Generate Reports with AI

## What Happens Now

When a user clicks on **any dataset**, the system will:

1. **✓ Check if report exists** - Instant load if pre-generated
2. **✓ Auto-trigger AI analysis** - If not, starts generation automatically
3. **✓ Analyze data structure** - AI examines the dataset
4. **✓ Propose optimal insights** - AI determines best insights to show
5. **✓ Design report structure** - AI creates the best layout
6. **✓ Generate visualizations** - Creates interactive charts
7. **✓ Build dashboard** - Renders complete report
8. **✓ Auto-redirect** - Shows the finished report

**No manual commands needed!** Everything happens automatically.

## How to Start the Auto-Generation Server

### Option 1: Quick Start (Windows)
```bash
START_SERVER.bat
```

### Option 2: Manual Start
```bash
# Install API dependencies
py -m pip install flask flask-cors

# Start the server
py api_server.py
```

### Option 3: Keep Using Static Server
If you don't want auto-generation, keep using:
```bash
py -m http.server 4308 --directory site\_site
```
Users will see instructions to generate manually.

## AI Components Used

The system uses these AI modules:

### 1. **AI Insights** (`eurodash/ai_insights.py`)
- Analyzes data structure
- Identifies trends, anomalies, correlations
- Proposes key metrics
- Recommends visualizations

### 2. **AI Planner** (`eurodash/ai_planner.py`)
- Creates intelligent dashboard layout
- Groups visualizations by theme (Overview, Trends, Comparison, Details)
- Prioritizes insights by importance
- Designs optimal report structure

### 3. **Forecasting** (`eurodash/forecasting.py`)
- Predictive analytics
- Trend projections
- Confidence intervals

### 4. **Anomaly Detection** (`eurodash/anomaly_detection.py`)
- Flags unusual data points
- Z-score and IQR methods
- Time series anomalies

## Example User Flow

```
User clicks: "Balance of Payments - Q1 2025"
    ↓
[Animated loading screen appears]
    ↓
AI analyzes:
  ✓ Found 4,521 observations
  ✓ Detected quarterly time series
  ✓ Identified 3 anomalies
  ✓ Forecasted next 6 quarters
  ✓ Recommended: Line chart + Bar chart + Table
    ↓
[Progress: 100%]
    ↓
Dashboard displays with:
  - KPI cards
  - AI-generated insights
  - Interactive charts
  - Forecasts
  - Anomaly highlights
```

## Server URLs

### With Auto-Generation API:
```
Main Site: http://localhost:5000/
API Endpoint: http://localhost:5000/api/generate-dashboard?dataset=CODE
```

### With Static Server:
```
Main Site: http://localhost:4308/
Manual generation required
```

## Manual Generation (If Needed)

You can still manually generate any report:

```bash
# Single dataset
py -m eurodash ai-run --datasets nama_10_gdp

# Multiple datasets
py -m eurodash ai-run --datasets nama_10_gdp prc_hicp_midx ei_bpm6ca_q

# All datasets in a category (batch)
py -m eurodash ai-run --mode keyword --keyword "gdp" --n 10
```

## Features

✅ **On-Demand Generation** - Reports created when needed  
✅ **AI-Powered Analysis** - Smart insights and structure  
✅ **Real-time Progress** - Live status updates  
✅ **Caching** - Generated reports are saved  
✅ **Parallel Safe** - Multiple users can generate at once  
✅ **Auto-redirect** - Seamless user experience  

## Technical Details

### Generation Pipeline:
1. `api_server.py` receives request
2. Spawns background thread
3. Calls `py -m eurodash ai-run --datasets CODE`
4. Pipeline runs:
   - `catalog.py` - Metadata
   - `ingest.py` - Fetch data from API
   - `ai_insights.py` - AI analysis
   - `ai_planner.py` - Structure design
   - `ai_render.py` - Dashboard creation
5. Saves to `site/_site/dashboards/CODE_ai.html`
6. Returns URL to frontend
7. Frontend auto-redirects

### Performance:
- **Pre-generated reports**: < 1 second (instant redirect)
- **New reports**: 30-90 seconds (depending on dataset size)
- **Cached after first generation**

---

**Run `START_SERVER.bat` to enable automatic AI-powered report generation!**
