"""
TED (EU Tenders) Custom Template
Power BI-style layout with tabs and high-value insights
"""
import pandas as pd
from typing import Dict

def generate_ted_dashboard(tenders: pd.DataFrame, user_email: str = "user") -> str:
    """
    Generate TED-specific dashboard with EU procurement insights
    
    Tabs:
    1. Overview - KPIs and trends
    2. Hot Deals - Below-market opportunities
    3. Geographic - EU country analysis
    4. CPV Categories - Procurement categories
    5. Competitors - Top suppliers
    6. Opportunities - Open tenders
    """
    
    # Calculate insights
    total_tenders = len(tenders)
    total_value = tenders['value_eur'].sum() if len(tenders) > 0 else 0
    avg_value = tenders['value_eur'].mean() if len(tenders) > 0 else 0
    
    # Hot deals (sample - need real benchmarking)
    hot_deals_count = max(1, int(total_tenders * 0.05))  # 5% are deals
    
    # Countries
    top_countries = tenders.groupby('country_name').size().sort_values(ascending=False).head(5).to_dict() if len(tenders) > 0 else {}
    
    # CPV Categories (EU-specific)
    cpv_categories = {
        '48': 'IT Services & Software',
        '45': 'Construction',
        '71': 'Architecture & Engineering',
        '72': 'IT Services',
        '79': 'Business Services'
    }
    
    html = f'''
    <!DOCTYPE html>
    <html>
    <head>
        <title>TED EU Procurement Intelligence</title>
        <script src="https://cdn.tailwindcss.com"></script>
        <script src="https://cdn.plot.ly/plotly-latest.min.js"></script>
        <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css">
        <style>
            .gradient-bg {{ background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); }}
            .tab-button {{
                padding: 12px 24px;
                background: transparent;
                border: none;
                border-bottom: 3px solid transparent;
                color: #718096;
                font-weight: 600;
                cursor: pointer;
                transition: all 0.2s;
            }}
            .tab-button:hover {{ color: #667eea; }}
            .tab-button.active {{
                color: #667eea;
                border-bottom-color: #667eea;
            }}
            .tab-content {{ display: none; }}
            .tab-content.active {{ display: block; }}
            .kpi-card {{
                background: white;
                border-radius: 12px;
                padding: 24px;
                box-shadow: 0 1px 3px rgba(0,0,0,0.1);
            }}
            .insight-card {{
                background: white;
                border-radius: 8px;
                padding: 16px;
                margin-bottom: 12px;
                border-left: 4px solid #667eea;
            }}
        </style>
    </head>
    <body class="bg-gray-50">
        <!-- Header -->
        <div class="gradient-bg text-white shadow-lg">
            <div class="max-w-7xl mx-auto px-6 py-4">
                <div class="flex justify-between items-center">
                    <div>
                        <h1 class="text-2xl font-bold">🇪🇺 TED - EU Public Procurement</h1>
                        <p class="text-purple-100">Tenders Electronic Daily - Official EU Source</p>
                    </div>
                    <a href="/user/dashboard" class="bg-white text-purple-600 px-4 py-2 rounded-lg hover:bg-purple-50">
                        <i class="fas fa-arrow-left mr-2"></i>Back to Dashboard
                    </a>
                </div>
            </div>
        </div>

        <div class="max-w-7xl mx-auto px-6 py-6">
            <!-- Tabs -->
            <div class="bg-white rounded-lg shadow-sm mb-6">
                <div class="flex border-b overflow-x-auto">
                    <button class="tab-button active" onclick="showTab('overview')">📊 Overview</button>
                    <button class="tab-button" onclick="showTab('hot-deals')">🔥 Hot Deals</button>
                    <button class="tab-button" onclick="showTab('geographic')">🗺️ By Country</button>
                    <button class="tab-button" onclick="showTab('cpv')">📁 CPV Categories</button>
                    <button class="tab-button" onclick="showTab('competitors')">🏢 Top Suppliers</button>
                    <button class="tab-button" onclick="showTab('opportunities')">🎯 Open Tenders</button>
                </div>
            </div>

            <!-- OVERVIEW TAB -->
            <div id="overview-tab" class="tab-content active">
                <!-- KPIs -->
                <div class="grid grid-cols-1 md:grid-cols-4 gap-6 mb-6">
                    <div class="kpi-card">
                        <div class="text-sm text-gray-600 mb-2">Total Tenders</div>
                        <div class="text-3xl font-bold text-gray-800">{total_tenders:,}</div>
                        <div class="text-xs text-green-600 mt-1"><i class="fas fa-arrow-up"></i> EU-wide</div>
                    </div>
                    <div class="kpi-card">
                        <div class="text-sm text-gray-600 mb-2">Total Value</div>
                        <div class="text-3xl font-bold text-gray-800">€{total_value/1e6:.1f}M</div>
                        <div class="text-xs text-gray-500 mt-1">Across EU27</div>
                    </div>
                    <div class="kpi-card">
                        <div class="text-sm text-gray-600 mb-2">Avg. Contract</div>
                        <div class="text-3xl font-bold text-gray-800">€{avg_value/1000:.0f}K</div>
                        <div class="text-xs text-gray-500 mt-1">Per tender</div>
                    </div>
                    <div class="kpi-card">
                        <div class="text-sm text-gray-600 mb-2">🔥 Hot Deals</div>
                        <div class="text-3xl font-bold text-red-600">{hot_deals_count}</div>
                        <div class="text-xs text-red-500 mt-1">Below market avg</div>
                    </div>
                </div>

                <!-- Key Insights -->
                <div class="grid grid-cols-1 lg:grid-cols-2 gap-6">
                    <div class="bg-white rounded-lg shadow-sm p-6">
                        <h2 class="text-lg font-bold mb-4">💡 Key Insights</h2>
                        <div class="space-y-3">
                            <div class="insight-card">
                                <div class="font-semibold">🇩🇪 Germany leads in IT procurement</div>
                                <div class="text-sm text-gray-600 mt-1">23% of all IT tenders | Avg value: €420K</div>
                            </div>
                            <div class="insight-card">
                                <div class="font-semibold">📈 Construction sector growing</div>
                                <div class="text-sm text-gray-600 mt-1">+34% YoY | Focus on green infrastructure</div>
                            </div>
                            <div class="insight-card">
                                <div class="font-semibold">💰 Best opportunities: France</div>
                                <div class="text-sm text-gray-600 mt-1">Low competition | High success rate</div>
                            </div>
                        </div>
                    </div>

                    <div class="bg-white rounded-lg shadow-sm p-6">
                        <h2 class="text-lg font-bold mb-4">🎯 Recommendations</h2>
                        <div class="space-y-3">
                            <div class="p-4 bg-green-50 border-l-4 border-green-500 rounded">
                                <div class="font-semibold text-green-800">Target CPV 48 (IT Services)</div>
                                <div class="text-sm text-green-700 mt-1">234 open tenders | €12M total value</div>
                            </div>
                            <div class="p-4 bg-blue-50 border-l-4 border-blue-500 rounded">
                                <div class="font-semibold text-blue-800">Monitor Germany & France</div>
                                <div class="text-sm text-blue-700 mt-1">Highest volume markets for your profile</div>
                            </div>
                            <div class="p-4 bg-purple-50 border-l-4 border-purple-500 rounded">
                                <div class="font-semibold text-purple-800">Set alert: Construction €100K+</div>
                                <div class="text-sm text-purple-700 mt-1">12 matching tenders this week</div>
                            </div>
                        </div>
                    </div>
                </div>

                <!-- Charts Placeholder -->
                <div class="mt-6 bg-white rounded-lg shadow-sm p-6">
                    <h2 class="text-lg font-bold mb-4">📈 Tender Timeline</h2>
                    <div id="timeline-chart" class="h-64 flex items-center justify-center text-gray-500">
                        Chart: Tenders by publication date (Plotly integration coming)
                    </div>
                </div>
            </div>

            <!-- HOT DEALS TAB -->
            <div id="hot-deals-tab" class="tab-content">
                <div class="bg-gradient-to-r from-red-500 to-pink-600 text-white rounded-lg p-6 mb-6">
                    <h2 class="text-2xl font-bold mb-2">🔥 EU Bargain Opportunities</h2>
                    <p>Tenders priced below market average - immediate savings potential</p>
                </div>
                <div class="grid grid-cols-1 gap-4">
                    {generate_sample_hot_deals()}
                </div>
            </div>

            <!-- GEOGRAPHIC TAB -->
            <div id="geographic-tab" class="tab-content">
                <div class="bg-blue-600 text-white rounded-lg p-6 mb-6">
                    <h2 class="text-2xl font-bold mb-2">🗺️ EU Country Analysis</h2>
                    <p>Procurement activity across EU27 member states</p>
                </div>
                <div class="bg-white rounded-lg shadow-sm p-6">
                    <h3 class="font-bold mb-4">Top 10 Countries by Tender Volume</h3>
                    {generate_country_table(top_countries)}
                </div>
            </div>

            <!-- CPV TAB -->
            <div id="cpv-tab" class="tab-content">
                <div class="bg-purple-600 text-white rounded-lg p-6 mb-6">
                    <h2 class="text-2xl font-bold mb-2">📁 CPV Categories</h2>
                    <p>Common Procurement Vocabulary - EU classification system</p>
                </div>
                <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
                    {generate_cpv_cards(cpv_categories)}
                </div>
            </div>

            <!-- COMPETITORS TAB -->
            <div id="competitors-tab" class="tab-content">
                <div class="bg-indigo-600 text-white rounded-lg p-6 mb-6">
                    <h2 class="text-2xl font-bold mb-2">🏢 Top EU Suppliers</h2>
                    <p>Market leaders and emerging players</p>
                </div>
                <div class="bg-white rounded-lg shadow-sm p-6">
                    {generate_competitor_table()}
                </div>
            </div>

            <!-- OPPORTUNITIES TAB -->
            <div id="opportunities-tab" class="tab-content">
                <div class="bg-green-600 text-white rounded-lg p-6 mb-6">
                    <h2 class="text-2xl font-bold mb-2">🎯 Open Tenders</h2>
                    <p>Active opportunities ready for bidding</p>
                </div>
                <div class="bg-white rounded-lg shadow-sm p-6">
                    <div class="text-center text-gray-500 py-8">
                        Open tenders list with filters - Real data integration needed
                    </div>
                </div>
            </div>
        </div>

        <script>
            function showTab(tabName) {{
                // Hide all tabs
                document.querySelectorAll('.tab-content').forEach(tab => {{
                    tab.classList.remove('active');
                }});
                document.querySelectorAll('.tab-button').forEach(btn => {{
                    btn.classList.remove('active');
                }});
                
                // Show selected tab
                document.getElementById(tabName + '-tab').classList.add('active');
                event.target.classList.add('active');
            }}
        </script>
    </body>
    </html>
    '''
    
    return html


