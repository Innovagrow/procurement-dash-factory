from __future__ import annotations
from .config import Config
from .planspec import ReportPlan, DatasetInfo, Defaults, Metric, Page, Visual
from .discovery import DatasetStructure

def choose_template(dims: list[str]) -> str:
    has_time = "time" in dims
    has_geo = "geo" in dims
    if has_time and has_geo:
        return "time_geo_explorer"
    if has_time:
        return "time_only_trend"
    if has_geo:
        return "geo_snapshot"
    return "category_matrix"

def default_filters_from_dims(struct: DatasetStructure) -> dict:
    filters: dict = {}
    if "freq" in struct.dims and struct.categories.get("freq"):
        filters["freq"] = "A" if "A" in struct.categories["freq"] else struct.categories["freq"][0]
    # For non-core dims, pick the first category to keep MVP bounded
    for d in struct.dims:
        if d in ("time", "geo", "unit", "freq"):
            continue
        cats = struct.categories.get(d, [])
        if cats:
            filters[d] = cats[0]
    return filters

def build_plan(cfg: Config, dataset_code: str, title: str | None, struct: DatasetStructure) -> ReportPlan:
    template = choose_template(struct.dims)
    defaults = Defaults(
        filters=default_filters_from_dims(struct),
        time_window_years=int(cfg.get("ingestion", "time_window_years", default=6)),
        geo_level=cfg.get("ingestion", "geo_level", default="country"),
    )

    metrics = [
        Metric(id="value", label="Value", sql_expr="value"),
        Metric(id="yoy_pct", label="YoY %", sql_expr="(value / lag(value) over (partition by series_key order by time) - 1) * 100"),
    ]

    pages = []
    if template in ("time_geo_explorer", "time_only_trend"):
        pages += [
            Page(id="overview", title="Overview", visuals=[
                Visual(id="kpi_latest", kind="kpi", title="Latest value",
                       sql=f"SELECT time, value FROM fact_observations WHERE dataset_code='{dataset_code}' ORDER BY time DESC LIMIT 1")
            ]),
            Page(id="trend", title="Trend", visuals=[
                Visual(id="trend_line", kind="line", title="Trend over time",
                       sql=f"SELECT time, geo, value FROM fact_observations WHERE dataset_code='{dataset_code}' ORDER BY time")
            ])
        ]
    if template in ("time_geo_explorer", "geo_snapshot"):
        pages += [
            Page(id="rank_latest", title="Latest ranking", visuals=[
                Visual(id="rank_bar", kind="bar", title="Top geographies (latest)",
                       sql=f"""WITH t AS (SELECT max(time) AS t FROM fact_observations WHERE dataset_code='{dataset_code}')
SELECT geo, value FROM fact_observations WHERE dataset_code='{dataset_code}' AND time=(SELECT t FROM t) ORDER BY value DESC LIMIT 25""")
            ])
        ]
    if template == "category_matrix":
        pages += [
            Page(id="table", title="Summary table", visuals=[
                Visual(id="sample_table", kind="table", title="Sample rows",
                       sql=f"SELECT * FROM fact_observations WHERE dataset_code='{dataset_code}' LIMIT 200")
            ])
        ]

    return ReportPlan(
        dataset=DatasetInfo(code=dataset_code, title=title),
        template=template,  # type: ignore
        dimensions=struct.dims,
        defaults=defaults,
        metrics=metrics,
        pages=pages,
    )
