"""
Dashboard generator for procurement intelligence
Creates interactive Plotly dashboards
"""
import pandas as pd
import plotly.express as px
import plotly.graph_objects as go
from plotly.subplots import make_subplots
from typing import Dict, List
from datetime import datetime


class DashboardGenerator:
    """Generate procurement analytics dashboards"""
    
    def __init__(self):
        self.color_scheme = {
            'primary': '#1f77b4',
            'success': '#2ca02c',
            'warning': '#ff7f0e',
            'danger': '#d62728'
        }
    
    def create_tender_overview(self, tenders: pd.DataFrame) -> Dict:
        """Create comprehensive tender overview dashboard"""
        
        if len(tenders) == 0:
            return {'error': 'No tenders found'}
        
        # KPI Cards
        total_tenders = len(tenders)
        total_value = tenders['value_eur'].sum()
        avg_value = tenders['value_eur'].mean()
        
        # Timeline Chart
        tenders['published_date'] = pd.to_datetime(tenders['published_date'])
        timeline = tenders.groupby(tenders['published_date'].dt.to_period('D')).agg({
            'tender_id': 'count',
            'value_eur': 'sum'
        }).reset_index()
        timeline['published_date'] = timeline['published_date'].dt.to_timestamp()
        
        fig_timeline = px.line(
            timeline, 
            x='published_date', 
            y='tender_id',
            title='Tender Publications Over Time',
            labels={'tender_id': 'Number of Tenders', 'published_date': 'Date'}
        )
        fig_timeline.update_layout(hovermode='x unified')
        
        # Geographic Distribution
        geo_data = tenders.groupby('country_name').agg({
            'tender_id': 'count',
            'value_eur': 'sum'
        }).reset_index().sort_values('tender_id', ascending=False)
        
        fig_geo = px.bar(
            geo_data.head(10),
            x='country_name',
            y='tender_id',
            title='Top 10 Countries by Tender Count',
            labels={'tender_id': 'Number of Tenders', 'country_name': 'Country'}
        )
        
        # Value Distribution
        fig_value = px.histogram(
            tenders,
            x='value_eur',
            nbins=30,
            title='Tender Value Distribution',
            labels={'value_eur': 'Value (EUR)'}
        )
        fig_value.update_layout(showlegend=False)
        
        # Category Breakdown
        category_data = tenders.groupby('cpv_description')['value_eur'].sum().sort_values(ascending=False).head(10)
        
        fig_category = px.pie(
            values=category_data.values,
            names=category_data.index,
            title='Top 10 Categories by Value'
        )
        
        return {
            'kpis': {
                'total_tenders': total_tenders,
                'total_value': f'€{total_value:,.0f}',
                'average_value': f'€{avg_value:,.0f}'
            },
            'charts': {
                'timeline': fig_timeline.to_html(include_plotlyjs='cdn', div_id='timeline'),
                'geography': fig_geo.to_html(include_plotlyjs='cdn', div_id='geography'),
                'value_dist': fig_value.to_html(include_plotlyjs='cdn', div_id='value_dist'),
                'categories': fig_category.to_html(include_plotlyjs='cdn', div_id='categories')
            }
        }
    
    def create_market_intelligence(self, tenders: pd.DataFrame) -> go.Figure:
        """Create market intelligence dashboard"""
        
        # Create subplots
        fig = make_subplots(
            rows=2, cols=2,
            subplot_titles=('Tender Count by Country', 'Value by Category', 
                          'Timeline', 'Procedure Types'),
            specs=[[{'type': 'bar'}, {'type': 'pie'}],
                   [{'type': 'scatter'}, {'type': 'bar'}]]
        )
        
        # Country distribution
        country_counts = tenders['country_name'].value_counts().head(5)
        fig.add_trace(
            go.Bar(x=country_counts.index, y=country_counts.values, name='Tenders'),
            row=1, col=1
        )
        
        # Category pie
        category_values = tenders.groupby('cpv_description')['value_eur'].sum().head(5)
        fig.add_trace(
            go.Pie(labels=category_values.index, values=category_values.values),
            row=1, col=2
        )
        
        # Timeline
        tenders['published_date'] = pd.to_datetime(tenders['published_date'])
        timeline = tenders.groupby(tenders['published_date'].dt.date)['tender_id'].count()
        fig.add_trace(
            go.Scatter(x=timeline.index, y=timeline.values, mode='lines+markers'),
            row=2, col=1
        )
        
        # Procedure types
        procedure_counts = tenders['procedure_type'].value_counts()
        fig.add_trace(
            go.Bar(x=procedure_counts.index, y=procedure_counts.values),
            row=2, col=2
        )
        
        fig.update_layout(height=800, showlegend=False, title_text="Market Intelligence Dashboard")
        
        return fig


# Test
if __name__ == '__main__':
    import sys
    sys.path.append('..')
    from connectors.ted_eu import TEDConnector
    
    print("Testing Dashboard Generator...")
    
    connector = TEDConnector()
    tenders = connector.search_tenders({'limit': 50})
    
    generator = DashboardGenerator()
    dashboard = generator.create_tender_overview(tenders)
    
    print(f"\nKPIs: {dashboard['kpis']}")
    print("\n✓ Dashboard generated successfully!")