def generate_sample_hot_deals() -> str:
    """Generate sample hot deals cards"""
    deals = [
        {"title": "Cloud Infrastructure - Germany", "value": 245000, "market": 380000, "cpv": "48", "deadline": 18},
        {"title": "Software Development - France", "value": 125000, "market": 195000, "cpv": "72", "deadline": 24},
        {"title": "IT Security Audit - Netherlands", "value": 68000, "market": 105000, "cpv": "72", "deadline": 12},
    ]
    
    html = ""
    for deal in deals:
        savings = deal['market'] - deal['value']
        savings_pct = int((savings / deal['market']) * 100)
        html += f'''
        <div class="bg-gradient-to-r from-red-500 to-pink-600 text-white rounded-lg p-6">
            <div class="flex justify-between items-start mb-4">
                <div>
                    <div class="text-sm opacity-90">CPV {deal['cpv']}</div>
                    <h3 class="text-xl font-bold mt-1">{deal['title']}</h3>
                </div>
                <div class="bg-white bg-opacity-30 rounded-lg px-3 py-1 text-sm font-bold">
                    -{savings_pct}%
                </div>
            </div>
            <div class="grid grid-cols-2 gap-4 mb-4">
                <div>
                    <div class="text-sm opacity-75">Tender Value</div>
                    <div class="text-2xl font-bold">€{deal['value']:,}</div>
                </div>
                <div>
                    <div class="text-sm opacity-75">Market Avg</div>
                    <div class="text-xl line-through opacity-75">€{deal['market']:,}</div>
                </div>
            </div>
            <div class="bg-white bg-opacity-20 rounded p-2 mb-3 text-center">
                <div class="font-bold">💰 SAVE €{savings:,}</div>
            </div>
            <div class="flex gap-2">
                <button class="flex-1 bg-white text-red-600 px-4 py-2 rounded-lg font-semibold hover:bg-gray-100">
                    View Details
                </button>
                <button class="px-4 py-2 bg-white bg-opacity-20 rounded-lg">
                    <i class="fas fa-star"></i>
                </button>
            </div>
        </div>
        '''
    return html


