"""
Enhanced User Dashboard with High-Value Features
Includes: Bargain Detection, Competitor Intel, Sidebars, etc.
"""
from typing import Dict, List
import random
from datetime import datetime, timedelta

def generate_enhanced_dashboard(user_email: str, username: str = "User") -> str:
    """Generate enhanced dashboard with all high-value features"""
    
    # Sample data (replace with real data from database)
    hot_deals = [
        {
            "id": "TD-2024-001",
            "title": "Cloud Infrastructure Services",
            "value": 145000,
            "market_avg": 230000,
            "savings_pct": 37,
            "country": "Germany",
            "deadline_days": 14,
            "bidders": 3,
            "match_score": 92
        },
        {
            "id": "TD-2024-002",
            "title": "Software Development Framework",
            "value": 89000,
            "market_avg": 125000,
            "savings_pct": 29,
            "country": "France",
            "deadline_days": 21,
            "bidders": 5,
            "match_score": 88
        },
        {
            "id": "TD-2024-003",
            "title": "IT Security Audit Services",
            "value": 56000,
            "market_avg": 82000,
            "savings_pct": 32,
            "country": "Netherlands",
            "deadline_days": 10,
            "bidders": 2,
            "match_score": 95
        }
    ]
    
    perfect_matches = [
        {"id": "PM-001", "title": "Database Migration Project", "match": 96, "value": 185000, "competition": "Low"},
        {"id": "PM-002", "title": "ERP System Implementation", "match": 94, "value": 420000, "competition": "Medium"},
        {"id": "PM-003", "title": "Mobile App Development", "match": 91, "value": 95000, "competition": "Low"},
    ]
    
    competitors = [
        {"name": "TechCorp Solutions", "wins": 12, "total_value": "€2.4M", "avg_value": "€200K", "trend": "up"},
        {"name": "Global IT Services", "wins": 8, "total_value": "€1.8M", "avg_value": "€225K", "trend": "up"},
        {"name": "Digital Innovations Ltd", "wins": 15, "total_value": "€1.2M", "avg_value": "€80K", "trend": "stable"},
    ]
    
    html = f'''
    <!DOCTYPE html>
    <html lang="en">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Dashboard - Procurement Intelligence</title>
        <script src="https://cdn.tailwindcss.com"></script>
        <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css">
        <style>
            * {{ margin: 0; padding: 0; box-sizing: border-box; }}
            body {{ font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif; }}
            .gradient-bg {{ background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); }}
            .sidebar {{ 
                width: 260px; 
                height: 100vh; 
                position: fixed; 
                left: 0; 
                top: 0; 
                background: #1a1d29; 
                color: white;
                overflow-y: auto;
                z-index: 1000;
            }}
            .main-content {{ 
                margin-left: 260px; 
                min-height: 100vh;
                background: #f5f7fa;
            }}
            .sidebar-item {{
                padding: 12px 20px;
                display: flex;
                align-items: center;
                gap: 12px;
                color: #a0aec0;
                text-decoration: none;
                transition: all 0.2s;
                cursor: pointer;
            }}
            .sidebar-item:hover, .sidebar-item.active {{
                background: #2d3748;
                color: white;
            }}
            .sidebar-item .badge {{
                margin-left: auto;
                background: #e53e3e;
                color: white;
                padding: 2px 8px;
                border-radius: 10px;
                font-size: 0.75rem;
            }}
            .kpi-card {{
                background: white;
                border-radius: 12px;
                padding: 24px;
                box-shadow: 0 1px 3px rgba(0,0,0,0.1);
                transition: transform 0.2s, box-shadow 0.2s;
            }}
            .kpi-card:hover {{
                transform: translateY(-2px);
                box-shadow: 0 4px 12px rgba(0,0,0,0.15);
            }}
            .hot-deal-card {{
                background: linear-gradient(135deg, #ff6b6b 0%, #ee5a6f 100%);
                color: white;
                border-radius: 12px;
                padding: 20px;
                margin-bottom: 16px;
                position: relative;
                overflow: hidden;
                box-shadow: 0 4px 12px rgba(238, 90, 111, 0.3);
            }}
            .hot-deal-badge {{
                position: absolute;
                top: 10px;
                right: 10px;
                background: rgba(255,255,255,0.3);
                padding: 6px 12px;
                border-radius: 20px;
                font-size: 0.85rem;
                font-weight: bold;
            }}
            .match-card {{
                background: white;
                border-radius: 12px;
                padding: 20px;
                margin-bottom: 16px;
                border-left: 4px solid #48bb78;
                box-shadow: 0 1px 3px rgba(0,0,0,0.1);
            }}
            .progress-bar {{
                background: #e2e8f0;
                height: 8px;
                border-radius: 4px;
                overflow: hidden;
                margin-top: 8px;
            }}
            .progress-fill {{
                background: linear-gradient(90deg, #667eea, #764ba2);
                height: 100%;
                transition: width 0.3s;
            }}
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
            .tab-button:hover {{
                color: #667eea;
            }}
            .tab-button.active {{
                color: #667eea;
                border-bottom-color: #667eea;
            }}
            .tab-content {{
                display: none;
            }}
            .tab-content.active {{
                display: block;
            }}
            @media (max-width: 1024px) {{
                .sidebar {{ transform: translateX(-100%); }}
                .main-content {{ margin-left: 0; }}
            }}
        </style>
    </head>
    <body>
        <!-- LEFT SIDEBAR -->
        <div class="sidebar">
            <div class="p-6 border-b border-gray-700">
                <div class="flex items-center gap-3">
                    <div class="w-10 h-10 gradient-bg rounded-lg flex items-center justify-center text-xl">
                        🎯
                    </div>
                    <div>
                        <div class="font-bold text-white">ProIntel</div>
                        <div class="text-xs text-gray-400">Procurement Intelligence</div>
                    </div>
                </div>
            </div>

            <!-- Navigation -->
            <div class="py-4">
                <a href="#" class="sidebar-item active" onclick="showTab('overview')">
                    <i class="fas fa-home"></i>
                    <span>Dashboard</span>
                </a>
                <a href="#" class="sidebar-item" onclick="showTab('hot-deals')">
                    <i class="fas fa-fire"></i>
                    <span>Hot Deals</span>
                    <span class="badge">{len(hot_deals)}</span>
                </a>
                <a href="#" class="sidebar-item" onclick="showTab('matches')">
                    <i class="fas fa-bullseye"></i>
                    <span>Perfect Matches</span>
                    <span class="badge">{len(perfect_matches)}</span>
                </a>
                <a href="#" class="sidebar-item" onclick="showTab('watchlist')">
                    <i class="fas fa-star"></i>
                    <span>My Watchlist</span>
                </a>
                <a href="#" class="sidebar-item" onclick="showTab('bids')">
                    <i class="fas fa-file-invoice"></i>
                    <span>My Bids</span>
                </a>
                
                <div class="border-t border-gray-700 my-3"></div>
                
                <a href="#" class="sidebar-item" onclick="navigateWithToken('/user/alerts')">
                    <i class="fas fa-bell"></i>
                    <span>Alerts</span>
                    <span class="badge">3</span>
                </a>
                <a href="#" class="sidebar-item" onclick="showTab('ai-assistant')">
                    <i class="fas fa-robot"></i>
                    <span>AI Assistant</span>
                </a>
                <a href="#" class="sidebar-item" onclick="showTab('market-intel')">
                    <i class="fas fa-chart-line"></i>
                    <span>Market Intel</span>
                </a>
                <a href="#" class="sidebar-item" onclick="showTab('competitors')">
                    <i class="fas fa-building"></i>
                    <span>Competitors</span>
                </a>
                
                <div class="border-t border-gray-700 my-3"></div>
                
                <a href="#" class="sidebar-item" onclick="navigateWithToken('/user/settings')">
                    <i class="fas fa-cog"></i>
                    <span>Settings</span>
                </a>
                <a href="#" class="sidebar-item" onclick="logout()">
                    <i class="fas fa-sign-out-alt"></i>
                    <span>Logout</span>
                </a>
            </div>

            <!-- User Info at Bottom -->
            <div class="absolute bottom-0 left-0 right-0 p-4 border-t border-gray-700 bg-gray-900">
                <div class="flex items-center gap-3">
                    <div class="w-10 h-10 bg-purple-600 rounded-full flex items-center justify-center">
                        <i class="fas fa-user"></i>
                    </div>
                    <div class="flex-1 min-w-0">
                        <div class="text-sm font-semibold text-white truncate">{username}</div>
                        <div class="text-xs text-gray-400 truncate">{user_email}</div>
                    </div>
                </div>
            </div>
        </div>

        <!-- MAIN CONTENT -->
        <div class="main-content">
            <!-- Top Bar -->
            <div class="bg-white shadow-sm border-b sticky top-0 z-50">
                <div class="max-w-7xl mx-auto px-6 py-4">
                    <div class="flex items-center justify-between">
                        <h1 class="text-2xl font-bold text-gray-800">
                            <span id="page-title">Dashboard Overview</span>
                        </h1>
                        <div class="flex items-center gap-4">
                            <button onclick="openSearchModal()" class="px-4 py-2 bg-purple-600 text-white rounded-lg hover:bg-purple-700 flex items-center gap-2">
                                <i class="fas fa-search"></i>
                                Search Tenders
                            </button>
                            <button onclick="exportData()" class="px-4 py-2 border border-gray-300 rounded-lg hover:bg-gray-50 flex items-center gap-2">
                                <i class="fas fa-download"></i>
                                Export Data
                            </button>
                        </div>
                    </div>
                </div>
            </div>

            <div class="max-w-7xl mx-auto px-6 py-8">
                <!-- OVERVIEW TAB -->
                <div id="overview-tab" class="tab-content active">
                    <!-- KPI Cards -->
                    <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6 mb-8">
                        <div class="kpi-card">
                            <div class="flex items-center justify-between mb-2">
                                <span class="text-gray-600 text-sm font-semibold">🔥 Hot Deals Today</span>
                                <span class="text-green-500"><i class="fas fa-arrow-up"></i> 23%</span>
                            </div>
                            <div class="text-3xl font-bold text-gray-800">{len(hot_deals)}</div>
                            <div class="text-xs text-gray-500 mt-1">Total savings: €296K</div>
                        </div>

                        <div class="kpi-card">
                            <div class="flex items-center justify-between mb-2">
                                <span class="text-gray-600 text-sm font-semibold">🎯 Perfect Matches</span>
                                <span class="text-blue-500"><i class="fas fa-arrow-up"></i> 8%</span>
                            </div>
                            <div class="text-3xl font-bold text-gray-800">{len(perfect_matches)}</div>
                            <div class="text-xs text-gray-500 mt-1">Avg. match: 94%</div>
                        </div>

                        <div class="kpi-card">
                            <div class="flex items-center justify-between mb-2">
                                <span class="text-gray-600 text-sm font-semibold">⏰ Deadlines This Week</span>
                                <span class="text-orange-500"><i class="fas fa-exclamation"></i></span>
                            </div>
                            <div class="text-3xl font-bold text-gray-800">5</div>
                            <div class="text-xs text-gray-500 mt-1">Earliest: 2 days</div>
                        </div>

                        <div class="kpi-card">
                            <div class="flex items-center justify-between mb-2">
                                <span class="text-gray-600 text-sm font-semibold">📊 Total Opportunities</span>
                                <span class="text-gray-400"><i class="fas fa-equals"></i></span>
                            </div>
                            <div class="text-3xl font-bold text-gray-800">234</div>
                            <div class="text-xs text-gray-500 mt-1">Active tenders</div>
                        </div>
                    </div>

                    <!-- Quick Overview Sections -->
                    <div class="grid grid-cols-1 lg:grid-cols-2 gap-6">
                        <!-- Top Hot Deals Preview -->
                        <div class="bg-white rounded-lg shadow-sm p-6">
                            <div class="flex items-center justify-between mb-4">
                                <h2 class="text-lg font-bold">🔥 Top Hot Deals</h2>
                                <a href="#" onclick="showTab('hot-deals')" class="text-purple-600 hover:text-purple-700 text-sm font-semibold">View All →</a>
                            </div>
                            <div class="space-y-3">
                                {generate_hot_deal_preview(hot_deals[:2])}
                            </div>
                        </div>

                        <!-- Top Matches Preview -->
                        <div class="bg-white rounded-lg shadow-sm p-6">
                            <div class="flex items-center justify-between mb-4">
                                <h2 class="text-lg font-bold">🎯 Top Matches</h2>
                                <a href="#" onclick="showTab('matches')" class="text-purple-600 hover:text-purple-700 text-sm font-semibold">View All →</a>
                            </div>
                            <div class="space-y-3">
                                {generate_match_preview(perfect_matches[:2])}
                            </div>
                        </div>
                    </div>

                    <!-- Browse Reports -->
                    <div class="mt-6 bg-white rounded-lg shadow-sm p-6">
                        <div class="flex items-center justify-between mb-4">
                            <h2 class="text-lg font-bold">📊 Trending Reports</h2>
                            <button onclick="showTab('market-intel')" class="text-purple-600 hover:text-purple-700 text-sm font-semibold">
                                View All →
                            </button>
                        </div>
                        <div class="grid grid-cols-1 md:grid-cols-3 gap-4">
                            <div onclick="viewTenderDetails('TD-2024-001')" class="border rounded-lg p-4 hover:shadow-lg transition cursor-pointer">
                                <div class="flex items-center gap-2 mb-2">
                                    <span class="text-2xl">🇩🇪</span>
                                    <div>
                                        <div class="font-semibold text-gray-800">Cloud Infrastructure</div>
                                        <div class="text-xs text-gray-500">Germany • IT Services</div>
                                    </div>
                                </div>
                                <div class="text-sm text-gray-600 mt-2">€145,000</div>
                                <div class="mt-2 flex items-center gap-2">
                                    <span class="text-xs bg-red-100 text-red-600 px-2 py-1 rounded">🔥 Hot Deal</span>
                                    <span class="text-xs bg-green-100 text-green-600 px-2 py-1 rounded">92% Match</span>
                                </div>
                            </div>
                            <div onclick="viewTenderDetails('TD-2024-002')" class="border rounded-lg p-4 hover:shadow-lg transition cursor-pointer">
                                <div class="flex items-center gap-2 mb-2">
                                    <span class="text-2xl">🇫🇷</span>
                                    <div>
                                        <div class="font-semibold text-gray-800">Software Development</div>
                                        <div class="text-xs text-gray-500">France • Development</div>
                                    </div>
                                </div>
                                <div class="text-sm text-gray-600 mt-2">€89,000</div>
                                <div class="mt-2 flex items-center gap-2">
                                    <span class="text-xs bg-red-100 text-red-600 px-2 py-1 rounded">🔥 Hot Deal</span>
                                    <span class="text-xs bg-green-100 text-green-600 px-2 py-1 rounded">88% Match</span>
                                </div>
                            </div>
                            <div onclick="viewTenderDetails('TD-2024-003')" class="border rounded-lg p-4 hover:shadow-lg transition cursor-pointer">
                                <div class="flex items-center gap-2 mb-2">
                                    <span class="text-2xl">🇳🇱</span>
                                    <div>
                                        <div class="font-semibold text-gray-800">IT Security Audit</div>
                                        <div class="text-xs text-gray-500">Netherlands • Security</div>
                                    </div>
                                </div>
                                <div class="text-sm text-gray-600 mt-2">€56,000</div>
                                <div class="mt-2 flex items-center gap-2">
                                    <span class="text-xs bg-red-100 text-red-600 px-2 py-1 rounded">🔥 Hot Deal</span>
                                    <span class="text-xs bg-green-100 text-green-600 px-2 py-1 rounded">95% Match</span>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>

                <!-- HOT DEALS TAB -->
                <div id="hot-deals-tab" class="tab-content">
                    <div class="mb-6">
                        <div class="bg-gradient-to-r from-red-500 to-pink-600 text-white rounded-lg p-6 shadow-lg">
                            <h2 class="text-2xl font-bold mb-2">🔥 Hot Deals - Bargain Opportunities!</h2>
                            <p class="text-red-100">These tenders are priced significantly BELOW market average. Act fast!</p>
                        </div>
                    </div>

                    {generate_hot_deals_section(hot_deals)}
                </div>

                <!-- PERFECT MATCHES TAB -->
                <div id="matches-tab" class="tab-content">
                    <div class="mb-6">
                        <div class="gradient-bg text-white rounded-lg p-6 shadow-lg">
                            <h2 class="text-2xl font-bold mb-2">🎯 Perfect Matches For You</h2>
                            <p class="text-purple-100">These tenders match your profile, capabilities, and past wins</p>
                        </div>
                    </div>

                    {generate_matches_section(perfect_matches)}
                </div>

                <!-- COMPETITORS TAB -->
                <div id="competitors-tab" class="tab-content">
                    <div class="mb-6">
                        <div class="bg-gradient-to-r from-blue-500 to-indigo-600 text-white rounded-lg p-6 shadow-lg">
                            <h2 class="text-2xl font-bold mb-2">🏢 Competitor Intelligence</h2>
                            <p class="text-blue-100">Track your competition and identify market opportunities</p>
                        </div>
                    </div>

                    {generate_competitors_section(competitors)}
                </div>

                <!-- AI ASSISTANT TAB -->
                <div id="ai-assistant-tab" class="tab-content">
                    <div class="bg-white rounded-lg shadow-sm p-6">
                        <h2 class="text-2xl font-bold mb-4">🤖 AI Assistant</h2>
                        <div class="border-2 border-dashed border-gray-300 rounded-lg p-8 text-center">
                            <i class="fas fa-robot text-6xl text-gray-400 mb-4"></i>
                            <p class="text-gray-600 mb-4">Ask me anything about procurement data, market trends, or opportunities!</p>
                            <div class="max-w-2xl mx-auto">
                                <div class="flex gap-2">
                                    <input type="text" placeholder="e.g., What are the best IT opportunities in Germany?" 
                                           class="flex-1 px-4 py-3 border border-gray-300 rounded-lg focus:outline-none focus:border-purple-500">
                                    <button class="px-6 py-3 gradient-bg text-white rounded-lg hover:opacity-90 font-semibold">
                                        Ask
                                    </button>
                                </div>
                            </div>
                            <div class="mt-4 text-sm text-gray-500">
                                <strong>AI feature coming soon</strong> - Requires OpenAI API integration
                            </div>
                        </div>
                    </div>
                </div>

                <!-- Other tabs (Market Intel, Watchlist, Bids) -->
                <div id="market-intel-tab" class="tab-content">
                    <div class="mb-6">
                        <div class="bg-gradient-to-r from-blue-500 to-indigo-600 text-white rounded-lg p-6 shadow-lg">
                            <h2 class="text-2xl font-bold mb-2">📈 Market Intelligence</h2>
                            <p class="text-blue-100">Real-time insights and trends across all procurement markets</p>
                        </div>
                    </div>

                    <div class="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-6">
                        <!-- Trending Sectors -->
                        <div class="bg-white rounded-lg shadow-sm p-6">
                            <h3 class="text-lg font-bold mb-4">🔥 Trending Sectors</h3>
                            <div class="space-y-3">
                                <div class="flex items-center justify-between p-3 border rounded-lg">
                                    <div>
                                        <div class="font-semibold">IT Services & Software</div>
                                        <div class="text-sm text-gray-600">234 active tenders</div>
                                    </div>
                                    <div class="text-green-600 font-bold">+34%</div>
                                </div>
                                <div class="flex items-center justify-between p-3 border rounded-lg">
                                    <div>
                                        <div class="font-semibold">Green Energy Projects</div>
                                        <div class="text-sm text-gray-600">128 active tenders</div>
                                    </div>
                                    <div class="text-green-600 font-bold">+28%</div>
                                </div>
                                <div class="flex items-center justify-between p-3 border rounded-lg">
                                    <div>
                                        <div class="font-semibold">Healthcare & Medical</div>
                                        <div class="text-sm text-gray-600">156 active tenders</div>
                                    </div>
                                    <div class="text-green-600 font-bold">+19%</div>
                                </div>
                            </div>
                        </div>

                        <!-- Price Trends -->
                        <div class="bg-white rounded-lg shadow-sm p-6">
                            <h3 class="text-lg font-bold mb-4">💰 Price Trends</h3>
                            <div class="space-y-3">
                                <div class="border-l-4 border-blue-500 pl-4 py-2">
                                    <div class="font-semibold">IT Sector Average</div>
                                    <div class="text-2xl font-bold text-blue-600">€285K</div>
                                    <div class="text-sm text-gray-600">+5% vs last quarter</div>
                                </div>
                                <div class="border-l-4 border-green-500 pl-4 py-2">
                                    <div class="font-semibold">Construction Average</div>
                                    <div class="text-2xl font-bold text-green-600">€1.2M</div>
                                    <div class="text-sm text-gray-600">-3% vs last quarter</div>
                                </div>
                                <div class="border-l-4 border-purple-500 pl-4 py-2">
                                    <div class="font-semibold">Services Average</div>
                                    <div class="text-2xl font-bold text-purple-600">€145K</div>
                                    <div class="text-sm text-gray-600">Stable</div>
                                </div>
                            </div>
                        </div>
                    </div>

                    <!-- Market Forecast -->
                    <div class="bg-white rounded-lg shadow-sm p-6 mb-6">
                        <h3 class="text-lg font-bold mb-4">🔮 Market Forecast (Next 90 Days)</h3>
                        <div class="grid grid-cols-1 md:grid-cols-3 gap-4">
                            <div class="p-4 bg-green-50 border-l-4 border-green-500 rounded">
                                <div class="text-sm text-green-800 font-semibold">High Growth Expected</div>
                                <ul class="mt-2 text-sm text-green-700 space-y-1">
                                    <li>• Cloud Services (+40%)</li>
                                    <li>• Cybersecurity (+35%)</li>
                                    <li>• Green Tech (+30%)</li>
                                </ul>
                            </div>
                            <div class="p-4 bg-blue-50 border-l-4 border-blue-500 rounded">
                                <div class="text-sm text-blue-800 font-semibold">Stable Growth</div>
                                <ul class="mt-2 text-sm text-blue-700 space-y-1">
                                    <li>• Professional Services (+10%)</li>
                                    <li>• Healthcare (+8%)</li>
                                    <li>• Education (+5%)</li>
                                </ul>
                            </div>
                            <div class="p-4 bg-orange-50 border-l-4 border-orange-500 rounded">
                                <div class="text-sm text-orange-800 font-semibold">Declining</div>
                                <ul class="mt-2 text-sm text-orange-700 space-y-1">
                                    <li>• Traditional IT (-5%)</li>
                                    <li>• Office Supplies (-12%)</li>
                                    <li>• Print Services (-8%)</li>
                                </ul>
                            </div>
                        </div>
                    </div>

                    <!-- Geographic Hotspots -->
                    <div class="bg-white rounded-lg shadow-sm p-6">
                        <h3 class="text-lg font-bold mb-4">🗺️ Geographic Hotspots</h3>
                        <div class="grid grid-cols-2 md:grid-cols-4 gap-4">
                            <div class="text-center p-4 border rounded-lg hover:shadow-md transition cursor-pointer" onclick="viewTenderDetails('germany-it')">
                                <div class="text-3xl mb-2">🇩🇪</div>
                                <div class="font-bold">Germany</div>
                                <div class="text-sm text-gray-600">€45M available</div>
                            </div>
                            <div class="text-center p-4 border rounded-lg hover:shadow-md transition cursor-pointer" onclick="viewTenderDetails('france-construction')">
                                <div class="text-3xl mb-2">🇫🇷</div>
                                <div class="font-bold">France</div>
                                <div class="text-sm text-gray-600">€38M available</div>
                            </div>
                            <div class="text-center p-4 border rounded-lg hover:shadow-md transition cursor-pointer" onclick="viewTenderDetails('netherlands-services')">
                                <div class="text-3xl mb-2">🇳🇱</div>
                                <div class="font-bold">Netherlands</div>
                                <div class="text-sm text-gray-600">€28M available</div>
                            </div>
                            <div class="text-center p-4 border rounded-lg hover:shadow-md transition cursor-pointer" onclick="viewTenderDetails('spain-energy')">
                                <div class="text-3xl mb-2">🇪🇸</div>
                                <div class="font-bold">Spain</div>
                                <div class="text-sm text-gray-600">€52M available</div>
                            </div>
                        </div>
                    </div>
                </div>

                <div id="watchlist-tab" class="tab-content">
                    <div class="bg-white rounded-lg shadow-sm p-8 text-center">
                        <i class="fas fa-star text-6xl text-gray-400 mb-4"></i>
                        <h2 class="text-2xl font-bold mb-2">My Watchlist</h2>
                        <p class="text-gray-600">Save and track tenders you're interested in</p>
                    </div>
                </div>

                <div id="bids-tab" class="tab-content">
                    <div class="bg-white rounded-lg shadow-sm p-8 text-center">
                        <i class="fas fa-file-invoice text-6xl text-gray-400 mb-4"></i>
                        <h2 class="text-2xl font-bold mb-2">My Bids</h2>
                        <p class="text-gray-600">Track your bid pipeline and success rate</p>
                    </div>
                </div>
            </div>
        </div>

        <!-- Search Modal -->
        <div id="searchModal" style="display:none;" class="fixed inset-0 bg-black bg-opacity-50 z-50 flex items-center justify-center p-4">
            <div class="bg-white rounded-lg max-w-4xl w-full max-h-[90vh] overflow-auto">
                <div class="gradient-bg text-white p-6 flex justify-between items-center">
                    <h2 class="text-2xl font-bold">🔍 Search Tenders</h2>
                    <button onclick="closeSearchModal()" class="text-white hover:text-gray-200">
                        <i class="fas fa-times text-2xl"></i>
                    </button>
                </div>
                <div class="p-6">
                    <div class="grid grid-cols-2 gap-4 mb-4">
                        <div>
                            <label class="block text-sm font-semibold text-gray-700 mb-2">Keywords</label>
                            <input type="text" placeholder="e.g., IT services, software" class="w-full px-4 py-2 border rounded-lg">
                        </div>
                        <div>
                            <label class="block text-sm font-semibold text-gray-700 mb-2">Country</label>
                            <select class="w-full px-4 py-2 border rounded-lg">
                                <option>All Countries</option>
                                <option>Germany</option>
                                <option>France</option>
                                <option>Greece</option>
                                <option>USA</option>
                            </select>
                        </div>
                    </div>
                    <div class="grid grid-cols-3 gap-4 mb-4">
                        <div>
                            <label class="block text-sm font-semibold text-gray-700 mb-2">Min Value (€)</label>
                            <input type="number" placeholder="0" class="w-full px-4 py-2 border rounded-lg">
                        </div>
                        <div>
                            <label class="block text-sm font-semibold text-gray-700 mb-2">Max Value (€)</label>
                            <input type="number" placeholder="1000000" class="w-full px-4 py-2 border rounded-lg">
                        </div>
                        <div>
                            <label class="block text-sm font-semibold text-gray-700 mb-2">Deadline</label>
                            <select class="w-full px-4 py-2 border rounded-lg">
                                <option>Any time</option>
                                <option>Next 7 days</option>
                                <option>Next 30 days</option>
                                <option>Next 90 days</option>
                            </select>
                        </div>
                    </div>
                    <button onclick="performSearch()" class="w-full gradient-bg text-white py-3 rounded-lg font-semibold hover:opacity-90">
                        <i class="fas fa-search mr-2"></i>Search
                    </button>
                    <div id="searchResults" class="mt-6">
                        <!-- Results will appear here -->
                    </div>
                </div>
            </div>
        </div>

        <script>
            // Save token from URL if present
            const urlParams = new URLSearchParams(window.location.search);
            const token = urlParams.get('token');
            if (token) {{
                localStorage.setItem('auth_token', token);
                // Clean URL
                window.history.replaceState({{}}, document.title, window.location.pathname);
            }}

            // Tab switching
            function showTab(tabName) {{
                // Hide all tabs
                document.querySelectorAll('.tab-content').forEach(tab => {{
                    tab.classList.remove('active');
                }});
                
                // Show selected tab
                const targetTab = document.getElementById(tabName + '-tab');
                if (targetTab) {{
                    targetTab.classList.add('active');
                }}
                
                // Update active sidebar item
                document.querySelectorAll('.sidebar-item').forEach(item => {{
                    item.classList.remove('active');
                }});
                if (event && event.target) {{
                    event.target.closest('.sidebar-item')?.classList.add('active');
                }}
                
                // Update page title
                const titles = {{
                    'overview': 'Dashboard Overview',
                    'hot-deals': '🔥 Hot Deals',
                    'matches': '🎯 Perfect Matches',
                    'watchlist': '⭐ My Watchlist',
                    'bids': '📋 My Bids',
                    'ai-assistant': '🤖 AI Assistant',
                    'market-intel': '📈 Market Intelligence',
                    'competitors': '🏢 Competitor Tracking'
                }};
                document.getElementById('page-title').textContent = titles[tabName] || 'Dashboard';
            }}

            // Navigate with JWT token
            function navigateWithToken(url) {{
                const token = localStorage.getItem('auth_token');
                if (token) {{
                    window.location.href = url + '?token=' + encodeURIComponent(token);
                }} else {{
                    window.location.href = '/login.html';
                }}
            }}

            // View tender details
            function viewTenderDetails(tenderId) {{
                navigateWithToken('/report/' + tenderId);
            }}

            // Search modal functions
            function openSearchModal() {{
                document.getElementById('searchModal').style.display = 'flex';
            }}

            function closeSearchModal() {{
                document.getElementById('searchModal').style.display = 'none';
            }}

            function performSearch() {{
                const resultsDiv = document.getElementById('searchResults');
                resultsDiv.innerHTML = '<div class="text-center py-8"><div class="animate-pulse text-purple-600 mb-2"><i class="fas fa-spinner fa-spin text-3xl"></i></div><div>Searching...</div></div>';
                
                // Simulate search (replace with real API call)
                setTimeout(() => {{
                    resultsDiv.innerHTML = `
                        <div class="border-t pt-4">
                            <h3 class="font-bold mb-3">Search Results (Sample)</h3>
                            <div class="space-y-3">
                                <div class="border rounded-lg p-4 hover:bg-gray-50 cursor-pointer" onclick="viewTenderDetails('TD-001')">
                                    <div class="font-semibold text-gray-800">Cloud Infrastructure Services</div>
                                    <div class="text-sm text-gray-600 mt-1">€145,000 | Germany | 18 days left</div>
                                </div>
                                <div class="border rounded-lg p-4 hover:bg-gray-50 cursor-pointer" onclick="viewTenderDetails('TD-002')">
                                    <div class="font-semibold text-gray-800">Software Development Framework</div>
                                    <div class="text-sm text-gray-600 mt-1">€89,000 | France | 24 days left</div>
                                </div>
                            </div>
                        </div>
                    `;
                }}, 1000);
            }}

            // Export data function
            function exportData() {{
                alert('Export functionality coming soon! You will be able to export to Excel, CSV, and PDF.');
            }}

            // Add to favorites
            function addToFavorites(tenderId) {{
                alert('Added tender ' + tenderId + ' to your favorites!');
                // TODO: Implement actual API call
            }}

            // Set alert
            function setAlert(tenderId) {{
                if (confirm('Set an alert for this tender? You will be notified of any updates.')) {{
                    alert('Alert set for tender ' + tenderId);
                    // TODO: Implement actual API call
                }}
            }}

            // Logout function
            function logout() {{
                if (confirm('Are you sure you want to logout?')) {{
                    localStorage.removeItem('auth_token');
                    localStorage.removeItem('user');
                    window.location.href = '/';
                }}
            }}
        </script>
    </body>
    </html>
    '''
    
    return html


