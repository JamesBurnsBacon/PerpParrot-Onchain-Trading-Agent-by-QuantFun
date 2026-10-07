"""Compatibility entry point for reproducing the historical Top35 experiment.
Current comparisons should use prepare-committee-comparison.py (Top40 by default).
"""
from pathlib import Path
import subprocess
import sys

if len(sys.argv) != 2:
    raise SystemExit('Usage: prepare-top35-comparison.py work/<experiment>/runtime')
subprocess.run([sys.executable, str(Path(__file__).with_name('prepare-committee-comparison.py')),
                sys.argv[1], '--finalists', '35', '--deadline-ms', '300000'], check=True)
