from __future__ import annotations
from typing import Literal, Any
from pydantic import BaseModel, Field

TemplateKind = Literal["time_geo_explorer", "time_only_trend", "geo_snapshot", "category_matrix"]
VisualKind = Literal["kpi", "line", "bar", "table"]

class Metric(BaseModel):
    id: str
    label: str
    sql_expr: str

class Visual(BaseModel):
    id: str
    kind: VisualKind
    title: str
    sql: str

class Page(BaseModel):
    id: str
    title: str
    visuals: list[Visual]

class DatasetInfo(BaseModel):
    code: str
    title: str | None = None

class Defaults(BaseModel):
    filters: dict[str, Any] = Field(default_factory=dict)
    time_window_years: int = 6
    geo_level: str | None = "country"

class ReportPlan(BaseModel):
    version: str = "1.0"
    dataset: DatasetInfo
    template: TemplateKind
    dimensions: list[str]
    defaults: Defaults = Field(default_factory=Defaults)
    metrics: list[Metric]
    pages: list[Page]