def generate_hot_deal_preview(deals: List[Dict]) -> str:
    """Generate preview cards for hot deals"""
    html = ""
    for deal in deals:
        html += f'''
        <div class="border-l-4 border-red-500 pl-4 py-2">
            <div class="font-semibold text-gray-800">{deal['title']}</div>
            <div class="text-sm text-gray-600 mt-1">
                €{deal['value']:,} <span class="text-red-600 font-bold">(-{deal['savings_pct']}% vs market)</span>
            </div>
            <div class="text-xs text-gray-500 mt-1">
                {deal['country']} • {deal['deadline_days']} days left • {deal['bidders']} bidders
            </div>
        </div>
        '''
    return html


def generate_match_preview(matches: List[Dict]) -> str:
    """Generate preview cards for perfect matches"""
    html = ""
    for match in matches:
        html += f'''
        <div class="border-l-4 border-green-500 pl-4 py-2">
            <div class="flex items-center justify-between">
                <div class="font-semibold text-gray-800">{match['title']}</div>
                <div class="text-green-600 font-bold text-sm">{match['match']}%</div>
            </div>
            <div class="text-sm text-gray-600 mt-1">€{match['value']:,}</div>
            <div class="text-xs text-gray-500 mt-1">
                Competition: <span class="font-semibold">{match['competition']}</span>
            </div>
        </div>
        '''
    return html


