# 🌍 Procurement Intelligence Platform

**Multi-source government tender analytics • EU + US + Greece**

Real-time procurement dashboards aggregating data from TED (EU), SAM.gov (US), and Greek public procurement portals.

---

## **🚀 Quick Start:**

```bash
# Install dependencies
pip install -r requirements.txt

# Run the platform
python app.py
```

**Open:** http://localhost:8000

---

## **📊 Features:**

### **Live Dashboards:**
- ✅ **Tender Overview** - Browse all EU procurement opportunities
- ✅ **IT Tenders** - Software & cloud computing contracts
- ✅ **Country Analysis** - Trends by EU member state
- ✅ **Value Analysis** - Contract values and forecasts

### **REST API:**
```bash
# Search IT tenders in Germany
GET /api/search?country=DE&cpv_code=48&limit=10

# Get statistics
GET /api/stats?cpv_code=72
```

### **Data Sources:**
- **TED (EU):** 27 countries, €600B+ annually
- **SAM.gov (US):** $500B+ federal contracts (coming soon)
- **Greece:** KIMDIS + Diavgeia (coming soon)

---

## **🎯 Use Cases:**

1. **SMEs:** Find government contract opportunities
2. **Consultants:** Market intelligence for clients
3. **Bid Managers:** Competitive analysis
4. **Researchers:** Procurement trend analysis

---

## **💡 Example Queries:**

```python
# Find cloud computing tenders over €100K
GET /api/search?cpv_code=48&min_value=100000

# Get Germany IT statistics
GET /api/stats?country=DE&cpv_code=72

# All construction tenders
GET /api/search?cpv_code=45&limit=100
```

---

## **📖 API Documentation:**

Visit `/docs` for interactive API documentation (Swagger UI).

---

## **🔧 Configuration:**

Edit `config.yml` to:
- Add API keys for TED, SAM.gov
- Configure cache settings
- Customize filters and categories

---

## **🚢 Deployment:**

### **Railway:**
```bash
# Deploy to Railway
railway up
```

### **Docker:**
```bash
# Build image
docker build -t procurement-dash .

# Run container
docker run -p 8000:8000 procurement-dash
```

---

## **💰 Business Model:**

### **Free Tier:**
- Basic dashboards
- 10 API requests/day
- 7-day data history

### **Pro ($49/month):**
- Unlimited searches
- Email alerts
- 90-day history
- CSV exports

### **Enterprise ($199/month):**
- API access
- Custom dashboards
- 5-year history
- Competitive intelligence

---

## **🎯 Roadmap:**

- [x] TED (EU) integration
- [ ] SAM.gov (US) integration
- [ ] Greece KIMDIS connector
- [ ] Email alert system
- [ ] Company profiling
- [ ] Tender forecasting

---

## **📊 Sample Data:**

The platform includes sample procurement data for testing. For production use with real data:

1. Get TED API key: https://developer.ted.europa.eu
2. Get SAM.gov API key: https://sam.gov
3. Add keys to `config.yml` or environment variables

---

## **🤝 Contributing:**

Contributions welcome! Areas for improvement:
- Additional data sources
- New dashboard types
- Analytics features
- Documentation

---

## **📝 License:**

MIT License - See LICENSE file

---

## **🌟 Built With:**

- **FastAPI** - Web framework
- **Pandas** - Data processing
- **Plotly** - Interactive visualizations
- **TED API** - EU procurement data

---

**Transform government procurement data into actionable business intelligence!** 🚀
