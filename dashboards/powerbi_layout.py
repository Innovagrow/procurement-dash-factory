"""
Power BI Style Dashboard Layout Generator
Creates tab-based, minimal-scroll dashboards
"""
import plotly.graph_objects as go
from plotly.subplots import make_subplots
import pandas as pd

class PowerBIDashboard:
    """Generate Power BI style dashboards with tabs and KPIs"""

    def __init__(self):
        self.colors = {
            'primary': '#667eea',
            'secondary': '#764ba2',
            'success': '#48bb78',
            'warning': '#ed8936',
            'danger': '#f56565',
            'info': '#4299e1'
        }

    def create_kpi_cards(self, kpis):
        """Generate KPI cards HTML"""
        cards_html = '<div class="kpi-grid">'

        for kpi in kpis:
            icon = kpi.get('icon', 'fa-chart-line')
            color = kpi.get('color', 'primary')

            cards_html += f'''
            <div class="kpi-card">
                <div class="kpi-icon" style="color: {self.colors[color]};">
                    <i class="fas {icon}"></i>
                </div>
                <div class="kpi-value">{kpi['value']}</div>
                <div class="kpi-label">{kpi['label']}</div>
                {f'<div class="kpi-change {kpi["change_class"]}">{kpi["change"]}</div>' if 'change' in kpi else ''}
            </div>
            '''

        cards_html += '</div>'
        return cards_html

    def create_tab_dashboard(self, data, title="Dashboard"):
        """Create tabbed dashboard with minimal scrolling"""

        # Calculate KPIs
        kpis = [
            {
                'label': 'Active Tenders',
                'value': f"{len(data):,}",
                'icon': 'fa-file-alt',
                'color': 'primary',
                'change': '+12%',
                'change_class': 'positive'
            },
            {
                'label': 'Total Value',
                'value': f"EUR {data['value_eur'].sum()/1e9:.1f}B",
                'icon': 'fa-euro-sign',
                'color': 'success'
            },
            {
                'label': 'Avg. Contract',
                'value': f"EUR {data['value_eur'].mean()/1e6:.1f}M",
                'icon': 'fa-calculator',
                'color': 'info'
            },
            {
                'label': 'Urgent (7 days)',
                'value': f"{len(data[data['days_to_deadline'] <= 7]):,}",
                'icon': 'fa-clock',
                'color': 'warning'
            }
        ]

        # Tab contents
        tabs = {
            'overview': self._create_overview_tab(data),
            'category': self._create_category_tab(data),
            'geography': self._create_geography_tab(data),
            'value': self._create_value_tab(data),
            'timeline': self._create_timeline_tab(data)
        }

        # Build HTML
        html = f'''
        <!DOCTYPE html>
        <html>
        <head>
            <title>{title}</title>
            <script src="https://cdn.plot.ly/plotly-latest.min.js"></script>
            <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.0.0/css/all.min.css">
            <style>
                * {{ margin: 0; padding: 0; box-sizing: border-box; }}
                body {{
                    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif;
                    background: #f5f7fa;
                }}
                .header {{
                    background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
                    color: white;
                    padding: 20px 30px;
                    box-shadow: 0 2px 4px rgba(0,0,0,0.1);
                }}
                .header h1 {{ font-size: 24px; margin-bottom: 5px; }}
                .header .breadcrumb {{ opacity: 0.9; font-size: 14px; }}
                .kpi-grid {{
                    display: grid;
                    grid-template-columns: repeat(4, 1fr);
                    gap: 20px;
                    padding: 20px 30px;
                    background: white;
                    border-bottom: 1px solid #e2e8f0;
                }}
                .kpi-card {{
                    padding: 20px;
                    background: #f8fafc;
                    border-radius: 8px;
                    border: 1px solid #e2e8f0;
                }}
                .kpi-icon {{ font-size: 32px; margin-bottom: 10px; }}
                .kpi-value {{ font-size: 32px; font-weight: bold; color: #1a202c; margin: 10px 0; }}
                .kpi-label {{ color: #64748b; font-size: 14px; }}
                .kpi-change {{ 
                    margin-top: 8px; 
                    font-size: 12px; 
                    font-weight: 600;
                }}
                .kpi-change.positive {{ color: #48bb78; }}
                .kpi-change.negative {{ color: #f56565; }}
                .tabs {{
                    display: flex;
                    background: white;
                    border-bottom: 2px solid #e2e8f0;
                    padding: 0 30px;
                }}
                .tab {{
                    padding: 15px 25px;
                    cursor: pointer;
                    border-bottom: 3px solid transparent;
                    color: #64748b;
                    font-weight: 500;
                    transition: all 0.3s;
                }}
                .tab:hover {{ color: #667eea; }}
                .tab.active {{
                    color: #667eea;
                    border-bottom-color: #667eea;
                }}
                .tab-content {{
                    display: none;
                    padding: 20px 30px;
                    height: calc(100vh - 280px);
                    overflow: hidden;
                }}
                .tab-content.active {{ display: block; }}
                .chart-grid {{
                    display: grid;
                    grid-template-columns: repeat(2, 1fr);
                    gap: 20px;
                    height: 100%;
                }}
                .chart {{
                    background: white;
                    border-radius: 8px;
                    padding: 20px;
                    box-shadow: 0 1px 3px rgba(0,0,0,0.1);
                }}
                .chart h3 {{
                    font-size: 16px;
                    color: #1a202c;
                    margin-bottom: 15px;
                }}
                .back-link {{
                    color: white;
                    text-decoration: none;
                    opacity: 0.9;
                }}
                .back-link:hover {{ opacity: 1; }}
            </style>
        </head>
        <body>
            <div class="header">
                <a href="/" class="back-link"><i class="fas fa-arrow-left"></i> Back to Home</a>
                <h1><i class="fas fa-chart-line"></i> {title}</h1>
                <div class="breadcrumb">Procurement Intelligence / Dashboard</div>
            </div>

            {self.create_kpi_cards(kpis)}

            <div class="tabs">
                <div class="tab active" onclick="showTab('overview')">
                    <i class="fas fa-home"></i> Overview
                </div>
                <div class="tab" onclick="showTab('category')">
                    <i class="fas fa-th"></i> By Category
                </div>
                <div class="tab" onclick="showTab('geography')">
                    <i class="fas fa-globe"></i> Geography
                </div>
                <div class="tab" onclick="showTab('value')">
                    <i class="fas fa-dollar-sign"></i> Value Analysis
                </div>
                <div class="tab" onclick="showTab('timeline')">
                    <i class="fas fa-clock"></i> Timeline
                </div>
            </div>

            <div id="overview" class="tab-content active">
                {tabs['overview']}
            </div>
            <div id="category" class="tab-content">
                {tabs['category']}
            </div>
            <div id="geography" class="tab-content">
                {tabs['geography']}
            </div>
            <div id="value" class="tab-content">
                {tabs['value']}
            </div>
            <div id="timeline" class="tab-content">
                {tabs['timeline']}
            </div>

            <script>
                function showTab(tabName) {{
                    // Hide all tabs
                    document.querySelectorAll('.tab-content').forEach(tab => {{
                        tab.classList.remove('active');
                    }});
                    document.querySelectorAll('.tab').forEach(tab => {{
                        tab.classList.remove('active');
                    }});

                    // Show selected tab
                    document.getElementById(tabName).classList.add('active');
                    event.target.closest('.tab').classList.add('active');
                }}
            </script>
        </body>
        </html>
        '''

        return html

    def _create_overview_tab(self, data):
        """Overview tab with 4 key charts"""
        # Implementation here
        return '''
        <div class="chart-grid">
            <div class="chart" id="overview-1"></div>
            <div class="chart" id="overview-2"></div>
            <div class="chart" id="overview-3"></div>
            <div class="chart" id="overview-4"></div>
        </div>
        '''

    def _create_category_tab(self, data):
        return '<div class="chart-grid"><div class="chart">Category charts here</div></div>'

    def _create_geography_tab(self, data):
        return '<div class="chart-grid"><div class="chart">Geography charts here</div></div>'

    def _create_value_tab(self, data):
        return '<div class="chart-grid"><div class="chart">Value charts here</div></div>'

    def _create_timeline_tab(self, data):
        return '<div class="chart-grid"><div class="chart">Timeline charts here</div></div>'