def generate_hot_deals_section(deals: List[Dict]) -> str:
    """Generate full hot deals section"""
    html = ""
    for deal in deals:
        savings = deal['market_avg'] - deal['value']
        html += f'''
        <div class="hot-deal-card">
            <div class="hot-deal-badge">
                💰 SAVE €{savings:,}
            </div>
            <div class="mb-2 text-sm opacity-90">Tender ID: {deal['id']}</div>
            <h3 class="text-xl font-bold mb-3">{deal['title']}</h3>
            
            <div class="grid grid-cols-2 gap-4 mb-4">
                <div>
                    <div class="text-sm opacity-75">Tender Value</div>
                    <div class="text-2xl font-bold">€{deal['value']:,}</div>
                </div>
                <div>
                    <div class="text-sm opacity-75">Market Average</div>
                    <div class="text-xl line-through opacity-75">€{deal['market_avg']:,}</div>
                </div>
            </div>
            
            <div class="bg-white bg-opacity-20 rounded-lg p-3 mb-4">
                <div class="text-3xl font-bold">{deal['savings_pct']}% BELOW MARKET</div>
                <div class="text-sm opacity-90">You save: €{savings:,}</div>
            </div>
            
            <div class="grid grid-cols-4 gap-3 mb-4 text-center">
                <div>
                    <div class="text-2xl">🎯</div>
                    <div class="text-sm">{deal['match_score']}% Match</div>
                </div>
                <div>
                    <div class="text-2xl">📍</div>
                    <div class="text-sm">{deal['country']}</div>
                </div>
                <div>
                    <div class="text-2xl">⏰</div>
                    <div class="text-sm">{deal['deadline_days']} days</div>
                </div>
                <div>
                    <div class="text-2xl">👥</div>
                    <div class="text-sm">{deal['bidders']} bidders</div>
                </div>
            </div>
            
            <div class="flex gap-2">
                <button onclick="viewTenderDetails('{deal['id']}')" class="flex-1 bg-white text-red-600 px-4 py-2 rounded-lg font-semibold hover:bg-gray-100">
                    View Details
                </button>
                <button onclick="addToFavorites('{deal['id']}')" class="px-4 py-2 bg-white bg-opacity-20 rounded-lg hover:bg-opacity-30" title="Add to Favorites">
                    <i class="fas fa-star"></i>
                </button>
                <button onclick="setAlert('{deal['id']}')" class="px-4 py-2 bg-white bg-opacity-20 rounded-lg hover:bg-opacity-30" title="Set Alert">
                    <i class="fas fa-bell"></i>
                </button>
            </div>
        </div>
        '''
    return html


