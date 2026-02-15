"""
Patent Dashboard Factory - PatentsView Connector Prototype
Quick proof-of-concept for patent analytics dashboards
"""
import requests
import pandas as pd
from typing import Dict, List

class PatentsViewConnector:
    """Connector for PatentsView API"""
    
    def __init__(self, api_key: str = None):
        self.base_url = "https://search.patentsview.org/api/v1"
        self.api_key = api_key
        self.headers = {}
        if api_key:
            self.headers['X-Api-Key'] = api_key
    
    def search_patents(self, query: Dict, fields: List[str], limit: int = 100) -> pd.DataFrame:
        """
        Search for patents matching criteria
        
        Example query:
        {
            "_gte": {"patent_date": "2020-01-01"},
            "_lte": {"patent_date": "2023-12-31"},
            "_text_any": {"patent_abstract": "artificial intelligence"}
        }
        """
        endpoint = f"{self.base_url}/patent/"
        
        payload = {
            "q": query,
            "f": fields,
            "o": {"per_page": limit}
        }
        
        response = requests.post(endpoint, json=payload, headers=self.headers, timeout=30)
        response.raise_for_status()
        
        data = response.json()
        patents = data.get('patents', [])
        
        return pd.DataFrame(patents)
    
    def get_ai_patents_2023(self) -> pd.DataFrame:
        """Example: Get AI-related patents from 2023"""
        
        query = {
            "_and": [
                {"_gte": {"patent_date": "2023-01-01"}},
                {"_lte": {"patent_date": "2023-12-31"}},
                {"_text_any": {"patent_abstract": "artificial intelligence machine learning"}}
            ]
        }
        
        fields = [
            "patent_number",
            "patent_title", 
            "patent_date",
            "patent_abstract",
            "assignee_organization"
        ]
        
        return self.search_patents(query, fields, limit=500)
    
    def get_company_patents(self, company_name: str, year: int = None) -> pd.DataFrame:
        """Get patents for a specific company"""
        
        query = {"_text_phrase": {"assignee_organization": company_name}}
        
        if year:
            query = {
                "_and": [
                    query,
                    {"_gte": {"patent_date": f"{year}-01-01"}},
                    {"_lte": {"patent_date": f"{year}-12-31"}}
                ]
            }
        
        fields = [
            "patent_number",
            "patent_title",
            "patent_date",
            "cpc_section_id",
            "inventor_first_name",
            "inventor_last_name"
        ]
        
        return self.search_patents(query, fields, limit=1000)
    
    def get_technology_trends(self, cpc_section: str, start_year: int, end_year: int) -> pd.DataFrame:
        """
        Get patent trends by technology classification
        
        CPC Sections:
        A = Human Necessities
        B = Operations & Transport  
        C = Chemistry & Metallurgy
        D = Textiles
        E = Fixed Constructions
        F = Mechanical Engineering
        G = Physics
        H = Electricity
        Y = Emerging Technologies
        """
        
        query = {
            "_and": [
                {"_gte": {"patent_date": f"{start_year}-01-01"}},
                {"_lte": {"patent_date": f"{end_year}-12-31"}},
                {"_eq": {"cpc_section_id": cpc_section}}
            ]
        }
        
        fields = [
            "patent_number",
            "patent_date",
            "patent_title",
            "assignee_organization",
            "cpc_subsection_id"
        ]
        
        return self.search_patents(query, fields, limit=5000)


def generate_sample_dashboard():
    """Generate a sample patent analytics dashboard"""
    
    connector = PatentsViewConnector()
    
    print("Fetching AI patents from 2023...")
    ai_patents = connector.get_ai_patents_2023()
    
    print(f"\nFound {len(ai_patents)} AI patents")
    print("\nSample patents:")
    print(ai_patents[['patent_number', 'patent_title', 'patent_date']].head())
    
    # Analytics
    if len(ai_patents) > 0:
        print("\n--- AI Patent Analytics ---")
        print(f"Total AI patents in 2023: {len(ai_patents)}")
        
        if 'assignee_organization' in ai_patents.columns:
            top_assignees = ai_patents['assignee_organization'].value_counts().head(10)
            print("\nTop 10 AI Patent Assignees:")
            print(top_assignees)
    
    return ai_patents


if __name__ == '__main__':
    print("="*60)
    print("PATENT DASHBOARD FACTORY - PROTOTYPE")
    print("="*60)
    print()
    
    # Test connection
    try:
        df = generate_sample_dashboard()
        print("\n✓ Success! Patent data retrieved successfully!")
        print(f"Shape: {df.shape}")
    except Exception as e:
        print(f"\n✗ Error: {e}")
        print("\nNote: PatentsView API requires an API key for full access.")
        print("Get one at: https://search.patentsview.org/")