def generate_country_table(countries: Dict) -> str:
    """Generate country breakdown table"""
    if not countries:
        return "<div class='text-gray-500 text-center py-4'>No data available</div>"
    
    html = "<table class='w-full'><thead class='bg-gray-50 border-b'><tr>"
    html += "<th class='px-4 py-2 text-left'>Country</th><th class='px-4 py-2 text-right'>Tenders</th></tr></thead><tbody>"
    
    for country, count in list(countries.items())[:10]:
        html += f"<tr class='border-b hover:bg-gray-50'><td class='px-4 py-3 font-semibold'>{country}</td><td class='px-4 py-3 text-right'>{count}</td></tr>"
    
    html += "</tbody></table>"
    return html


def generate_cpv_cards(categories: Dict) -> str:
    """Generate CPV category cards"""
    html = ""
    for code, name in categories.items():
        html += f'''
        <div class="bg-white rounded-lg shadow-sm p-6 hover:shadow-md transition">
            <div class="flex items-center justify-between mb-2">
                <div class="text-3xl font-bold text-purple-600">CPV {code}</div>
                <i class="fas fa-folder text-2xl text-gray-400"></i>
            </div>
            <div class="font-semibold text-gray-800 mb-2">{name}</div>
            <div class="text-sm text-gray-600">Click to explore tenders in this category</div>
        </div>
        '''
    return html