def generate_matches_section(matches: List[Dict]) -> str:
    """Generate perfect matches section"""
    html = ""
    for match in matches:
        html += f'''
        <div class="match-card">
            <div class="flex items-start justify-between mb-3">
                <div class="flex-1">
                    <div class="text-sm text-gray-500 mb-1">ID: {match['id']}</div>
                    <h3 class="text-lg font-bold text-gray-800">{match['title']}</h3>
                </div>
                <div class="text-right">
                    <div class="text-3xl font-bold text-green-600">{match['match']}%</div>
                    <div class="text-xs text-gray-500">Match Score</div>
                </div>
            </div>
            
            <div class="grid grid-cols-3 gap-4 mb-3">
                <div>
                    <div class="text-xs text-gray-500">Value</div>
                    <div class="font-semibold">€{match['value']:,}</div>
                </div>
                <div>
                    <div class="text-xs text-gray-500">Competition</div>
                    <div class="font-semibold">{match['competition']}</div>
                </div>
                <div>
                    <div class="text-xs text-gray-500">Status</div>
                    <div class="text-green-600 font-semibold">Open</div>
                </div>
            </div>
            
            <div class="mb-3">
                <div class="text-xs text-gray-500 mb-1">Match Strength</div>
                <div class="progress-bar">
                    <div class="progress-fill" style="width: {match['match']}%"></div>
                </div>
            </div>
            
            <div class="flex gap-2">
                <button onclick="viewTenderDetails('{match['id']}')" class="flex-1 gradient-bg text-white px-4 py-2 rounded-lg font-semibold hover:opacity-90">
                    View Tender
                </button>
                <button onclick="addToFavorites('{match['id']}')" class="px-4 py-2 border border-gray-300 rounded-lg hover:bg-gray-50" title="Add to Favorites">
                    <i class="fas fa-heart"></i>
                </button>
            </div>
        </div>
        '''
    return html


