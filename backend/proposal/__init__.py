"""Proposal builder — framework-free compute ported from the legacy Castillo
Proposal Generator desktop tool (Full_proposal_V9.py, a ~9k-line Tkinter app).

This package holds the pure logic — domain models, schedule/calendar math,
proposal parsing, Gantt rendering, and PDF export — with NO Tkinter and NO
web-framework coupling, so the FastAPI `/api/proposal` router and (later) any
other caller can drive it. The Tkinter `tk.BooleanVar`/widget state from the
original becomes plain dataclass fields here; UI lives in the React frontend.
"""
