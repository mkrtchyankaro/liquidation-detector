WALL DATA EXPORT KIT (read-only), 2026-10-16

Files: wall_data_export.py (collector), wallmap.py + zigzag.py (the research wall map; rules unchanged, only the data cut is configurable).

Run on the server, from the project folder (the one with .env and node_modules):
    python3 /path/to/wall_data_kit/wall_data_export.py --project .

Requirements: python3 >= 3.8. Optional: pymongo (otherwise the project's node 'mongodb' driver is used), pandas + numpy (for walls.csv;
otherwise walls are rebuilt later from candles_4h.csv). Network access to fapi.binance.com. No API keys.
Writes only to <project>/reports/wall-data-<UTC stamp>/ and <same>.zip. The DB is only read.
Exit code 0 = no errors; 1 = some data missing (the ZIP is still written; see manifest.json "errors" and coverage_report.csv).
Run it soon: liq_raw_events keeps only 14 days.