def generate_competitors_section(competitors: List[Dict]) -> str:
    """Generate competitors section"""
    html = '<div class="bg-white rounded-lg shadow-sm overflow-hidden">'
    html += '''
    <table class="w-full">
        <thead class="bg-gray-50 border-b">
            <tr>
                <th class="px-6 py-3 text-left text-xs font-semibold text-gray-700 uppercase">Company</th>
                <th class="px-6 py-3 text-left text-xs font-semibold text-gray-700 uppercase">Wins (YTD)</th>
                <th class="px-6 py-3 text-left text-xs font-semibold text-gray-700 uppercase">Total Value</th>
                <th class="px-6 py-3 text-left text-xs font-semibold text-gray-700 uppercase">Avg Value</th>
                <th class="px-6 py-3 text-left text-xs font-semibold text-gray-700 uppercase">Trend</th>
                <th class="px-6 py-3 text-left text-xs font-semibold text-gray-700 uppercase">Actions</th>
            </tr>
        </thead>
        <tbody class="divide-y">
    '''
    
    for comp in competitors:
        trend_icon = "📈" if comp['trend'] == "up" else "📊" if comp['trend'] == "stable" else "📉"
        trend_color = "green" if comp['trend'] == "up" else "gray" if comp['trend'] == "stable" else "red"
        
        html += f'''
        <tr class="hover:bg-gray-50">
            <td class="px-6 py-4 font-semibold text-gray-800">{comp['name']}</td>
            <td class="px-6 py-4">{comp['wins']}</td>
            <td class="px-6 py-4 font-semibold">{comp['total_value']}</td>
            <td class="px-6 py-4">{comp['avg_value']}</td>
            <td class="px-6 py-4">
                <span class="text-{trend_color}-600">{trend_icon} {comp['trend'].title()}</span>
            </td>
            <td class="px-6 py-4">
                <button class="text-purple-600 hover:text-purple-700 font-semibold text-sm">
                    Track <i class="fas fa-bell ml-1"></i>
                </button>
            </td>
        </tr>
        '''
    
    html += '</tbody></table></div>'
    return html
