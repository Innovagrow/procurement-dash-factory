"""
Natural Language Query Interface

Ask questions about your data in plain English
"""
from __future__ import annotations
from typing import Any
import re
from pydantic import BaseModel


class QueryResult(BaseModel):
    """Natural language query result"""
    question: str
    sql: str
    answer: str
    data: dict[str, Any] | None = None
    confidence: float = 1.0


class NLQueryEngine:
    """Natural language to SQL query engine"""
    
    def __init__(self, dataset_code: str):
        self.dataset_code = dataset_code
        self.patterns = self._build_patterns()
    
    def _build_patterns(self) -> list[tuple[str, str, str]]:
        """Build query pattern matching rules"""
        return [
            # Latest value queries
            (r"what is the latest (?:value|data|number)", 
             f"SELECT time, value FROM fact_observations WHERE dataset_code='{self.dataset_code}' ORDER BY time DESC LIMIT 1",
             "The latest value is {{value}} as of {{time}}"),
            
            (r"(?:show|give|what's) (?:me )?(?:the )?latest",
             f"SELECT time, geo, value FROM fact_observations WHERE dataset_code='{self.dataset_code}' ORDER BY time DESC LIMIT 5",
             "Here are the most recent values"),
            
            # Trend queries
            (r"(?:what is|show) the trend",
             f"SELECT time, AVG(value) as value FROM fact_observations WHERE dataset_code='{self.dataset_code}' GROUP BY time ORDER BY time",
             "Here's the trend over time"),
            
            (r"is (?:it|this) (?:going up|increasing|growing)",
             f"""SELECT 
                     (SELECT AVG(value) FROM fact_observations WHERE dataset_code='{self.dataset_code}' ORDER BY time DESC LIMIT 5) as recent,
                     (SELECT AVG(value) FROM fact_observations WHERE dataset_code='{self.dataset_code}' ORDER BY time ASC LIMIT 5) as old
                 """,
             "Based on recent data vs historical data"),
            
            # Comparison queries
            (r"(?:which|what) (?:country|region|geo) (?:has|is) (?:the )?(?:highest|largest|biggest|most)",
             f"""WITH latest AS (SELECT MAX(time) as t FROM fact_observations WHERE dataset_code='{self.dataset_code}')
                 SELECT geo, value FROM fact_observations 
                 WHERE dataset_code='{self.dataset_code}' AND time=(SELECT t FROM latest)
                 ORDER BY value DESC LIMIT 1""",
             "The region with the highest value is {{geo}} with {{value}}"),
            
            (r"(?:which|what) (?:country|region|geo) (?:has|is) (?:the )?(?:lowest|smallest|least)",
             f"""WITH latest AS (SELECT MAX(time) as t FROM fact_observations WHERE dataset_code='{self.dataset_code}')
                 SELECT geo, value FROM fact_observations 
                 WHERE dataset_code='{self.dataset_code}' AND time=(SELECT t FROM latest)
                 ORDER BY value ASC LIMIT 1""",
             "The region with the lowest value is {{geo}} with {{value}}"),
            
            (r"(?:compare|show|rank) (?:all )?(?:countries|regions|geos)",
             f"""WITH latest AS (SELECT MAX(time) as t FROM fact_observations WHERE dataset_code='{self.dataset_code}')
                 SELECT geo, value FROM fact_observations 
                 WHERE dataset_code='{self.dataset_code}' AND time=(SELECT t FROM latest)
                 ORDER BY value DESC LIMIT 20""",
             "Here's the ranking of all regions"),
            
            # Statistical queries
            (r"what is the average",
             f"SELECT AVG(value) as average FROM fact_observations WHERE dataset_code='{self.dataset_code}'",
             "The average value is {{average}}"),
            
            (r"what is the (?:total|sum)",
             f"SELECT SUM(value) as total FROM fact_observations WHERE dataset_code='{self.dataset_code}'",
             "The total is {{total}}"),
            
            # Time-based queries
            (r"(?:what|show) (?:was|were) (?:the )?(?:value|values) in (\d{4})",
             f"SELECT geo, value FROM fact_observations WHERE dataset_code='{self.dataset_code}' AND time LIKE '{{0}}%' ORDER BY value DESC",
             "Values in {{0}}"),
            
            # Change queries
            (r"(?:how much|what) (?:has it |did it )?(?:change|grow|increase|decrease)",
             f"""SELECT 
                     (SELECT value FROM fact_observations WHERE dataset_code='{self.dataset_code}' ORDER BY time DESC LIMIT 1) as latest,
                     (SELECT value FROM fact_observations WHERE dataset_code='{self.dataset_code}' ORDER BY time ASC LIMIT 1) as first
                 """,
             "Changed from {{first}} to {{latest}}"),
        ]
    
    def parse_query(self, question: str) -> QueryResult | None:
        """
        Parse natural language question into SQL
        
        Args:
            question: Natural language question
        
        Returns:
            QueryResult with SQL and template answer
        """
        question_lower = question.lower().strip()
        
        # Try to match patterns
        for pattern, sql_template, answer_template in self.patterns:
            match = re.search(pattern, question_lower)
            if match:
                # Extract any capture groups (e.g., years)
                groups = match.groups()
                
                # Format SQL with captured values
                sql = sql_template
                for i, group in enumerate(groups):
                    sql = sql.replace(f"{{{i}}}", group)
                
                return QueryResult(
                    question=question,
                    sql=sql,
                    answer=answer_template,
                    confidence=0.9
                )
        
        # No match found
        return None
    
    def format_answer(self, query_result: QueryResult, data: Any) -> str:
        """Format the answer with actual data"""
        if not data:
            return "No data found"
        
        answer = query_result.answer
        
        # If data is a single row, substitute values
        if isinstance(data, dict):
            for key, value in data.items():
                answer = answer.replace(f"{{{{{key}}}}}", str(value))
        
        return answer


def ask_question(question: str, dataset_code: str) -> QueryResult | None:
    """
    Main interface: Ask a question in natural language
    
    Args:
        question: Natural language question
        dataset_code: Dataset to query
    
    Returns:
        QueryResult with SQL query and answer template
    """
    engine = NLQueryEngine(dataset_code)
    return engine.parse_query(question)
