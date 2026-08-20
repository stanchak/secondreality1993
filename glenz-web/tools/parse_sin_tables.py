#!/usr/bin/env python3
"""Parse GLENZ/MATHSIN.INC and GLENZ/SIN1024.INC -> assets/tables.json

Extract all `dw` (or `dd`/`dw` mixed) comma-separated signed integer values in file order
into one flat array per file. Track LABEL lines and the count of values preceding them.
"""
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]  # repository root
MATHSIN = str(ROOT / "GLENZ/MATHSIN.INC")
SIN1024 = str(ROOT / "GLENZ/SIN1024.INC")
OUT = str(ROOT / "glenz-web/assets/tables.json")

DW_RE = re.compile(r'^\s*d[wd]\s+(.*)$', re.IGNORECASE)
DUP_RE = re.compile(r'^\s*([0-9+\-\s]+)\s+dup\s*\(\s*(-?\d+)\s*\)\s*$', re.IGNORECASE)


def parse_file(path):
    """Returns (flat_values, labels) where labels is list of (line_no, line_text, offset_before)."""
    flat = []
    labels = []
    with open(path, "r") as f:
        for line_no, line in enumerate(f, start=1):
            stripped = line.rstrip("\n")
            if "LABEL" in stripped.upper():
                labels.append({
                    "line_no": line_no,
                    "line_text": stripped.strip(),
                    "offset_before": len(flat),
                })
                continue
            m = DW_RE.match(stripped)
            if m:
                rest = m.group(1)
                # strip trailing ';' comments (e.g. "-56;(cosine continued)")
                if ";" in rest:
                    rest = rest.split(";", 1)[0]
                rest = rest.strip()
                # handle assembler "<count-expr> dup(<value>)" fill directive
                dup_m = DUP_RE.match(rest)
                if dup_m:
                    count = eval(dup_m.group(1).replace(" ", ""), {"__builtins__": {}}, {})
                    value = int(dup_m.group(2))
                    flat.extend([value] * count)
                    continue
                # split on commas, allow whitespace
                parts = [p.strip() for p in rest.split(",")]
                for p in parts:
                    if p == "":
                        continue
                    flat.append(int(p))
    return flat, labels


def main():
    mathsin_flat, mathsin_labels = parse_file(MATHSIN)
    sin1024_flat, sin1024_labels = parse_file(SIN1024)

    assert len(sin1024_labels) == 1, f"expected exactly one label in SIN1024.INC, got {sin1024_labels}"
    assert len(sin1024_flat) == 1024, f"expected 1024 values in sin1024, got {len(sin1024_flat)}"
    assert sin1024_flat[0] == 0, f"sin1024[0] expected 0, got {sin1024_flat[0]}"
    assert sin1024_flat[256] == 256, f"sin1024[256] expected 256, got {sin1024_flat[256]}"

    # Build labels map: label name -> offset_before (value-offset into flat array)
    def label_name(line_text):
        # e.g. "sintable16 LABEL WORD" -> "sintable16"
        return line_text.split()[0]

    labels_map = {}
    for lbl in mathsin_labels:
        labels_map[label_name(lbl["line_text"])] = lbl["offset_before"]
    for lbl in sin1024_labels:
        labels_map[label_name(lbl["line_text"])] = lbl["offset_before"]

    data = {
        "mathsin_flat": mathsin_flat,
        "labels": labels_map,
        "sin1024": sin1024_flat,
    }

    with open(OUT, "w") as f:
        json.dump(data, f, separators=(",", ":"))

    # sintable16 offset validation values
    sintable16_offset = labels_map.get("sintable16")
    sample_offsets = [0, 450, 900, 1800, 2700]
    sintable16_samples = {}
    if sintable16_offset is not None:
        for off in sample_offsets:
            idx = sintable16_offset + off
            val = mathsin_flat[idx] if idx < len(mathsin_flat) else None
            sintable16_samples[off] = val

    report = {
        "mathsin_total_dw_count": len(mathsin_flat),
        "mathsin_labels": mathsin_labels,
        "sin1024_total_dw_count": len(sin1024_flat),
        "sin1024_labels": sin1024_labels,
        "labels_map": labels_map,
        "sin1024_validation": {
            "sin1024[0]": sin1024_flat[0],
            "sin1024[256]": sin1024_flat[256],
            "len(sin1024)": len(sin1024_flat),
        },
        "sintable16_samples_relative_offsets": sintable16_samples,
        "tables_json_size_bytes": None,  # filled after write below
    }
    import os
    report["tables_json_size_bytes"] = os.path.getsize(OUT)

    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