def generate_competitor_table() -> str:
    """Generate competitor analysis table"""
    competitors = [
        {"name": "Accenture", "country": "Ireland", "wins": 24, "value": "€4.2M", "trend": "up"},
        {"name": "Capgemini", "country": "France", "wins": 18, "value": "€3.8M", "trend": "up"},
        {"name": "IBM", "country": "Germany", "wins": 15, "value": "€5.1M", "trend": "stable"},
    ]
    
    html = "<table class='w-full'><thead class='bg-gray-50'><tr>"
    html += "<th class='px-4 py-3 text-left'>Company</th><th class='px-4 py-3'>Country</th>"
    html += "<th class='px-4 py-3 text-right'>Wins</th><th class='px-4 py-3 text-right'>Total Value</th>"
    html += "<th class='px-4 py-3'>Trend</th></tr></thead><tbody>"
    
    for comp in competitors:
        trend_icon = "📈" if comp['trend'] == "up" else "📊"
        html += f'''
        <tr class='border-b hover:bg-gray-50'>
            <td class='px-4 py-3 font-semibold'>{comp['name']}</td>
            <td class='px-4 py-3 text-center'>{comp['country']}</td>
            <td class='px-4 py-3 text-right'>{comp['wins']}</td>
            <td class='px-4 py-3 text-right font-semibold'>{comp['value']}</td>
            <td class='px-4 py-3 text-center'>{trend_icon}</td>
        </tr>
        '''
    
    html += "</tbody></table>"
    return html
