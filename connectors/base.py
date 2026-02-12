"""
Base connector class for all procurement data sources
"""
from abc import ABC, abstractmethod
from typing import Dict, List, Optional
import pandas as pd
from datetime import datetime


class ProcurementConnector(ABC):
    """Abstract base class for procurement data connectors"""
    
    def __init__(self, api_key: Optional[str] = None):
        self.api_key = api_key
        self.base_url = ""
        self.source_name = ""
    
    @abstractmethod
    def search_tenders(self, filters: Dict) -> pd.DataFrame:
        """
        Search for tenders matching filters
        
        Args:
            filters: Dictionary of search parameters
            
        Returns:
            DataFrame with tender information
        """
        pass
    
    @abstractmethod
    def get_tender_details(self, tender_id: str) -> Dict:
        """Get detailed information for a specific tender"""
        pass
    
    @abstractmethod
    def search_awards(self, filters: Dict) -> pd.DataFrame:
        """Search for contract awards"""
        pass
    
    def normalize_date(self, date_str: str) -> datetime:
        """Normalize date strings to datetime objects"""
        try:
            return pd.to_datetime(date_str)
        except:
            return None
    
    def normalize_value(self, value: any) -> float:
        """Normalize currency values to float"""
        try:
            if isinstance(value, (int, float)):
                return float(value)
            # Remove currency symbols and convert
            value_str = str(value).replace('€', '').replace('$', '').replace(',', '')
            return float(value_str)
        except:
            return 0.0
