"""
Procurement data source connectors
"""
from .base import ProcurementConnector
from .ted_eu import TEDConnector

__all__ = ['ProcurementConnector', 'TEDConnector']
